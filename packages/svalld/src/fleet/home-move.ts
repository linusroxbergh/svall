import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { z } from 'zod';
import {
  AdoptAnswer, Enrolment, HomeDelivery, HomeManifest, HomeMoving, MachineId, MachineRecord, migrateState, relabelHome, WorkerFile,
  type FleetState, type HomeMoveId, type HomeWorker,
} from '@svall/protocol';
import { InvalidConfig } from '../config.js';
import { repoRootOf, repoSlug } from '../docs.js';
import { appendDurable, createDurable, syncDir, writeDurable } from '../durable.js';
import { HomeCrash as Crash, homePoint } from '../failpoints.js';
import { sha256Hex } from '../hash.js';
import { daemonLock, homeMoveLock } from '../kernel-lock.js';
import { silentLogger } from '../log.js';
import { putRecord, readRegistry, type MachineEntry } from '../machine.js';
import { filesIn, HomeDocs } from '../placement/docs-sync.js';
import { packTar, ustarFits } from '../placement/bundle.js';
import { carriedConsent } from '../placement/mirror-consent.js';
import { keysOnly, readState } from '../placement/mirror-state.js';
import { homeRootOf } from '../placement/repo-key.js';
import { relocate } from '../placement/relocate.js';
import { tokenFor, workerIds, workerProfile } from '../placement/workers.js';
import { expandHome, resolvePaths, type Paths } from '../paths.js';
import { clean } from '../path-tools.js';
import { fleetHomes } from '../uninstall.js';
import { withOwned } from '../worker/snapshot.js';

const exec = promisify(execFile);

/** What the fleet carries to its new home: never node.json, the token, .env, tmux, the hooks, the cache or the outbox. */
const CARRIED = ['fleet.json', 'state.json', 'docs', 'agent-profiles', 'push.json', 'vapid.json', 'mobile-pass', 'mobile-key', 'mirror-consent.json', 'retro', 'journal/moves'] as const;
/** What a worker's fleet home holds that no home does; each goes aside with the files it replaces, and comes back with them. The mirror's record names what a push wrote, which a Copy must not read as its own, past the keys it copied. */
const WORKER_ONLY = ['worker.json', 'phone.json', 'phone-fallbacks.json', 'journal/epoch', 'cache/mirror-state.json'] as const;
const INSTALLED = [...CARRIED, 'workers.json', 'workers-owed.json'] as const;
const MANIFEST = 'home-move.json';
/** What a way back's export may answer over ssh: the archive in base64, in JSON. */
export const MAX_ARCHIVE = 256 * 1024 * 1024;
/** What a move carries, either way, so a fleet that goes out can come back: base64 takes a third more, and the rest is room for what its robots write meanwhile. */
export const MAX_CARRIED_KB = Math.floor((MAX_ARCHIVE * 0.7) / 1024);
const TAR_BLOCK = 512;
// how long a stopped daemon has to let go of its lock
const STOP_MS = 60_000;

/** A destination's phases: `stopping` while its daemon is down with its files as they were; `installing` while its files are changing, which only a recovery ends; `installed` until its daemon answers as the home. `released`: the old home's own, that the machine holding the fleet ended its marker. */
const AdoptPhase = z.enum(['staging', 'staged', 'stopping', 'installing', 'installed', 'rolledback', 'adopted', 'aborted', 'released', 'done']);
type AdoptPhase = z.infer<typeof AdoptPhase>;
const Record_ = z.object({ phase: z.string(), at: z.number(), detail: z.string().optional() });

export const adoptDir = (p: Pick<Paths, 'home'>, id: string): string => path.join(p.home, `adopt-${id}`);
const journalOf = (p: Pick<Paths, 'homeMoves'>, id: string): string => path.join(p.homeMoves, `${id}.ndjson`);

/** The journal of a move as this machine holds it, a line a crash cut short left out. One that cannot be read throws, naming it: it may say anything. */
export function journalLines(p: Pick<Paths, 'homeMoves'>, id: string): z.infer<typeof Record_>[] {
  let text: string;
  try { text = fs.readFileSync(journalOf(p, id), 'utf8'); } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw new InvalidConfig(`${journalOf(p, id)} cannot be read: ${(e as Error).message}`, { cause: e });
  }
  return text.split('\n').flatMap((line) => {
    try { return [Record_.parse(JSON.parse(line))]; } catch { return []; }
  });
}

// beside the phases, in the same journal: what the commit owes the phone, and that it was tried
const SERVE = 'serve';
const SERVED = 'served';

const lastPhase = (p: Pick<Paths, 'homeMoves'>, id: string): AdoptPhase | undefined => {
  const phase = journalLines(p, id).filter((r) => r.phase !== SERVED).at(-1)?.phase;
  return phase === undefined ? undefined : AdoptPhase.safeParse(phase).data;
};

export function enter(p: Pick<Paths, 'homeMoves'>, id: string, phase: string, detail?: string): void {
  appendDurable(journalOf(p, id), { phase, at: Date.now(), ...(detail && { detail }) });
}

export type HomeDaemon = {
  /** Stops the fleet's daemon, tmux left running; resolves whether or not it had been running. */
  stop(): Promise<void>;
  /** Starts it on what the fleet home now holds, its unit written again to match. */
  start(): Promise<void>;
  /** Whether a running daemon's own API answers as this fleet's home. */
  answersHome(fleetId: string): Promise<boolean>;
};

export type AdoptDeps = { paths: Paths; me: MachineId; daemon: HomeDaemon; registryDir?: string };


export const readManifest = (p: Paths, id: string): HomeManifest => HomeManifest.parse(JSON.parse(fs.readFileSync(path.join(adoptDir(p, id), 'incoming', MANIFEST), 'utf8')));

const notAdopted = (detail?: string): AdoptAnswer => ({ status: 'not-adopted', ...(detail && { detail }) });
const pending = (phase: string, detail?: string): AdoptAnswer => ({ status: 'pending', phase, ...(detail && { detail }) });

// one at a time for a fleet home: what finds another under way answers `pending`, and nothing thaws on that
async function serialized(p: Paths, what: () => Promise<AdoptAnswer>): Promise<AdoptAnswer> {
  const unlock = await homeMoveLock(p.home);
  if (!unlock) return pending('running', 'another step of this move runs there');
  try { return await what(); } finally { unlock(); }
}

async function waitForDaemonLock(p: Paths): Promise<() => void> {
  for (const until = Date.now() + STOP_MS; Date.now() < until; await new Promise((r) => setTimeout(r, 100))) {
    const unlock = await daemonLock(p.home);
    if (unlock) return unlock;
  }
  throw new Error(`the daemon of ${p.home} did not stop in ${STOP_MS / 1000} s`);
}

const HELD_RECORD = 'held-record.json';
// what the registry here said of the old home before the move wrote its record
const heldRecordOf = (p: Paths, id: string): MachineRecord | undefined => {
  try { return MachineRecord.safeParse((read(path.join(adoptDir(p, id), HELD_RECORD)) as { heldRecord?: unknown }).heldRecord).data; } catch { return undefined; }
};

const addedWorkersOf = (p: Paths, id: string): MachineId[] => {
  try { return z.array(MachineId).parse((read(path.join(adoptDir(p, id), HELD_RECORD)) as { added?: unknown }).added ?? []); } catch { return []; }
};

const enrolFile = (p: Paths, id: string): string => path.join(adoptDir(p, id), 'enrol.json');

function adopted(p: Paths, id: string): AdoptAnswer {
  return { status: 'adopted', enrol: Enrolment.parse(JSON.parse(fs.readFileSync(enrolFile(p, id), 'utf8'))) };
}

/** The commit, however it was reached: recovery goes forward from here, and the home's daemon owes the phone what the old home served. */
function commit(p: Paths, id: HomeMoveId, m: HomeManifest): AdoptAnswer {
  enter(p, id, 'adopted', m.phone.serving ? SERVE : undefined);
  homePoint('adopt.committed');
  return adopted(p, id);
}

/** The moves this home took from one whose phone link served, and whose own it has yet to try. */
export function phoneOwed(p: Pick<Paths, 'homeMoves'>): string[] {
  return moveIds(p).filter((id) => {
    const lines = journalLines(p, id);
    return lines.some((l) => l.phase === 'adopted' && l.detail === SERVE) && !lines.some((l) => l.phase === SERVED);
  });
}

export const servedPhone = (p: Pick<Paths, 'homeMoves'>, id: string, why?: string): void => enter(p, id, SERVED, why);

// by the newest try of any move: what its failure said stands until a later try, or a person's own switch, says otherwise
const phoneTries = (p: Pick<Paths, 'homeMoves'>): { id: string; at: number; detail?: string }[] => moveIds(p).flatMap((id) => {
  // what a journal that cannot be read tried says nothing to a person's switch
  try { return journalLines(p, id).filter((l) => l.phase === SERVED).map((l) => ({ id, at: l.at, ...(l.detail && { detail: l.detail }) })); } catch { return []; }
}).sort((a, b) => a.at - b.at);

/** Why the phone link did not come on when a move last tried it, for Settings → Phone to say. */
export const phoneReason = (p: Pick<Paths, 'homeMoves'>): string | undefined => phoneTries(p).at(-1)?.detail;

/** A person's own switch: what a move's try said no longer stands. */
export function forgetPhoneReason(p: Pick<Paths, 'homeMoves'>): void {
  const last = phoneTries(p).at(-1);
  if (last?.detail) servedPhone(p, last.id);
}

// the record is the account's, so a machine another fleet here reaches over ssh would lose that route to one that dials in
function refuseShared(d: AdoptDeps, m: HomeManifest): void {
  if (m.record.ssh) return;
  const route = readRegistry(d.registryDir).find((r) => r.id === m.from)?.record.ssh;
  if (!route) return;
  const sharing = fleetHomes(os.homedir()).find((h) => h !== d.paths.home && tokenFor(resolvePaths(h), m.from));
  if (sharing) throw new Error(`the fleet in ${sharing} reaches ${m.record.name} over ssh at ${route}, which this would end; svall host remove ${m.record.name} --forget drops that route for every fleet here and leaves the machine as it is`);
}

/**
 * Takes the fleet's archive into a staged folder, once its sha256 has checked out, and changes nothing of the fleet home. A
 * move this machine has refused stays refused.
 */
export function stageAdopt(d: AdoptDeps, id: HomeMoveId, sha256: string, archive: Buffer): Promise<AdoptAnswer> {
  const p = d.paths;
  fs.mkdirSync(p.home, { recursive: true });
  return serialized(p, async () => {
    refuseLeaving(p, id);
    const at = lastPhase(p, id);
    if (at === 'aborted') return notAdopted('this move was called off here');
    if (at === 'done') return { status: 'done' };
    if (at === 'adopted') return adopted(p, id);
    if (at === 'stopping' || at === 'installing' || at === 'installed' || at === 'staged' || at === 'rolledback') return pending(at);
    const busy = refuseOlder(p, id);
    if (busy) return pending('busy', `move ${busy} is not over here`);
    enter(p, id, 'staging');
    homePoint('adopt.staging');
    const dir = adoptDir(p, id);
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    if (crypto.createHash('sha256').update(archive).digest('hex') !== sha256) throw new Error('the archive does not match the sha256 it came with');
    const file = path.join(dir, 'in.tar');
    writeDurable(file, archive, { mode: 0o600 });
    const listed = (await exec('tar', ['-t', '-f', file], { maxBuffer: 64 * 1024 * 1024 })).stdout.split('\n').filter(Boolean);
    const bad = listed.find((n) => path.posix.isAbsolute(n) || n.split('/').includes('..') || ![...CARRIED, MANIFEST].some((c) => n.replace(/^\.\//, '') === c || n.replace(/^\.\//, '').startsWith(`${c}/`)));
    if (bad) throw new Error(`the archive holds ${bad}, which no fleet carries`);
    const incoming = path.join(dir, 'unpacked');
    fs.mkdirSync(incoming, { mode: 0o700 });
    await exec('tar', ['-x', '-f', file, '-C', incoming]);
    const manifest = HomeManifest.parse(JSON.parse(fs.readFileSync(path.join(incoming, MANIFEST), 'utf8')));
    if (manifest.id !== id) throw new Error(`the archive is of move ${manifest.id}, not ${id}`);
    if (manifest.to !== d.me) throw new Error(`the archive is for machine ${manifest.to}, not this one`);
    if (fs.existsSync(p.workerFile) && (read(p.workerFile) as { fleetId?: string }).fleetId !== manifest.fleetId) throw new Error(`this machine is a worker of another fleet, not of ${manifest.fleetId}`);
    refuseShared(d, manifest);
    fs.renameSync(incoming, path.join(dir, 'incoming'));
    enter(p, id, 'staged');
    homePoint('adopt.staged');
    return pending('staged');
  });
}

const STALE = new Set<AdoptPhase>(['staging', 'staged', 'stopping', 'rolledback']);
const moveIds = (p: Pick<Paths, 'homeMoves'>): string[] => (fs.existsSync(p.homeMoves) ? fs.readdirSync(p.homeMoves) : []).filter((n) => !n.endsWith('.driver.ndjson')).map((n) => n.replace(/\.ndjson$/, ''));

// a home asks for one move at a time, so an archive of an earlier one was given up with its driver and holds keys for nothing: it is refused
// for good. One that has begun to install is not over, and stops this one
function refuseOlder(p: Paths, id: string): string | undefined {
  for (const other of moveIds(p).filter((m) => m !== id)) {
    const at = lastPhase(p, other);
    if (at === 'installing' || at === 'installed') return other;
    if (at === undefined || !STALE.has(at)) continue;
    endMove(p, other, { by: 'refused', detail: 'a later move came' });
    fs.rmSync(adoptDir(p, other), { recursive: true, force: true });
  }
  return undefined;
}

// the outbox entries of this worker its home has not taken: they would be lost with the outbox unless they are of what a move carries
function untaken(p: Paths, state: FleetState, me: MachineId): string[] {
  let text: string;
  try { text = fs.readFileSync(p.outbox, 'utf8'); } catch { return []; }
  const entries = text.split('\n').flatMap((line) => {
    try { return [JSON.parse(line) as { seq: number; kind: string; data?: { method?: string } }]; } catch { return []; }
  });
  const read = (file: string): string => { try { return fs.readFileSync(file, 'utf8').trim(); } catch { return ''; } };
  const replayed = state.machines?.[me]?.replayed;
  const acked = Math.max(Number(read(p.acked)) || 0, replayed?.epoch === read(p.epoch) ? replayed.seq : 0);
  return entries.filter((e) => e.seq > acked && e.kind === 'mutation' && e.data?.method !== 'robot.create').map((e) => e.data?.method ?? e.kind);
}

// a repo's notes hang off a hash of its path on the home, so each known root takes the name its path has on the new one: the
// folder's name on the old home to its name on the new, by the state as the old home holds it
function repoRenames(state: FleetState, from: string, to: string): Map<string, string> {
  const renames = new Map<string, string>();
  if (from === to) return renames;
  for (const r of Object.values(state.robots)) {
    const root = homeRootOf(r, state.machines, from) ?? repoRootOf(r);
    if (!root) continue;
    const [was, now] = [repoSlug(root), repoSlug(relocate(root, { from, to }))];
    if (was !== now) renames.set(was, now);
  }
  return renames;
}

function renameRepoDocs(docs: string, renames: Map<string, string>): void {
  const repos = path.join(docs, 'repos');
  for (const [was, now] of renames) {
    if (fs.existsSync(path.join(repos, was)) && !fs.existsSync(path.join(repos, now))) fs.renameSync(path.join(repos, was), path.join(repos, now));
  }
}

// the files under `dir` by their paths relative to it, none through a link, which filesIn's recursive read follows
const ownFiles = (dir: string, under = ''): string[] => {
  let found: fs.Dirent[];
  try { found = fs.readdirSync(path.join(dir, under), { withFileTypes: true }); } catch { return []; }
  return found.flatMap((e) => (e.isDirectory() ? ownFiles(dir, path.join(under, e.name)) : e.isFile() ? [path.join(under, e.name)] : []));
};

// each doc this worker changed or removed that its home has not sent back, taken as the home takes a worker's change: over a copy
// that is what the worker last had, and beside one the home changed too
function carryOwnDocs(d: AdoptDeps, docs: string, state: FleetState): void {
  const dir = path.join(d.paths.cache, 'docs');
  let synced: Record<string, string> = {};
  try { synced = JSON.parse(fs.readFileSync(d.paths.docsSynced, 'utf8')) as Record<string, string>; } catch { /* none taken yet */ }
  const home = new HomeDocs(docs, silentLogger, () => state.machines?.[d.me]?.name ?? d.me, (id) => state.robots[id] !== undefined);
  const here = new Set(ownFiles(dir));
  for (const rel of here) {
    const bytes = fs.readFileSync(path.join(dir, rel));
    const sha256 = sha256Hex(bytes);
    if (synced[rel] !== sha256) home.apply('docs.write', { path: rel, data: bytes.toString('base64'), sha256, ...(synced[rel] && { base: synced[rel] }) }, d.me);
  }
  for (const [rel, base] of Object.entries(synced)) if (!here.has(rel)) home.apply('docs.delete', { path: rel, base }, d.me);
}

const read = (file: string): unknown => JSON.parse(fs.readFileSync(file, 'utf8'));

type CarriedConfig = { defaultCwd?: string; home?: { cwd?: string }; onboarding?: { firstProject?: string }; mobile?: { logins?: string[] } };

// a path under the old home reads as the same place under the new one, but mission control's folder that is the old fleet's own
// becomes this fleet's own, in `fleetHome`; the phone's authorization stays what it was, as empty logins mean a login only the old home had
function carriedConfig(c: CarriedConfig, m: HomeManifest, fleetHome: string): CarriedConfig {
  const under = (p: string, home: string): string => (p === home ? '~' : p.startsWith(`${home}/`) ? `~${p.slice(home.length)}` : p);
  const local = (p: string | undefined): string | undefined => (p === undefined ? p : under(p, m.record.home));
  const own = (p: string): boolean => !!m.fromFleetHome && clean(expandHome(p, m.record.home)) === clean(path.posix.join(m.fromFleetHome, 'home'));
  return {
    ...c,
    ...(c.defaultCwd && { defaultCwd: local(c.defaultCwd) }),
    ...(c.home?.cwd && { home: { ...c.home, cwd: own(c.home.cwd) ? under(path.posix.join(fleetHome, 'home'), m.toHome) : local(c.home.cwd) } }),
    ...(c.onboarding?.firstProject && { onboarding: { ...c.onboarding, firstProject: local(c.onboarding.firstProject) } }),
    ...(!c.mobile?.logins?.length && m.phone.logins.length && { mobile: { ...c.mobile, logins: m.phone.logins } }),
  };
}

/** The files as they go in, built afresh from the archive each time, as the relabel cannot run on what it wrote. */
function buildReady(d: AdoptDeps, id: HomeMoveId, m: HomeManifest, token: string): string {
  const p = d.paths;
  const dir = adoptDir(p, id);
  const [incoming, ready] = [path.join(dir, 'incoming'), path.join(dir, 'ready')];
  fs.rmSync(ready, { recursive: true, force: true });
  fs.cpSync(incoming, ready, { recursive: true, verbatimSymlinks: true });
  fs.rmSync(path.join(ready, MANIFEST), { force: true });
  const at = Date.now();
  const state = relabelHome(migrateState(read(path.join(incoming, 'state.json'))).state, { from: m.from, fromName: m.record.name, fromHome: m.record.home, to: m.to, toName: m.toName, toHome: m.toHome, at });
  // this machine's robots as it last knew them: their running fields are its own, and one started since the archive's cut is in no copy but this
  let held: FleetState | undefined;
  try { held = migrateState(read(p.state)).state; } catch { /* a worker that never took a snapshot holds none */ }
  const bad = held && untaken(p, held, d.me);
  if (bad?.length) throw new Error(`a change made here while the link was down (${bad.join(', ')}) has not reached the fleet; call this move off, and it goes home`);
  for (const r of Object.values(held?.robots ?? {})) {
    if (r.machine !== d.me) continue;
    const ours = state.robots[r.id];
    state.robots[r.id] = ours ? withOwned(ours, r) : (() => { const { machine: _m, ...rest } = r; return rest as typeof r; })();
  }
  // none of them has heard yet, and the home says so until each links
  const others = (m.workers ?? []).filter((w) => state.machines?.[w.id]);
  for (const w of others) state.machines![w.id] = { ...state.machines![w.id], reachable: false, since: at };
  writeDurable(path.join(ready, 'state.json'), state, { mode: 0o600 });
  carryOwnDocs(d, path.join(ready, 'docs'), state);
  renameRepoDocs(path.join(ready, 'docs'), repoRenames(relabelHome(state, { from: m.to, fromName: m.toName, fromHome: m.toHome, to: m.from, toName: m.record.name, at }), m.record.home, m.toHome));
  writeDurable(path.join(ready, 'fleet.json'), carriedConfig(read(path.join(ready, 'fleet.json')) as CarriedConfig, m, p.home), { mode: 0o600 });
  const fresh = Object.fromEntries((m.workers ?? []).map((w) => [w.id, { token: crypto.randomBytes(24).toString('hex'), addedAt: at, ...(w.profile && { profile: w.profile }) }]));
  writeDurable(path.join(ready, 'workers.json'), { ...fresh, [m.from]: { token, addedAt: at, ...(m.fromProfile && { profile: m.fromProfile }) } }, { mode: 0o600 });
  if (m.workers?.length) writeDurable(path.join(ready, 'workers-owed.json'), { id, workers: Object.fromEntries(m.workers.map((w) => [w.id, {}])) }, { mode: 0o600 });
  carriedConsent(path.join(ready, 'mirror-consent.json'), p.mirrorConsent, d.me, m.from);
  return ready;
}

const NO_HOME = "its daemon did not answer as this fleet's home";
const CUT_SHORT = 'the install was cut short';

const inHome = (p: Paths, name: string): string => path.join(p.home, name);

const isLink = (file: string): boolean => { try { return fs.lstatSync(file).isSymbolicLink(); } catch { return false; } };
const present = (file: string): boolean => fs.existsSync(file) || isLink(file);
// beside what went aside: this machine held none of the file named, so what stands there goes back to nothing
const heldNone = (original: string, name: string): string => path.join(original, `${name}.none`);

function syncFolders(p: Paths, dir: string): void {
  for (const folder of [p.home, path.join(p.home, 'journal'), dir, path.join(dir, 'original'), path.join(dir, 'original', 'journal')]) if (fs.existsSync(folder)) syncDir(folder);
}

// each file goes aside, then the new one takes its place, so a recovery can tell for each what was done, a run of its own included
function installFiles(p: Paths, id: HomeMoveId): void {
  const dir = adoptDir(p, id);
  const [ready, original] = [path.join(dir, 'ready'), path.join(dir, 'original')];
  for (const under of ['journal', 'cache']) fs.mkdirSync(path.join(original, under), { recursive: true, mode: 0o700 });
  fs.mkdirSync(path.join(p.home, 'journal'), { recursive: true });
  for (const name of INSTALLED) {
    const [from, at] = [path.join(ready, name), inHome(p, name)];
    if (present(at)) fs.renameSync(at, path.join(original, name));
    else fs.writeFileSync(heldNone(original, name), '');
    homePoint('adopt.file');
    if (fs.existsSync(from)) fs.renameSync(from, at);
  }
  for (const name of WORKER_ONLY) if (present(inHome(p, name))) fs.renameSync(inHome(p, name), path.join(original, name));
  const copied = keysOnly(readState(path.join(original, 'cache/mirror-state.json')));
  if (Object.keys(copied.secrets).length) writeDurable(p.mirrorState, copied, { mode: 0o600 });
  homePoint('adopt.dropped');
  syncFolders(p, dir);
}

/** Everything back as it was before the install began, whichever of its steps a crash cut it or this at; what a failed home wrote goes with it. */
function restoreOriginal(p: Paths, id: string): void {
  const dir = adoptDir(p, id);
  const [original, thrown] = [path.join(dir, 'original'), path.join(dir, `thrown-${Date.now()}`)];
  for (const under of ['journal', 'cache']) fs.mkdirSync(path.join(thrown, under), { recursive: true, mode: 0o700 });
  // what says whom the folder serves goes back first, so a cut anywhere leaves it answering as the fleet it serves
  for (const name of [...WORKER_ONLY, ...INSTALLED]) {
    const [kept, none, at] = [path.join(original, name), heldNone(original, name), inHome(p, name)];
    // neither: this name was not reached, or is back already
    if (!present(kept) && !fs.existsSync(none)) continue;
    if (present(at)) fs.renameSync(at, path.join(thrown, name));
    homePoint('restore.file');
    if (present(kept)) fs.renameSync(kept, at);
    fs.rmSync(none, { force: true });
  }
  syncFolders(p, dir);
  fs.rmSync(path.join(dir, 'ready'), { recursive: true, force: true });
  fs.rmSync(thrown, { recursive: true, force: true });
  homePoint('restore.done');
}

/** Restores the fleet home and hands the daemon back as it was: a move that did not take leaves a worker of the old home. */
async function rollback(d: AdoptDeps, id: HomeMoveId, m: HomeManifest, why?: string): Promise<AdoptAnswer> {
  const p = d.paths;
  await d.daemon.stop().catch(() => undefined);
  const unlock = await waitForDaemonLock(p);
  try {
    // from the first file back a home is no longer there to answer for what stands, so what a crash leaves goes back too
    enter(p, id, 'installing', 'rolling back');
    restoreOriginal(p, id);
    restoreRecord(d, id, m);
    enter(p, id, 'stopping', why);
  } finally { unlock(); }
  return startAgain(d, id, why);
}

// `stopping` until the daemon is back, so a crash or a start that fails leaves a status, an abort or a retry to start it
async function startAgain(d: AdoptDeps, id: HomeMoveId, why?: string): Promise<AdoptAnswer> {
  homePoint('restore.restarting');
  try { await d.daemon.start(); } catch (e) {
    if (e instanceof Crash) throw e;
    return pending('stopping', `${why ? `${why}; ` : ''}its daemon did not start again: ${(e as Error).message}`);
  }
  enter(d.paths, id, 'rolledback', why);
  return pending('rolledback', why);
}

// a registry that cannot be written stops no worker's start, which does not go by it: what it held stays for the install that comes next
function restoreRecord(d: Pick<AdoptDeps, 'paths' | 'registryDir'>, id: HomeMoveId, m: HomeManifest): void {
  const file = path.join(adoptDir(d.paths, id), HELD_RECORD);
  if (!fs.existsSync(file)) return;
  try {
    putRecord(m.from, heldRecordOf(d.paths, id), d.registryDir);
    for (const w of addedWorkersOf(d.paths, id)) putRecord(w, undefined, d.registryDir);
  } catch { return; }
  fs.rmSync(file, { force: true });
}

/**
 * The move's commit on the machine that takes the fleet: stop, install, start, and adopted only once the running daemon's own
 * API has answered as the home. Runs from the staged input as often as it takes, and only with the key of the move's driver.
 */
export function installAdopt(d: AdoptDeps, id: HomeMoveId, key: string | undefined, enrolment: (token: string, m: HomeManifest) => Enrolment): Promise<AdoptAnswer> {
  const p = d.paths;
  return serialized(p, async () => {
    refuseLeaving(p, id);
    const was = lastPhase(p, id);
    if (was === 'aborted') return notAdopted('this move was called off here');
    if (was === 'done') return { status: 'done' };
    if (was === undefined || was === 'staging') return pending('staging', 'this move has no archive here yet');
    const manifest = readManifest(p, id);
    if (!hashFits(manifest.adoptKeySha256, key)) throw new Error(`only the driver of ${id} installs it, once the old home is marked, with a key it alone holds; svall fleet home retry finishes the move on the machine that started it`);
    if (was === 'installing') await recoverInstall(d, id);
    const at = lastPhase(p, id);
    if (at === 'adopted') return adopted(p, id);
    if (at !== 'installed') {
      enter(p, id, 'stopping');
      await d.daemon.stop();
      homePoint('adopt.stopped');
      const unlock = await waitForDaemonLock(p).catch((e: Error) => e);
      if (unlock instanceof Error) return startAgain(d, id, unlock.message);
      try {
        // the token one try issued holds for the next
        const token = fs.existsSync(enrolFile(p, id)) ? WorkerFile.parse((read(enrolFile(p, id)) as Enrolment).worker).token : crypto.randomBytes(24).toString('hex');
        writeDurable(enrolFile(p, id), enrolment(token, manifest), { mode: 0o600 });
        buildReady(d, id, manifest, token);
        enter(p, id, 'installing');
        homePoint('adopt.installing');
        installFiles(p, id);
        const file = path.join(adoptDir(p, id), HELD_RECORD);
        if (!fs.existsSync(file)) {
          const listed = readRegistry(d.registryDir);
          // a route this machine holds already is the one it reaches that worker by
          const added = (manifest.workers ?? []).filter((w) => !listed.some((e) => e.id === w.id)).map((w) => w.id);
          writeDurable(file, { heldRecord: listed.find((m) => m.id === manifest.from)?.record ?? null, added }, { mode: 0o600 });
        }
        const added = addedWorkersOf(p, id);
        putRecord(manifest.from, manifest.record, d.registryDir);
        for (const w of manifest.workers ?? []) if (added.includes(w.id)) putRecord(w.id, w.record, d.registryDir);
        homePoint('adopt.registry');
        enter(p, id, 'installed');
        homePoint('adopt.installed');
      } catch (e) {
        if (e instanceof Crash) throw e;
        if (lastPhase(p, id) === 'installing') {
          restoreOriginal(p, id);
          restoreRecord(d, id, manifest);
        }
        enter(p, id, 'stopping', (e as Error).message);
        unlock();
        return await startAgain(d, id, (e as Error).message);
      } finally { unlock(); }
    }
    let why = NO_HOME;
    // a start that rejects may have restarted it: only its answer says, as a home that took writes must not be rolled back
    await d.daemon.start().catch((e: Error) => {
      if (e instanceof Crash) throw e;
      why = e.message;
    });
    homePoint('adopt.started');
    if (!await d.daemon.answersHome(manifest.fleetId).catch(() => false)) return rollback(d, id, manifest, why);
    return commit(p, id, manifest);
  });
}

// whether a daemon answers as the home, started first if none does: one that answers may have taken writes
async function homeAnswers(d: AdoptDeps, m: HomeManifest): Promise<boolean> {
  if (await d.daemon.answersHome(m.fleetId).catch(() => false)) return true;
  await d.daemon.start().catch(() => undefined);
  return d.daemon.answersHome(m.fleetId).catch(() => false);
}

// the daemon that would start on half-installed files is held off by this lock, and a daemon that starts first has done this already
async function recoverInstall(d: AdoptDeps, id: HomeMoveId): Promise<void> {
  const unlock = await waitForDaemonLock(d.paths);
  try {
    if (lastPhase(d.paths, id) === 'installing') {
      restoreOriginal(d.paths, id);
      restoreRecord(d, id, readManifest(d.paths, id));
      enter(d.paths, id, 'stopping', CUT_SHORT);
    }
  } finally { unlock(); }
}

// a machine a move leaves hears how it ended from where the fleet went, and what it says of the move itself would read as that
function refuseLeaving(p: Paths, id: HomeMoveId): void {
  if (readMarker(p)?.id === id) throw new Error(`this home is what move ${id} leaves, so it cannot say how that ended; svall fleet home abort calls it off, once the machine holding the fleet says it was not taken`);
}

/** The workers a move would carry from this home: those it reaches over ssh on Linux, as nothing can log in to any other; undefined where it cannot read which it holds. */
export function carriedWorkers(p: Paths, entries: MachineEntry[], own: string): HomeWorker[] | undefined {
  let held: string[];
  try { held = workerIds(p); } catch { return undefined; }
  return entries.filter((e) => held.includes(e.id) && e.record.ssh && e.record.platform === 'linux').map((e) => ({ id: e.id, record: e.record, profile: workerProfile(p, e.id) ?? own }));
}

// `tried`: when the last try for that worker ended, by this home's clock
const WorkersOwed = z.object({ id: z.string(), workers: z.record(z.string(), z.object({ why: z.string().optional(), tried: z.number().optional() })) });
export type WorkersOwed = z.infer<typeof WorkersOwed>;

export const readWorkersOwed = (p: Pick<Paths, 'workersOwed'>): WorkersOwed | undefined => {
  try { return WorkersOwed.parse(JSON.parse(fs.readFileSync(p.workersOwed, 'utf8'))); } catch { return undefined; }
};

/** The workers this home owes an enrolment, and why the last try failed: none until the move stands, as a home that has started can still roll back. */
export function owedWorkers(p: Paths): WorkersOwed['workers'] {
  const owed = readWorkersOwed(p);
  if (!owed) return {};
  // a journal that cannot be read may say anything, and nothing touches a worker on that
  let at: AdoptPhase | undefined;
  try { at = lastPhase(p, owed.id); } catch { return {}; }
  return at === 'adopted' || at === 'done' ? owed.workers : {};
}

/** The old home that asks how a move ended, and the fleet it asks of. */
export type Asker = { machine: MachineId; fleetId: string };

const NOT_SERVED = 'this folder does not serve the home that asks as a worker of its fleet';
const servesAsker = (p: Paths, asker: Asker | undefined): boolean => {
  if (!asker) return false;
  try {
    const w = WorkerFile.parse(read(p.workerFile));
    return w.homeMachineId === asker.machine && w.fleetId === asker.fleetId;
  } catch { return false; }
};

// a marker stands only after a machine answered `staged`, so a `not-adopted` takes proof: this folder holds the fleet and still serves the asker
function unproven(p: Paths, id: string, asker: Asker | undefined): AdoptAnswer | undefined {
  const at = lastPhase(p, id);
  if (at !== undefined && at !== 'aborted' && at !== 'released') return undefined;
  if (at === undefined && present(adoptDir(p, id))) return pending('unknown', 'this folder holds what the move staged, and no journal of it');
  return servesAsker(p, asker) ? undefined : pending('unknown', NOT_SERVED);
}

// a status or an abort. An answer with no proof comes ahead of the lock, as it leaves nothing here, the lock's file included
async function answering(p: Paths, id: HomeMoveId, asker: Asker | undefined, what: () => Promise<AdoptAnswer>): Promise<AdoptAnswer> {
  const refused = (): AdoptAnswer | undefined => {
    refuseLeaving(p, id);
    return unproven(p, id, asker);
  };
  return refused() ?? serialized(p, () => { const held = refused(); return held ? Promise.resolve(held) : what(); });
}

/**
 * What the machine taking the fleet says of move `id`, to `asker`. An id it has never heard of it refuses for good before it says
 * so, so a delayed adopt cannot come after; anything staged or running, or no proof, answers `pending`.
 */
export function adoptStatus(d: AdoptDeps, id: HomeMoveId, asker?: Asker): Promise<AdoptAnswer> {
  const p = d.paths;
  return answering(p, id, asker, async () => {
    const at = lastPhase(p, id);
    if (at === undefined) {
      endMove(p, id, { by: 'refused', detail: 'asked before any archive came' });
      homePoint('abort.recorded');
      return notAdopted();
    }
    if (at === 'aborted' || at === 'released') {
      fs.rmSync(adoptDir(p, id), { recursive: true, force: true });
      return notAdopted();
    }
    if (at === 'done') return { status: 'done' };
    if (at === 'adopted') return adopted(p, id);
    if (at === 'installing') await recoverInstall(d, id);
    if (at === 'stopping' || at === 'installing') return startAgain(d, id, at === 'stopping' ? 'the adopt was cut short' : CUT_SHORT);
    if (at === 'installed') {
      const manifest = readManifest(p, id);
      if (await homeAnswers(d, manifest)) return commit(p, id, manifest);
      return rollback(d, id, manifest, NO_HOME);
    }
    return pending(at);
  });
}

/** Calls move `id` off for `asker`, for good, unless it has already gone through; only what comes back `not-adopted` lets the old home thaw. */
export function abortAdopt(d: AdoptDeps, id: HomeMoveId, asker?: Asker): Promise<AdoptAnswer> {
  const p = d.paths;
  return answering(p, id, asker, async () => {
    const at = lastPhase(p, id);
    if (at === 'done') return { status: 'done' };
    if (at === 'adopted') return adopted(p, id);
    // a home that answers may have taken writes a rollback would lose, so the move goes forward
    if (at === 'installed' && await homeAnswers(d, readManifest(p, id))) return commit(p, id, readManifest(p, id));
    const back = at === 'installing' || at === 'installed' ? await rollback(d, id, readManifest(p, id)) : at === 'stopping' ? await startAgain(d, id) : undefined;
    // the daemon comes back before the record, as nothing starts it past that: a crash between leaves a status to start it, and a start that fails is answered
    if (back?.status === 'pending' && back.phase === 'stopping') return back;
    // a rollback has put worker.json back, so only now does this folder say whom it serves
    if (asker && !servesAsker(p, asker)) return pending('unknown', NOT_SERVED);
    if (at !== 'aborted' && at !== 'released') {
      endMove(p, id, { by: 'refused' });
      homePoint('abort.recorded');
    }
    fs.rmSync(adoptDir(p, id), { recursive: true, force: true });
    return notAdopted();
  });
}

/** The move has landed on both sides: what was staged here goes, keys and all. */
export function confirmAdopt(d: Pick<AdoptDeps, 'paths'>, id: HomeMoveId): Promise<AdoptAnswer> {
  const p = d.paths;
  return serialized(p, () => {
    const at = lastPhase(p, id);
    if (at !== 'adopted' && at !== 'done') return Promise.resolve(pending(at ?? 'unknown'));
    if (at === 'adopted') enter(p, id, 'done');
    fs.rmSync(adoptDir(p, id), { recursive: true, force: true });
    return Promise.resolve({ status: 'done' });
  });
}

/** The old home has linked with the token its move issued, so it landed: what its move staged here goes, keys and all. */
export async function landed(d: Pick<AdoptDeps, 'paths'>, from: MachineId): Promise<void> {
  for (const id of moveIds(d.paths)) {
    if (lastPhase(d.paths, id) === 'adopted' && readManifest(d.paths, id).from === from) await confirmAdopt(d, id as HomeMoveId);
  }
}

/** How move `id` ended here by its journal, undefined while it can still go either way: what the old home is told. */
export function moveOutcome(p: Paths, id: string): Exclude<AdoptAnswer, { status: 'pending' }> | undefined {
  const at = lastPhase(p, id);
  if (at === 'aborted') return { status: 'not-adopted' };
  if (at === 'done') return { status: 'done' };
  if (at === 'adopted') return adopted(p, id) as Extract<AdoptAnswer, { status: 'adopted' }>;
  return undefined;
}

export function readOwed(p: Pick<Paths, 'homeDeliver'>): HomeDelivery | undefined {
  let text: string;
  try { text = fs.readFileSync(p.homeDeliver, 'utf8'); } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw e;
  }
  return HomeDelivery.parse(JSON.parse(text));
}

/** The machine taking the fleet owes the old home the outcome: on the disk before that home's mark, as nothing else could thaw it. */
export function owe(p: Pick<Paths, 'homeDeliver'>, d: HomeDelivery): void {
  writeDurable(p.homeDeliver, d, { mode: 0o600 });
  homePoint('deliver.owed');
}

// ---------------------------------------------------------------------------------------- the machine the fleet leaves

export function readMarker(p: Pick<Paths, 'homeMoving'>): HomeMoving | undefined {
  let text: string;
  try { text = fs.readFileSync(p.homeMoving, 'utf8'); } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw e;
  }
  // a marker cannot be read: this machine must not guess it may be a home, and waits for the file to be fixed
  try { return HomeMoving.parse(JSON.parse(text)); } catch (e) { throw new InvalidConfig(`invalid ${p.homeMoving}: ${(e as Error).message}`, { cause: e }); }
}

/** The marker, written once: by the mark alone, never over one that stands, never for a move this home has written off, and with no outcome in it. */
export function createMarker(p: Pick<Paths, 'homeMoving' | 'homeMoves'>, m: HomeMoving): void {
  if (m.enrol) throw new Error(`the mark of ${m.id} carries an outcome, which only the machine holding the fleet gives`);
  if (lastPhase(p, m.id) === 'aborted') throw new Error(`move ${m.id} was called off here before its mark`);
  try { createDurable(p.homeMoving, m, { mode: 0o600 }); } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'EEXIST') throw new Error(`a marker stands here already, of ${readMarker(p)?.id ?? 'a move'}`);
    throw e;
  }
  homePoint('mark.written');
}

/** Whether an outcome names the machine and the fleet this marker was written for. */
export const enrolFits = (m: HomeMoving, enrol: Enrolment): boolean => enrol.worker.homeMachineId === m.to && enrol.worker.fleetId === m.fleetId;

/** The one change a marker takes after its mark: the outcome `adopted`, once, on the marker of `id` as it stands. */
export function addEnrol(p: Pick<Paths, 'homeMoving'>, id: string, enrol: Enrolment): HomeMoving {
  const held = readMarker(p);
  if (held?.id !== id) throw new Error(`this home holds no marker of ${id}`);
  if (!enrolFits(held, enrol)) throw new Error(`the outcome of ${id} names another machine or fleet than its marker`);
  if (held.enrol) {
    if (JSON.stringify(held.enrol) === JSON.stringify(enrol)) return held;
    throw new Error(`the marker of ${id} holds its outcome already`);
  }
  const m = { ...held, enrol };
  writeDurable(p.homeMoving, m, { mode: 0o600 });
  homePoint('enrol.written');
  return m;
}

// a daemon that ended may be about to start: its lock held, a start never meets a marker written after its join
async function withoutDaemon(p: Paths, id: string, what: (held: HomeMoving) => void): Promise<void> {
  // a daemon past this marker has heard already, and holds its lock for as long as it runs
  if (readMarker(p)?.id !== id) return;
  const unlock = await waitForDaemonLock(p);
  try {
    const held = readMarker(p);
    if (held?.id === id) what(held);
  } finally { unlock(); }
}

const driverOf = (id: string): string => `${id}.driver`;

// a new key in the driver's journal, under what it is for: only its hash leaves
function mintKey(p: Pick<Paths, 'homeMoves'>, id: string, use: 'mark' | 'adopt-key'): string {
  const key = crypto.randomBytes(32).toString('base64url');
  enter(p, driverOf(id), use, JSON.stringify({ key }));
  return sha256Hex(key);
}

const keyIn = (p: Pick<Paths, 'homeMoves'>, id: string, use: 'mark' | 'adopt-key'): string | undefined => journalLines(p, driverOf(id)).flatMap((l) => {
  try { return l.phase === use && l.detail ? [z.object({ key: z.string() }).parse(JSON.parse(l.detail)).key] : []; } catch { return []; }
}).at(-1);

const hashFits = (sha: string, key: string | undefined): key is string => key !== undefined && crypto.timingSafeEqual(Buffer.from(sha256Hex(key)), Buffer.from(sha));

/** A new key for the move `id`, in its driver's journal: the marker holds its hash, and only an outcome carrying it ends that marker. */
export const markKey = (p: Pick<Paths, 'homeMoves'>, id: string): string => mintKey(p, id, 'mark');

/** The key the driver of `id` wrote before its mark; none, and no machine was marked for it. */
export const driverKey = (p: Pick<Paths, 'homeMoves'>, id: string): string | undefined => keyIn(p, id, 'mark');

/** A new key for the install of move `id`, in its driver's journal before the copy: the manifest holds its hash, and the driver sends it only after the mark. */
export const mintAdoptKey = (p: Pick<Paths, 'homeMoves'>, id: string): string => mintKey(p, id, 'adopt-key');

/** The key the machine taking the fleet installs move `id` with. */
export const driverAdoptKey = (p: Pick<Paths, 'homeMoves'>, id: string): string | undefined => keyIn(p, id, 'adopt-key');

/** Whether `key` is the one the driver of the marker's move holds. */
export const keyFits = (m: HomeMoving, key: string | undefined): key is string => hashFits(m.keySha256, key);

/** The outcome `adopted` where this fleet's next start takes it, for a daemon that does not answer. */
export const writeEnrol = (p: Paths, id: string, enrol: Enrolment, key: string): Promise<void> => withoutDaemon(p, id, (held) => {
  if (!keyFits(held, key)) throw new Error(`the marker of ${id} is not ended without the key of its driver`);
  addEnrol(p, id, enrol);
});

/**
 * Who says a move is over here. `refused`: this machine turns the move down for good, about to take the fleet or told before its mark. The rest end the
 * marker of a home the fleet left: `asked`, the machine holding the fleet answered `not-adopted`; `told`, it delivered that to a
 * home with no route to ask it; `joined`, its enrolment is in place; `recorded`, a call of this function got as far as its journal line.
 */
export type MoveEnd = { by: 'refused'; detail?: string } | { by: 'told'; key: string } | { by: 'asked' | 'joined' | 'recorded' };

/** Why a home refuses a move it was told is off before its mark came. */
export const TOLD_UNMARKED = 'told it was called off before its mark';

/**
 * The only way a marker goes or an id is written off, so a thawed home always has an answer from the machine holding the fleet
 * behind it. Anything that does not fit the marker standing here throws, and leaves it.
 */
export function endMove(p: Paths, id: string, end: MoveEnd): void {
  const marker = readMarker(p);
  if (end.by === 'refused') {
    if (marker?.id === id) throw new Error(`this home holds the marker of ${id}, which only the machine holding the fleet can end`);
    enter(p, id, 'aborted', end.detail);
    return;
  }
  if (marker?.id !== id) throw new Error(`this home holds no marker of ${id}`);
  const at = lastPhase(p, id);
  const fits = end.by === 'asked' ? marker.ask !== undefined : end.by === 'told' ? marker.ask === undefined && keyFits(marker, end.key) : end.by === 'joined' ? marker.enrol !== undefined : at === 'released' || at === 'done';
  if (!fits) throw new Error(`the marker of ${id} is not ended by ${end.by}`);
  if (end.by === 'asked' || end.by === 'told') enter(p, id, 'released', end.by);
  if (end.by === 'joined') enter(p, id, 'done');
  fs.rmSync(p.homeMoving, { force: true });
  fs.rmSync(docsCut(p, id), { force: true });
  if (end.by === 'joined' || at === 'done') fs.rmSync(p.homeServed, { force: true });
}

export type Settling = {
  /** This fleet's daemon takes the outcome itself, with the driver's key; each rejects when none answers. */
  join(enrol: Enrolment, key: string): Promise<unknown>;
  thaw(key: string): Promise<unknown>;
  start(): Promise<void>;
};

/** Whether `e` says no daemon answers at all, and so not that one answered and refused. */
const noDaemon = (e: unknown): boolean => /svalld is not running|ECONNREFUSED/.test((e as Error).message);

/**
 * Told by the machine that took the fleet how a move ended, as often as it takes, with the key its driver holds; what has heard
 * already says `done`, and a `not-adopted` that finds no marker refuses that move's mark for good. The file is changed only with no
 * daemon there to take it, and a marker only one that waits to be told; a daemon that refuses leaves it.
 */
export async function settleMove(p: Paths, id: HomeMoveId, told: Extract<AdoptAnswer, { status: 'adopted' | 'not-adopted' }>, key: string | undefined, d: Settling): Promise<{ status: string }> {
  const held = readMarker(p);
  if (held?.id !== id) {
    // told before its mark: that mark is refused for good, by the daemon that would take it, or on the file with none running
    if (told.status === 'not-adopted' && key !== undefined) {
      await d.thaw(key).catch((e: unknown) => {
        if (e instanceof Crash || !noDaemon(e)) throw e;
        endMove(p, id, { by: 'refused', detail: TOLD_UNMARKED });
      });
    }
    return { status: 'done' };
  }
  if (held.ask) throw new Error(`this home asks ${held.toName} how its move ended, and is told by no one; svall fleet home abort calls it off`);
  if (!keyFits(held, key)) throw new Error(`only ${held.toName} ends this move, with a key it alone holds; svall fleet home abort there calls it off`);
  const onFile = async (e: unknown, write: () => Promise<void>): Promise<boolean> => {
    if (e instanceof Crash) throw e;
    // a daemon that joined or thawed past this call has heard
    if (readMarker(p)?.id !== id) return false;
    if (!noDaemon(e)) throw e;
    await write();
    return true;
  };
  if (told.status === 'adopted') {
    await d.join(told.enrol, key).catch((e: unknown) => onFile(e, () => writeEnrol(p, id, told.enrol, key)));
    await d.start();
    return { status: 'adopted' };
  }
  if (await d.thaw(key).then(() => false, (e: unknown) => onFile(e, () => withoutDaemon(p, id, () => endMove(p, id, { by: 'told', key }))))) await d.start();
  return { status: 'not-adopted' };
}

// what an earlier stop left and no journal gives up: a pack a kill cut off, keys and all, and the cut of a move that never marked. The cut of a marked one stays for its join
function dropLeftBehind(p: Paths, id: string): void {
  const [marked, journaled] = [readMarker(p)?.id, moveIds(p)];
  for (const name of fs.readdirSync(p.home)) {
    const [, packed, cut] = /^(?:adopt-(hm_[0-9a-z]{10})|docs-cut-(hm_[0-9a-z]{10})\.json)$/.exec(name) ?? [];
    const left = packed ? packed !== id && !journaled.includes(packed) : cut !== undefined && cut !== id && cut !== marked;
    if (left) fs.rmSync(path.join(p.home, name), { recursive: true, force: true });
  }
}

/** What an archive of this fleet's files comes to, as `packFleet` takes them. */
export function carriedKb(p: Paths): number {
  const files = CARRIED.flatMap((name) => {
    const from = inHome(p, name);
    if (!fs.existsSync(from)) return [];
    const real = fs.realpathSync(from);
    return fs.statSync(real).isDirectory() ? ownFiles(real).map((rel) => path.join(real, rel)) : [real];
  });
  // a file gone since it was listed, such as a robot's temp file, carries nothing
  const sizes = files.map((f) => fs.statSync(f, { throwIfNoEntry: false })?.size).filter((n) => n !== undefined);
  return Math.ceil(sizes.reduce((n, size) => n + TAR_BLOCK + Math.ceil(size / TAR_BLOCK) * TAR_BLOCK, 0) / 1024);
}

/** The fleet's files as an archive: only done moves, the running ones' journals being a machine's own. */
export async function packFleet(p: Paths, m: HomeManifest): Promise<{ sha256: string; bytes: Buffer }> {
  dropLeftBehind(p, m.id);
  const dir = adoptDir(p, m.id);
  const out = path.join(dir, 'out');
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(out, { recursive: true, mode: 0o700 });
  try {
    for (const name of CARRIED) {
      const from = inHome(p, name);
      if (!fs.existsSync(from)) continue;
      const to = path.join(out, name);
      fs.mkdirSync(path.dirname(to), { recursive: true, mode: 0o700 });
      // a linked fleet.json or docs goes as what it links to; a link inside is no file of the fleet's, and may lead to any key of the account's
      fs.cpSync(fs.realpathSync(from), to, { recursive: true, filter: (src) => !fs.lstatSync(src).isSymbolicLink() });
    }
    const moves = path.join(out, 'journal', 'moves');
    for (const name of fs.existsSync(moves) ? fs.readdirSync(moves) : []) {
      let phase: unknown;
      try { phase = (read(path.join(moves, name)) as { phase?: unknown }).phase; } catch { /* not a move's */ }
      if (phase !== 'done' && phase !== 'aborted') fs.rmSync(path.join(moves, name), { recursive: true, force: true });
    }
    writeDurable(path.join(out, MANIFEST), { ...m, fromFleetHome: p.home }, { mode: 0o600 });
    const names = [...filesIn(out)];
    const long = names.find((n) => !ustarFits(Buffer.from(`./${n}`)));
    if (long) throw new Error(`${long} has a path too long for a move to carry; rename it first`);
    const file = path.join(dir, 'out.tar');
    await packTar(out, names, file);
    const bytes = fs.readFileSync(file);
    writeDurable(docsCut(p, m.id), docsAt(path.join(out, 'docs')), { mode: 0o600 });
    return { bytes, sha256: crypto.createHash('sha256').update(bytes).digest('hex') };
  } finally {
    // the archive holds the fleet's keys, and has no more use here once it is read
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// each doc as the archive's cut took it, for the join to tell what the old home's robots wrote since
const docsCut = (p: Pick<Paths, 'home'>, id: string): string => path.join(p.home, `docs-cut-${id}.json`);
const docsAt = (dir: string): Record<string, string> => Object.fromEntries(ownFiles(dir).map((rel) => [rel, sha256Hex(fs.readFileSync(path.join(dir, rel)))]));

// what the old home's robots did between the cut and the join, as a worker's own changes over what the new home took at the cut: its
// first tar would take any file with no record of it, and so what this writes is the cut's hash of each, none for a doc the cut lacked.
// A repo's note goes by the name the new home gave its folder, unless the cut held that name already and so none was given
function carrySinceCut(p: Paths, id: string, kept: string, renames: Map<string, string>): void {
  let cut: Record<string, string> | undefined;
  try { cut = read(docsCut(p, id)) as Record<string, string>; } catch { return; }
  const taken = new Set(Object.keys(cut).map((rel) => rel.split(path.sep).slice(0, 2).join(path.sep)));
  const there = (rel: string): string => {
    const [top, slug, ...rest] = rel.split(path.sep);
    const now = top === 'repos' ? renames.get(slug) : undefined;
    return now && !taken.has(path.join('repos', now)) ? path.join('repos', now, ...rest) : rel;
  };
  const now = docsAt(kept);
  const synced: Record<string, string> = {};
  for (const [rel, sha256] of Object.entries(now)) {
    if (cut[rel] === sha256) continue;
    const to = path.join(p.cache, 'docs', there(rel));
    fs.mkdirSync(path.dirname(to), { recursive: true, mode: 0o700 });
    fs.copyFileSync(path.join(kept, rel), to);
    if (cut[rel]) synced[there(rel)] = cut[rel];
  }
  for (const [rel, sha256] of Object.entries(cut)) if (!(rel in now)) synced[there(rel)] = sha256;
  writeDurable(p.docsSynced, synced, { mode: 0o600 });
}

/** The name of the home move `id` comes from, on the machine it comes to: as its archive says, or as this worker's home before that came. */
export function oldHomeName(p: Paths, id: string): string | undefined {
  try { return readManifest(p, id).record.name; } catch { /* no archive yet */ }
  try { return JSON.parse(fs.readFileSync(p.workerFile, 'utf8')).homeName as string; } catch { return undefined; }
}

/** The move this machine waits on, as the one the fleet leaves or the one that owes it the outcome, for a check that wants nothing under way. */
export const moveInFlight = (p: Paths): string | undefined => readMarker(p)?.id ?? readOwed(p)?.id;

/**
 * The old home's install, from the state as it stood when its daemon stopped: run again it derives the same files from the
 * copy it kept. Only the daemon's own start, holding the fleet home's lock, runs this; `heldAsHome` lets it through by the stamp.
 */
export function joinAsWorker(p: Paths, m: HomeMoving & { enrol: Enrolment }, registryDir?: string): void {
  const keep = `${p.state}.home-${m.id}`;
  if (!fs.existsSync(keep)) writeDurable(keep, fs.readFileSync(p.state), { mode: 0o600 });
  homePoint('join.kept');
  const held = migrateState(read(keep)).state;
  const state = relabelHome(held, { from: m.from, fromName: m.fromName, fromHome: m.fromHome, to: m.to, toName: m.toName, toHome: m.toHome, at: m.at, stamp: true });
  writeDurable(p.state, state, { mode: 0o600 });
  homePoint('join.state');
  const docs = `${p.docs}.home-${m.id}`;
  if (fs.existsSync(p.docs) && !fs.existsSync(docs)) fs.renameSync(p.docs, docs);
  // a worker's own: what it last took of an earlier home's, and an outbox of an earlier time as a worker. The mirror's record is
  // of what a Copy wrote as well, which must not read as written by a mirror
  for (const old of [path.join(p.cache, 'docs'), p.docsSynced, p.mirrorState, p.outbox, p.acked, p.epoch, p.phoneFallbacks]) fs.rmSync(old, { recursive: true, force: true });
  carrySinceCut(p, m.id, docs, repoRenames(held, m.fromHome, m.toHome));
  if (fs.existsSync(p.workersFile)) fs.renameSync(p.workersFile, `${p.workersFile}.home-${m.id}`);
  homePoint('join.docs');
  if (m.enrol.home) putRecord(m.to, m.enrol.home, registryDir);
  writeDurable(p.workerFile, m.enrol.worker, { mode: 0o600 });
  homePoint('join.worker');
  endMove(p, m.id, { by: 'joined' });
  dropOldCopies(p, m.id);
  homePoint('join.done');
}

/** The copies a join keeps of the old home's files, of this move and the one before it here; an older move's go. */
function dropOldCopies(p: Paths, id: string): void {
  const kept = new RegExp(`^(?:${[p.state, p.docs, p.workersFile].map((f) => path.basename(f).replace(/\./g, '\\.')).join('|')})\\.home-(hm_[0-9a-z]{10})$`);
  const byMove = new Map<string, string[]>();
  for (const name of fs.readdirSync(p.home)) {
    const of = kept.exec(name)?.[1];
    if (of) byMove.set(of, [...byMove.get(of) ?? [], name]);
  }
  const at = (m: string): number => { try { return fs.statSync(`${p.state}.home-${m}`).mtimeMs; } catch { return 0; } };
  const older = [...byMove.keys()].filter((m) => m !== id).sort((a, b) => at(b) - at(a)).slice(1);
  // best effort: a copy that cannot go stays for a person to remove, and the join stands
  for (const m of older) for (const name of byMove.get(m)!) {
    try { fs.rmSync(path.join(p.home, name), { recursive: true, force: true }); } catch { /* left as it is */ }
  }
}

/**
 * What a starting daemon does first, holding the fleet home's lock so nothing else is changing it: an install a crash cut short
 * goes back as it was, a join it was told of goes forward. Answers the marker it must start frozen under, if the outcome of the
 * move is not known yet.
 */
export function homeGate(p: Paths, registryDir?: string): { frozen?: HomeMoving } {
  // only a move whose folder stands here can be installing: a driver's journal and a move over are not read
  for (const id of moveIds(p).filter((m) => fs.existsSync(adoptDir(p, m)))) {
    if (lastPhase(p, id) !== 'installing') continue;
    restoreOriginal(p, id);
    restoreRecord({ paths: p, registryDir }, id as HomeMoveId, readManifest(p, id));
    enter(p, id, 'rolledback', CUT_SHORT);
  }
  const marker = readMarker(p);
  if (!marker) return {};
  // past its join, or past the record that it is off: this machine has heard already, and a join run again would rewind it. An
  // `aborted` here is no such record: this machine's own refusal, of a move it had not yet marked, says nothing of where the fleet is
  const over = lastPhase(p, marker.id);
  if (over === 'done' || over === 'released') {
    endMove(p, marker.id, { by: 'recorded' });
    return {};
  }
  if (marker.enrol) {
    joinAsWorker(p, marker as HomeMoving & { enrol: Enrolment }, registryDir);
    return {};
  }
  return { frozen: marker };
}
