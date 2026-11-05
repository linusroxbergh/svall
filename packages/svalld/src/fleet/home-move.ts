import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { z } from 'zod';
import {
  AdoptAnswer, Enrolment, HomeManifest, HomeMoving, MachineRecord, migrateState, relabelHome, WorkerFile,
  type FleetState, type HomeMoveId, type MachineId,
} from '@svall/protocol';
import { repoRootOf, repoSlug } from '../docs.js';
import { appendDurable, syncDir, writeDurable } from '../durable.js';
import { HomeCrash as Crash, homePoint } from '../failpoints.js';
import { daemonLock, homeMoveLock } from '../kernel-lock.js';
import { putRecord, readRegistry } from '../machine.js';
import { filesIn } from '../placement/docs-sync.js';
import { packTar } from '../placement/bundle.js';
import { homeRootOf } from '../placement/repo-key.js';
import { relocate } from '../placement/relocate.js';
import type { Paths } from '../paths.js';
import { withOwned } from '../worker/snapshot.js';

const exec = promisify(execFile);

/** What the fleet carries to its new home: never node.json, the token, .env, tmux, the hooks, the cache or the outbox. */
const CARRIED = ['fleet.json', 'state.json', 'docs', 'agent-profiles', 'push.json', 'vapid.json', 'mobile-pass', 'mobile-key', 'mirror-consent.json', 'retro', 'journal/moves'] as const;
/** What a worker's fleet home holds that no home does; each goes aside with the files it replaces, and comes back with them. */
const WORKER_ONLY = ['worker.json', 'phone.json', 'phone-fallbacks.json', 'journal/epoch'] as const;
const INSTALLED = [...CARRIED, 'workers.json'] as const;
const MANIFEST = 'home-move.json';
// how long a stopped daemon has to let go of its lock
const STOP_MS = 60_000;

/** A destination's phases: `installing` while its files are changing, which only a recovery ends; `installed` until its daemon answers as the home. */
const AdoptPhase = z.enum(['staging', 'staged', 'installing', 'installed', 'rolledback', 'adopted', 'aborted', 'done']);
type AdoptPhase = z.infer<typeof AdoptPhase>;
const Record_ = z.object({ phase: z.string(), at: z.number(), detail: z.string().optional() });

export const adoptDir = (p: Pick<Paths, 'home'>, id: string): string => path.join(p.home, `adopt-${id}`);
const journalOf = (p: Pick<Paths, 'homeMoves'>, id: string): string => path.join(p.homeMoves, `${id}.ndjson`);

/** The journal of a move as this machine holds it, a line a crash cut short left out. */
export function journalLines(p: Pick<Paths, 'homeMoves'>, id: string): z.infer<typeof Record_>[] {
  let text: string;
  try { text = fs.readFileSync(journalOf(p, id), 'utf8'); } catch { return []; }
  return text.split('\n').flatMap((line) => {
    try { return [Record_.parse(JSON.parse(line))]; } catch { return []; }
  });
}

const lastPhase = (p: Pick<Paths, 'homeMoves'>, id: string): AdoptPhase | undefined => {
  const phase = journalLines(p, id).at(-1)?.phase;
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


const readManifest = (p: Paths, id: string): HomeManifest => HomeManifest.parse(JSON.parse(fs.readFileSync(path.join(adoptDir(p, id), 'incoming', MANIFEST), 'utf8')));

const notAdopted = (detail?: string): AdoptAnswer => ({ status: 'not-adopted', ...(detail && { detail }) });
const pending = (phase: string, detail?: string): AdoptAnswer => ({ status: 'pending', phase, ...(detail && { detail }) });

// one at a time for a fleet home: what finds another under way answers `pending`, and nothing thaws on that
async function serialized(p: Paths, what: () => Promise<AdoptAnswer>): Promise<AdoptAnswer> {
  fs.mkdirSync(p.home, { recursive: true });
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

const enrolFile = (p: Paths, id: string): string => path.join(adoptDir(p, id), 'enrol.json');

function adopted(p: Paths, id: string): AdoptAnswer {
  return { status: 'adopted', enrol: Enrolment.parse(JSON.parse(fs.readFileSync(enrolFile(p, id), 'utf8'))) };
}

/**
 * Takes the fleet's archive into a staged folder, once its sha256 has checked out, and changes nothing of the fleet home. A
 * move this machine has refused stays refused.
 */
export function stageAdopt(d: AdoptDeps, id: HomeMoveId, sha256: string, archive: Buffer): Promise<AdoptAnswer> {
  const p = d.paths;
  return serialized(p, async () => {
    const at = lastPhase(p, id);
    if (at === 'aborted') return notAdopted('this move was called off here');
    if (at === 'done') return { status: 'done' };
    if (at === 'adopted') return adopted(p, id);
    if (at === 'installing' || at === 'installed' || at === 'staged' || at === 'rolledback') return pending(at);
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
    fs.renameSync(incoming, path.join(dir, 'incoming'));
    enter(p, id, 'staged');
    homePoint('adopt.staged');
    return pending('staged');
  });
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

// a repo's notes hang off a hash of its path on the home, so each known root takes the name its path has on the new one
function renameRepoDocs(docs: string, state: FleetState, from: string, to: string): void {
  if (from === to) return;
  const repos = path.join(docs, 'repos');
  for (const r of Object.values(state.robots)) {
    const root = homeRootOf(r, state.machines, from) ?? repoRootOf(r);
    if (!root) continue;
    const [was, now] = [path.join(repos, repoSlug(root)), path.join(repos, repoSlug(relocate(root, { from, to })))];
    if (was !== now && fs.existsSync(was) && !fs.existsSync(now)) fs.renameSync(was, now);
  }
}

// each doc this worker changed that its home has not sent back: the newest there is of it
function carryOwnDocs(p: Paths, docs: string): void {
  const dir = path.join(p.cache, 'docs');
  let synced: Record<string, string> = {};
  try { synced = JSON.parse(fs.readFileSync(p.docsSynced, 'utf8')) as Record<string, string>; } catch { /* none taken yet */ }
  for (const rel of fs.existsSync(dir) ? filesIn(dir) : []) {
    const bytes = fs.readFileSync(path.join(dir, rel));
    if (synced[rel] === crypto.createHash('sha256').update(bytes).digest('hex')) continue;
    const to = path.join(docs, rel);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.writeFileSync(to, bytes, { mode: 0o600 });
  }
}

const read = (file: string): unknown => JSON.parse(fs.readFileSync(file, 'utf8'));

type CarriedConfig = { defaultCwd?: string; home?: { cwd?: string }; onboarding?: { firstProject?: string }; mobile?: { logins?: string[] } };

// a path under the old home reads as the same place under the new one; the phone's authorization stays what it was, as empty logins mean a login only the old home had
function carriedConfig(c: CarriedConfig, m: HomeManifest): CarriedConfig {
  const local = (p: string | undefined): string | undefined => (p === undefined ? p : p === m.record.home ? '~' : p.startsWith(`${m.record.home}/`) ? `~${p.slice(m.record.home.length)}` : p);
  return {
    ...c,
    ...(c.defaultCwd && { defaultCwd: local(c.defaultCwd) }),
    ...(c.home?.cwd && { home: { ...c.home, cwd: local(c.home.cwd) } }),
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
  writeDurable(path.join(ready, 'state.json'), state, { mode: 0o600 });
  renameRepoDocs(path.join(ready, 'docs'), relabelHome(state, { from: m.to, fromName: m.toName, to: m.from, toName: m.record.name, at }), m.record.home, m.toHome);
  carryOwnDocs(p, path.join(ready, 'docs'));
  writeDurable(path.join(ready, 'fleet.json'), carriedConfig(read(path.join(ready, 'fleet.json')) as CarriedConfig, m), { mode: 0o600 });
  writeDurable(path.join(ready, 'workers.json'), { [m.from]: { token, addedAt: at } }, { mode: 0o600 });
  return ready;
}

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
  fs.mkdirSync(path.join(original, 'journal'), { recursive: true, mode: 0o700 });
  fs.mkdirSync(path.join(p.home, 'journal'), { recursive: true });
  for (const name of INSTALLED) {
    const [from, at] = [path.join(ready, name), inHome(p, name)];
    if (present(at)) fs.renameSync(at, path.join(original, name));
    else fs.writeFileSync(heldNone(original, name), '');
    homePoint('adopt.file');
    if (fs.existsSync(from)) fs.renameSync(from, at);
  }
  for (const name of WORKER_ONLY) if (present(inHome(p, name))) fs.renameSync(inHome(p, name), path.join(original, name));
  homePoint('adopt.dropped');
  syncFolders(p, dir);
}

/** Everything back as it was before the install began, whichever of its steps a crash cut it or this at; what a failed home wrote goes with it. */
export function restoreOriginal(p: Paths, id: string): void {
  const dir = adoptDir(p, id);
  const [original, thrown] = [path.join(dir, 'original'), path.join(dir, `thrown-${Date.now()}`)];
  fs.mkdirSync(path.join(thrown, 'journal'), { recursive: true, mode: 0o700 });
  for (const name of [...INSTALLED, ...WORKER_ONLY]) {
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
async function rollback(d: AdoptDeps, id: HomeMoveId, m: HomeManifest, why?: string): Promise<void> {
  const p = d.paths;
  await d.daemon.stop().catch(() => undefined);
  const unlock = await waitForDaemonLock(p);
  try {
    restoreOriginal(p, id);
    restoreRecord(d, id, m);
    enter(p, id, 'rolledback', why);
  } finally { unlock(); }
  await d.daemon.start().catch(() => undefined);
}

function restoreRecord(d: Pick<AdoptDeps, 'paths' | 'registryDir'>, id: HomeMoveId, m: HomeManifest): void {
  const file = path.join(adoptDir(d.paths, id), HELD_RECORD);
  if (!fs.existsSync(file)) return;
  putRecord(m.from, heldRecordOf(d.paths, id), d.registryDir);
  fs.rmSync(file, { force: true });
}

/**
 * The move's commit on the machine that takes the fleet: stop, install, start, and adopted only once the running daemon's own
 * API has answered as the home. Runs from the staged input as often as it takes.
 */
export function installAdopt(d: AdoptDeps, id: HomeMoveId, enrolment: (token: string, m: HomeManifest) => Enrolment): Promise<AdoptAnswer> {
  const p = d.paths;
  return serialized(p, async () => {
    if (lastPhase(p, id) === 'installing') await recoverInstall(d, id);
    const at = lastPhase(p, id);
    if (at === 'aborted') return notAdopted('this move was called off here');
    if (at === 'done') return { status: 'done' };
    if (at === 'adopted') return adopted(p, id);
    if (at === undefined || at === 'staging') return pending('staging', 'this move has no archive here yet');
    const manifest = readManifest(p, id);
    if (at !== 'installed') {
      await d.daemon.stop();
      homePoint('adopt.stopped');
      const unlock = await waitForDaemonLock(p);
      try {
        // the token one try issued holds for the next
        const token = fs.existsSync(enrolFile(p, id)) ? WorkerFile.parse((read(enrolFile(p, id)) as Enrolment).worker).token : crypto.randomBytes(24).toString('hex');
        writeDurable(enrolFile(p, id), enrolment(token, manifest), { mode: 0o600 });
        buildReady(d, id, manifest, token);
        enter(p, id, 'installing');
        homePoint('adopt.installing');
        installFiles(p, id);
        const file = path.join(adoptDir(p, id), HELD_RECORD);
        const held = fs.existsSync(file) ? heldRecordOf(p, id) : undefined;
        writeDurable(file, { heldRecord: held ?? readRegistry(d.registryDir).find((m) => m.id === manifest.from)?.record ?? null }, { mode: 0o600 });
        putRecord(manifest.from, manifest.record, d.registryDir);
        homePoint('adopt.registry');
        enter(p, id, 'installed');
        homePoint('adopt.installed');
      } catch (e) {
        if (e instanceof Crash) throw e;
        if (lastPhase(p, id) === 'installing') {
          restoreOriginal(p, id);
          restoreRecord(d, id, manifest);
          enter(p, id, 'rolledback', (e as Error).message);
        }
        unlock();
        await d.daemon.start().catch(() => undefined);
        return pending(lastPhase(p, id) ?? 'staged', (e as Error).message);
      } finally { unlock(); }
    }
    let why = "its daemon did not answer as this fleet's home";
    let up = false;
    try {
      await d.daemon.start();
      homePoint('adopt.started');
      up = await d.daemon.answersHome(manifest.fleetId);
    } catch (e) {
      if (e instanceof Crash) throw e;
      why = (e as Error).message;
    }
    if (!up) {
      await rollback(d, id, manifest, why);
      return pending('rolledback', why);
    }
    enter(p, id, 'adopted');
    homePoint('adopt.committed');
    return adopted(p, id);
  });
}

// the daemon that would start on half-installed files is held off by this lock, and a daemon that starts first has done this already
async function recoverInstall(d: AdoptDeps, id: HomeMoveId): Promise<void> {
  const unlock = await waitForDaemonLock(d.paths);
  try {
    if (lastPhase(d.paths, id) === 'installing') {
      restoreOriginal(d.paths, id);
      restoreRecord(d, id, readManifest(d.paths, id));
      enter(d.paths, id, 'rolledback', 'the install was cut short');
    }
  } finally { unlock(); }
}

/**
 * What the machine taking the fleet says of move `id`. An id it has never heard of it refuses for good before it says so, so
 * a delayed adopt cannot come after; anything staged or running answers `pending`.
 */
export function adoptStatus(d: AdoptDeps, id: HomeMoveId): Promise<AdoptAnswer> {
  const p = d.paths;
  return serialized(p, async () => {
    const at = lastPhase(p, id);
    if (at === undefined) {
      enter(p, id, 'aborted', 'asked before any archive came');
      homePoint('abort.recorded');
      return notAdopted();
    }
    if (at === 'aborted') return notAdopted();
    if (at === 'done') return { status: 'done' };
    if (at === 'adopted') return adopted(p, id);
    if (at === 'installing') {
      await recoverInstall(d, id);
      await d.daemon.start().catch(() => undefined);
      return pending('rolledback', 'the install was cut short');
    }
    if (at === 'installed') {
      const manifest = readManifest(p, id);
      let up = await d.daemon.answersHome(manifest.fleetId).catch(() => false);
      if (!up) {
        await d.daemon.start().catch(() => undefined);
        up = await d.daemon.answersHome(manifest.fleetId).catch(() => false);
      }
      if (up) {
        enter(p, id, 'adopted');
        homePoint('adopt.committed');
        return adopted(p, id);
      }
      const why = "its daemon did not answer as this fleet's home";
      await rollback(d, id, manifest, why);
      return pending('rolledback', why);
    }
    return pending(at);
  });
}

/** Calls move `id` off, for good, unless it has already gone through; only what comes back `not-adopted` lets the old home thaw. */
export function abortAdopt(d: AdoptDeps, id: HomeMoveId): Promise<AdoptAnswer> {
  const p = d.paths;
  return serialized(p, async () => {
    const at = lastPhase(p, id);
    if (at === 'done') return { status: 'done' };
    if (at === 'adopted') return adopted(p, id);
    if (at === 'installing' || at === 'installed') await rollback(d, id, readManifest(p, id));
    if (at !== 'aborted') {
      enter(p, id, 'aborted');
      homePoint('abort.recorded');
    }
    fs.rmSync(adoptDir(p, id), { recursive: true, force: true });
    return notAdopted();
  });
}

/** The move has landed on both sides: what was staged here goes, keys and all. */
export function confirmAdopt(d: AdoptDeps, id: HomeMoveId): Promise<AdoptAnswer> {
  const p = d.paths;
  return serialized(p, () => {
    const at = lastPhase(p, id);
    if (at !== 'adopted' && at !== 'done') return Promise.resolve(pending(at ?? 'unknown'));
    if (at === 'adopted') enter(p, id, 'done');
    fs.rmSync(adoptDir(p, id), { recursive: true, force: true });
    return Promise.resolve({ status: 'done' });
  });
}

// ---------------------------------------------------------------------------------------- the machine the fleet leaves

export function readMarker(p: Pick<Paths, 'homeMoving'>): HomeMoving | undefined {
  let text: string;
  try { text = fs.readFileSync(p.homeMoving, 'utf8'); } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw e;
  }
  // a marker cannot be read: this machine must not guess it may be a home
  return HomeMoving.parse(JSON.parse(text));
}

export function writeMarker(p: Pick<Paths, 'homeMoving' | 'homeMoves'>, m: HomeMoving): void {
  writeDurable(p.homeMoving, m, { mode: 0o600 });
  homePoint(m.enrol ? 'enrol.written' : 'mark.written');
}

/** The fleet's files as an archive: only done moves, the running ones' journals being a machine's own. */
export async function packFleet(p: Paths, m: HomeManifest): Promise<{ file: string; sha256: string; bytes: Buffer }> {
  const dir = adoptDir(p, m.id);
  const out = path.join(dir, 'out');
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(out, { recursive: true, mode: 0o700 });
  for (const name of CARRIED) {
    const from = inHome(p, name);
    if (!fs.existsSync(from)) continue;
    const to = path.join(out, name);
    fs.mkdirSync(path.dirname(to), { recursive: true, mode: 0o700 });
    fs.cpSync(from, to, { recursive: true, dereference: true });
  }
  const moves = path.join(out, 'journal', 'moves');
  for (const name of fs.existsSync(moves) ? fs.readdirSync(moves) : []) {
    let phase: unknown;
    try { phase = (read(path.join(moves, name)) as { phase?: unknown }).phase; } catch { /* not a move's */ }
    if (phase !== 'done' && phase !== 'aborted') fs.rmSync(path.join(moves, name), { recursive: true, force: true });
  }
  writeDurable(path.join(out, MANIFEST), m, { mode: 0o600 });
  const names = [...filesIn(out)];
  const file = path.join(dir, 'out.tar');
  await packTar(out, names, file);
  fs.rmSync(out, { recursive: true, force: true });
  const bytes = fs.readFileSync(file);
  return { file, bytes, sha256: crypto.createHash('sha256').update(bytes).digest('hex') };
}

/** Whether this machine has taken the fleet in or was left by it, for a check that wants nothing under way. */
export const moveInFlight = (p: Paths): string | undefined => readMarker(p)?.id;

/**
 * The old home's install, from the state as it stood when its daemon stopped: run again it derives the same files from the
 * copy it kept. Only the daemon's own start, holding the fleet home's lock, runs this; `heldAsHome` lets it through by the stamp.
 */
export function joinAsWorker(p: Paths, m: HomeMoving & { enrol: Enrolment }, registryDir?: string): void {
  const keep = `${p.state}.home-${m.id}`;
  if (!fs.existsSync(keep)) writeDurable(keep, fs.readFileSync(p.state), { mode: 0o600 });
  homePoint('join.kept');
  const state = relabelHome(migrateState(read(keep)).state, { from: m.from, fromName: m.fromName, fromHome: m.fromHome, to: m.to, toName: m.toName, toHome: m.toHome, at: m.at, stamp: true });
  writeDurable(p.state, state, { mode: 0o600 });
  homePoint('join.state');
  const docs = `${p.docs}.home-${m.id}`;
  if (fs.existsSync(p.docs) && !fs.existsSync(docs)) fs.renameSync(p.docs, docs);
  // a worker's own: what it last took of an earlier home's, and an outbox of an earlier time as a worker. The mirror's record is
  // of what a Copy wrote as well, which must not read as written by a mirror
  for (const old of [path.join(p.cache, 'docs'), p.docsSynced, p.mirrorState, p.outbox, p.acked, p.epoch, p.phoneFallbacks]) fs.rmSync(old, { recursive: true, force: true });
  if (fs.existsSync(p.workersFile)) fs.renameSync(p.workersFile, `${p.workersFile}.home-${m.id}`);
  homePoint('join.docs');
  if (m.enrol.home) putRecord(m.to, m.enrol.home, registryDir);
  writeDurable(p.workerFile, m.enrol.worker, { mode: 0o600 });
  homePoint('join.worker');
  appendDurable(journalOf(p, m.id), { phase: 'done', at: Date.now() });
  fs.rmSync(p.homeMoving, { force: true });
  homePoint('join.done');
}

/**
 * What a starting daemon does first, holding the fleet home's lock so nothing else is changing it: an install a crash cut short
 * goes back as it was, a join it was told of goes forward. Answers the marker it must start frozen under, if the outcome of the
 * move is not known yet.
 */
export function homeGate(p: Paths, registryDir?: string): { frozen?: HomeMoving } {
  for (const name of fs.existsSync(p.homeMoves) ? fs.readdirSync(p.homeMoves) : []) {
    const id = name.replace(/\.ndjson$/, '');
    if (lastPhase(p, id) !== 'installing') continue;
    restoreOriginal(p, id);
    restoreRecord({ paths: p, registryDir }, id as HomeMoveId, readManifest(p, id));
    enter(p, id, 'rolledback', 'the install was cut short');
  }
  const marker = readMarker(p);
  if (!marker) return {};
  if (marker.enrol) {
    joinAsWorker(p, marker as HomeMoving & { enrol: Enrolment }, registryDir);
    return {};
  }
  return { frozen: marker };
}


