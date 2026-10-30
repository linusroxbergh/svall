import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { z } from 'zod';
import { ApiError, MachineId, MoveId, MovePhase, ObjectName, Robot, TransferSession, type LeftBehind, type Refusal } from '@svall/protocol';
import { AGENTS } from '../agents.js';
import type { Fleet } from '../fleet.js';
import { DurableJson } from '../durable.js';
import { boundary, type Failpoint } from '../failpoints.js';
import { sha256Hex } from '../hash.js';
import { ProcessTable } from '../processes.js';
import { classifyTerminals, RestJournal, restTerminals, serversGone, type Classified, type RestChoices, type RestDeps } from './rest.js';
import { cliRunner, installSession, sessionAdapter } from '../sessions/registry.js';
import { SessionError, type CliRun, type SessionAdapter } from '../sessions/types.js';
import { must, type GitRunner } from '../links/git.js';
import type { Logger } from '../log.js';
import { installedScripts } from '../paths.js';
import type { Store } from '../store.js';
import { clean, realPath } from '../path-tools.js';
import { noServer, type Tmux } from '../tmux/tmux.js';
import { BundleManifest, buildBundle, CREDENTIAL_GLOBS, fingerprintOf, isCredential, untrackedFiles, wasCredential } from './bundle.js';
import { MovePlan, type Carried } from './checks.js';
import { refuseUncarried } from './convert.js';
import { sessionLanding } from './paths.js';
import { answerTrustPrompt, nap } from './trust.js';

const exec = promisify(execFile);

/** One move as either machine journals it: its plan, how far it got, and what it carried. */
export const MoveJournal = z.object({
  id: MoveId,
  robotId: z.string(),
  from: MachineId,
  to: MachineId,
  phase: MovePhase,
  // the placement generation the robot holds from the commit on
  generation: z.number().int().nonnegative(),
  plan: MovePlan,
  // the robot as its rest left it where it was, which the other machine takes it from
  robot: Robot.optional(),
  manifest: BundleManifest.optional(),
  // each terminal's session, as the session blob carries its files
  sessions: z.array(TransferSession).optional(),
  // what the rest stopped
  rest: RestJournal.optional(),
  branchSha: ObjectName.optional(),
  // what this machine changed for the move, each journaled before it is made, so an abort undoes only that
  made: z.object({
    // the worktree the robot left here, taken back for this move
    unlocked: z.literal(true).optional(),
    worktree: z.literal(true).optional(),
    // the clone's main checkout let go of the branch
    detached: z.literal(true).optional(),
    // the main checkout converted to the robot's worktree, which the robot keeps whatever the move does next
    converted: z.literal(true).optional(),
    // the branch as it was: its sha, or null for none
    branch: ObjectName.nullable().optional(),
    // the session files that were not here
    files: z.array(z.string()).optional(),
  }).optional(),
  // the fingerprint of the worktree an abort left again here, which an abort asked again answers
  fingerprint: z.string().optional(),
  error: z.string().optional(),
  updatedAt: z.number(),
});
export type MoveJournal = z.infer<typeof MoveJournal>;

/** A machine's journals of its moves, one durable file each, and the folder each move stages its files in. */
export class MoveFiles {
  constructor(readonly dir: string) {}

  read(id: string): MoveJournal | undefined {
    const r = new DurableJson(MoveJournal, path.join(this.dir, `${MoveId.parse(id)}.json`)).read();
    if (r.ok) return r.value;
    if (r.reason === 'missing') return undefined;
    throw new Error(`the journal of move ${id} cannot be read: ${r.error}`);
  }

  ids(): string[] {
    const names = fs.existsSync(this.dir) ? fs.readdirSync(this.dir) : [];
    return names.flatMap((f) => /^(mv_[0-9a-z]{10})\.json$/.exec(f)?.[1] ?? []);
  }

  write(j: MoveJournal): void {
    new DurableJson(MoveJournal, path.join(this.dir, `${j.id}.json`)).write(j);
  }

  stage(id: string): string {
    return path.join(this.dir, MoveId.parse(id));
  }
}

export const blobIds = (id: string) => ({ bundle: id, session: `${id}_session` });

// a folder as one file, and back: pax, which bsdtar and GNU tar both read, holds any path a session has, and none of the
// attributes macOS would add to it that GNU tar does not know
async function pack(dir: string, file: string): Promise<void> {
  fs.mkdirSync(dir, { recursive: true });
  const bare = ['--no-xattrs', '--no-acls', ...(process.platform === 'darwin' ? ['--no-mac-metadata'] : [])];
  await exec('tar', ['-c', '-f', file, '--format=pax', ...bare, '-C', dir, '.'], { env: { ...process.env, COPYFILE_DISABLE: '1' } });
}
export async function unpack(file: string, dir: string): Promise<void> {
  fs.mkdirSync(dir, { recursive: true });
  await exec('tar', ['-x', '-p', '--no-same-owner', '-f', file, '-C', dir]);
}

/**
 * Copies each terminal's session into `into/<n>` by its path under its agent home, the transcript landing at the plan's place
 * for it; a CLI that keeps its sessions in a database of its own writes the session out to its export file there.
 */
async function stageSessions(c: Robot, paths: MovePlan['paths'], into: string, run: CliRun): Promise<TransferSession[]> {
  const sessions: TransferSession[] = [];
  for (const [term, slot, dest] of [[undefined, c, paths.transcriptPath], [2, c.second, paths.secondTranscriptPath]] as const) {
    const a = slot?.agent;
    if (!a?.transcriptPath || !dest) continue;
    const { sourceHome, files } = await sessionLanding({ ...c, agent: a });
    const transcript = path.posix.relative(sourceHome, a.transcriptPath);
    if (!dest.endsWith(`/${transcript}`)) throw new Error(`${a.kind} session ${a.sessionId} has no place at ${dest}`);
    const n = String(sessions.length);
    const listed: TransferSession['files'] = [];
    const adapter = sessionAdapter(a.kind);
    for (const f of files) {
      const to = path.join(into, n, f);
      fs.mkdirSync(path.dirname(to), { recursive: true });
      if (f === adapter.exportFile?.(a.sessionId)) await adapter.exportSession!(a.sessionId, to, run, (slot ?? c).cwd);
      else fs.copyFileSync(path.join(sourceHome, f), to);
      const st = fs.statSync(to);
      listed.push({ type: 'file', path: f, mode: st.mode & 0o777, size: st.size, mtimeMs: Math.floor(st.mtimeMs), sha256: sha256Hex(fs.readFileSync(to)) });
    }
    sessions.push({
      robotId: c.id, ...(term && { term }), agent: a.kind, sessionId: a.sessionId, sourcePath: a.transcriptPath, destinationPath: dest,
      sourceHome, destinationHome: dest.slice(0, -transcript.length - 1), adapter: adapter.adapter, files: listed,
    });
  }
  return sessions;
}

/** Builds the bundle of the robot's worktree and stages its sessions under `stage`, each folder packed as the blob that carries it. */
export function packMove(c: Robot, j: MoveJournal, stage: string, git: GitRunner, run: CliRun = cliRunner()): Promise<Pick<MoveJournal, 'manifest' | 'branchSha' | 'sessions'>> {
  return boundary('move.bundle', async () => {
    fs.rmSync(stage, { recursive: true, force: true });
    let packed: Pick<MoveJournal, 'manifest' | 'branchSha'> = {};
    if (c.repo) {
      // a worktree the move just converted into holds no operation, though core.ignoreStat marks its every file
      if (!j.plan.convert) await refuseUncarried(c.repo.root, git);
      const manifest = await buildBundle(c.repo.root, { git, into: path.join(stage, 'bundle'), have: j.plan.have, carry: j.plan.carry });
      const branchSha = (await must(git, ['rev-parse', '--verify', `refs/heads/${manifest.branch}^{commit}`], c.repo.root)).trim();
      await pack(path.join(stage, 'bundle'), path.join(stage, 'bundle.tar'));
      packed = { manifest, branchSha };
    }
    const sessions = await stageSessions(c, j.plan.paths, path.join(stage, 'session'), run);
    await pack(path.join(stage, 'session'), path.join(stage, 'session.tar'));
    return { ...packed, sessions };
  });
}

/** Puts each carried session, staged under `staged/<n>`, where its agent resumes it on this machine. */
export function placeSessions(sessions: readonly TransferSession[], staged: string): void {
  sessions.forEach((s, n) => installSession(s, path.join(staged, String(n))));
}

// the folder a carried session resumes in on this machine
const sessionCwd = (s: TransferSession, paths: MovePlan['paths']): string => (s.term === 2 ? paths.second : undefined) ?? paths.cwd;

/**
 * Refuses, changing nothing, while this machine's copy of a carried session a CLI keeps in a database of its own went on
 * past the one staged under `staged/<n>`; `where` names this machine.
 */
export async function checkSessions(sessions: readonly TransferSession[], staged: string, paths: MovePlan['paths'], run: CliRun, where: string): Promise<void> {
  for (const [n, s] of sessions.entries()) {
    const adapter = sessionAdapter(s.agent, s.adapter);
    if (!adapter.exportFile || !adapter.checkSession) continue;
    try { await adapter.checkSession(s.sessionId, path.join(staged, String(n), adapter.exportFile(s.sessionId)), sessionCwd(s, paths), run); } catch (e) {
      if (!(e instanceof SessionError && e.code === 'destination_diverged')) throw e;
      const { label, bin } = AGENTS[s.agent];
      throw refused({ reason: `${label} went on with session ${s.sessionId} ${where} since the move`, action: `save it with ${bin} session export, then delete it` });
    }
  }
}

/**
 * Reads each carried session a CLI keeps in a database of its own into this machine's from its staged export, to resume
 * at the plan's folder, in place of the copy held here, which waits in `held` and comes back if the import fails.
 */
export async function importSessions(sessions: readonly TransferSession[], staged: string, paths: MovePlan['paths'], held: string, run: CliRun): Promise<void> {
  for (const [n, s] of sessions.entries()) {
    const adapter = sessionAdapter(s.agent, s.adapter);
    if (!adapter.exportFile || !adapter.dropSession || !adapter.importSession || !adapter.restoreSession) continue;
    const file = path.join(staged, String(n), adapter.exportFile(s.sessionId));
    const cwd = sessionCwd(s, paths);
    const keep = path.join(held, s.agent, `${s.sessionId}.json`);
    await adapter.dropSession(s.sessionId, file, cwd, run, keep);
    try { await adapter.importSession(s.sessionId, file, cwd, run); } catch (e) {
      if (fs.existsSync(keep)) {
        await adapter.restoreSession(s.sessionId, keep, run);
        fs.rmSync(keep, { force: true });
      }
      throw e;
    }
    fs.rmSync(keep, { force: true });
  }
}

/** The robot as it runs on `machine` (the home, when absent) from the commit on: at its paths there, at the move's generation, dormant with the revive its rest left. */
export function landed(c: Robot, j: Pick<MoveJournal, 'plan' | 'generation'>, machine: MachineId | undefined): Robot {
  const p = j.plan.paths;
  const r = structuredClone(c);
  for (const k of ['tmux', 'hint', 'codexDaemon', 'resumeError', 'panePath', 'repo', 'machine'] as const) delete r[k];
  if (machine) r.machine = machine;
  r.placement = { generation: j.generation };
  r.cwd = p.cwd;
  if (p.panePath) r.panePath = p.panePath;
  if (p.repo) r.repo = p.repo;
  if (r.agent) {
    delete r.agent.pid;
    if (p.transcriptPath) r.agent.transcriptPath = p.transcriptPath;
  }
  if (r.second) {
    for (const k of ['tmux', 'resumeError'] as const) delete r.second[k];
    if (p.second) r.second.cwd = p.second;
    if (r.second.agent) {
      delete r.second.agent.pid;
      if (p.secondTranscriptPath) r.second.agent.transcriptPath = p.secondTranscriptPath;
    }
  }
  return r;
}

export type RestSide = Omit<RestDeps, 'journal'>;

/** This machine's terminals that still hold a process, as rest reads them. */
export async function liveTerminals(d: Pick<RestDeps, 'store' | 'tmux' | 'processes'>): Promise<Classified[]> {
  const live = await d.tmux.listWindows().catch((e: unknown) => { if (noServer(e)) return []; throw e; });
  const table = await (d.processes ?? (() => ProcessTable.read({ scripts: installedScripts() })))();
  return classifyTerminals(d.store.state, live, table);
}

/** What a worker sends of a robot's way back: what travels, and the class of each of its live terminals there. */
export type ReturnSheet = Carried & { terminals: Pick<Classified, 'term' | 'class'>[] };

// the move's `rest` as the rest code reads and writes it, each write saved with the move's journal
function restJournal(j: MoveJournal, save: (j: MoveJournal) => void): RestDeps['journal'] & { current(): MoveJournal } {
  let cur = j;
  return {
    read: () => cur.rest!,
    write: (rest) => { cur = { ...cur, rest }; save(cur); },
    current: () => cur,
  };
}

/** Rests the robot's terminals and closes their windows, recording what it stops as the journal's `rest`. */
export async function restRobot(deps: RestSide, j: MoveJournal, save: (j: MoveJournal) => void, choices: RestChoices): Promise<MoveJournal> {
  const cur: MoveJournal = j.rest ? j : { ...j, rest: RestJournal.parse({}) };
  save(cur);
  const journal = restJournal(cur, save);
  const r = await boundary('move.rest', () => restTerminals({ ...deps, journal }, { choices, only: (t) => t.robotId === j.robotId }));
  if (!r.ok) throw new Error(r.blockers.map((b) => b.message).join('; '));
  return journal.current();
}

/**
 * Waits for the OpenCode server each terminal the rest closed left running, killing one that outlasts the settle: an OpenCode
 * resumed beside it would share its database. A terminal whose window still runs keeps its server.
 */
export async function serversLeft(deps: Omit<RestSide, 'viewers'>, j: MoveJournal, save: (j: MoveJournal) => void): Promise<void> {
  if (!j.rest) return;
  const live = new Set((await deps.tmux.listWindows().catch((e: unknown) => { if (noServer(e)) return []; throw e; })).map((w) => w.windowId));
  await serversGone({ ...deps, journal: restJournal(j, save) }, {}, (t) => {
    const c = deps.store.state.robots[t.robotId];
    const window = (t.term === 2 ? c?.second : c)?.tmux?.windowId;
    return !window || !live.has(window);
  });
}

/** Locks the worktree at `root` with `reason`; one locked already stays as it is. */
export async function lockWorktree(root: string, reason: string, git: GitRunner): Promise<void> {
  const r = await git(['worktree', 'lock', '--reason', reason, root], root);
  if (r.code !== 0 && !/already locked/.test(r.stderr)) throw new Error(`${root} was not locked: ${r.stderr.trim()}`);
}

/** Empties a worktree of what git does not ignore and it does not track, but for credential files, which stay where they were. */
async function cleanWorktree(root: string, git: GitRunner): Promise<void> {
  for (const p of (await untrackedFiles(root, git)).filter((f) => !isCredential(f))) fs.rmSync(path.join(root, p), { force: true });
  // then the folders left empty
  await must(git, ['clean', '-q', '-f', '-d', ...CREDENTIAL_GLOBS.flatMap((p) => ['-e', p])], root);
}

export type Failure = Omit<Refusal, 'details'>;
export const refused = (f: Failure): ApiError => new ApiError('refused', `${f.reason}; ${f.action}`, { refusal: { ...f, details: [] } });

/** What moved in the worktree a robot left since it left, as a move that takes it back refuses it; `where` names its machine. */
export async function changedSince(left: LeftBehind, where: string, git: GitRunner): Promise<Failure | undefined> {
  const sha = await git(['rev-parse', '--verify', '-q', `refs/heads/${left.branch}^{commit}`], left.path);
  if (sha.stdout.trim() !== left.branchSha) return { reason: `${left.branch} moved ${where} since the move`, action: 'merge or rename it' };
  const same = async (credential: (p: string) => boolean): Promise<boolean> => await fingerprintOf(left.path, git, credential) === left.fingerprint;
  if (!await same(isCredential) && !await same(wasCredential)) return { reason: `changes ${where} in ${left.path} since the move`, action: 'stash or commit them' };
  return undefined;
}

/** The worktree the robot left on `me` that a move into `root` there takes back: one it left at `root`, whose folder is still there. */
export const takenBack = (left: LeftBehind | undefined, root: string, me: MachineId): LeftBehind | undefined =>
  (left?.machine === me && clean(left.path) === clean(root) && fs.existsSync(root) ? left : undefined);

/** The worktree that has `branch` checked out in the repository at `repo`, or is rebasing or bisecting it, if one has. */
export async function holding(repo: string, branch: string, git: GitRunner): Promise<string | undefined> {
  const ref = `refs/heads/${branch}`;
  for (const e of (await must(git, ['worktree', 'list', '--porcelain'], repo)).split('\n\n').map((x) => x.split('\n'))) {
    const at = e[0].slice('worktree '.length);
    if (e.includes(`branch ${ref}`)) return at;
    if (!e.includes('detached') || !fs.existsSync(at)) continue;
    // a rebase or bisect under way lists its worktree detached, and holds the branch it started from as git counts it
    const dir = (await git(['rev-parse', '--absolute-git-dir'], at)).stdout.trim();
    const read = (f: string): string => (dir && fs.existsSync(path.join(dir, f)) ? fs.readFileSync(path.join(dir, f), 'utf8').trim() : '');
    if (read('rebase-merge/head-name') === ref || read('rebase-apply/head-name') === ref || [branch, ref].includes(read('BISECT_START'))) return at;
  }
  return undefined;
}

export type Made = NonNullable<MoveJournal['made']>;

/**
 * A worktree at `root` in the clone at `clone` for bundle `m`, at a commit the clone holds, each change journaled with `made`
 * before it is made; with `detach`, a main checkout with no tracked changes lets go of the branch. `where` names this machine.
 */
export async function newWorktree(o: { clone: string; root: string; m: BundleManifest; detach: boolean; where: string; git: GitRunner; made: (m: Made) => void }): Promise<void> {
  const { clone, root, m, git, where } = o;
  if (fs.lstatSync(root, { throwIfNoEntry: false })) throw new Error(`${root} on ${where} is in the way; move it out of the way there first`);
  const holder = await holding(clone, m.branch, git);
  if (holder) {
    // a rebase or bisect there holds the branch detached, and never counts as idle
    const onIt = (await git(['symbolic-ref', '-q', 'HEAD'], clone)).stdout.trim() === `refs/heads/${m.branch}`;
    const idle = o.detach && holder === realPath(clone) && onIt && !(await must(git, ['status', '--porcelain', '--untracked-files=no'], clone)).trim();
    if (!idle) throw new Error(`${m.branch} is checked out in ${holder} on ${where}; check out another branch there first`);
    o.made({ detached: true });
    await must(git, ['checkout', '-q', '--detach'], clone);
  }
  // at a commit the clone holds; the bundle's commits and the branch come with its apply
  const start = m.commits ? m.commits.prerequisites[0] ?? 'HEAD' : m.base;
  o.made({ worktree: true });
  await must(git, ['worktree', 'add', '-q', '--detach', root, start], clone);
}

/**
 * Puts back what `made` records a move did in the clone at `clone` for bundle `m`: its worktree at `root` removed, the branch
 * as it was; `still` takes what is left to undo after each step.
 */
export async function removeWorktree(clone: string, root: string, m: BundleManifest, made: Made, git: GitRunner, still: (m: Made) => void = () => {}): Promise<void> {
  const undone = (k: 'worktree' | 'branch' | 'detached'): void => { const { [k]: _, ...rest } = made; made = rest; still(made); };
  if (made.worktree) {
    if (fs.existsSync(root)) await must(git, ['worktree', 'remove', '--force', root], clone);
    undone('worktree');
  }
  if (made.branch === null) {
    const there = await git(['rev-parse', '--verify', '-q', `refs/heads/${m.branch}`], clone);
    if (there.code === 0 && !(await holding(clone, m.branch, git))) await must(git, ['branch', '-q', '-D', m.branch], clone);
    undone('branch');
  } else if (made.branch) {
    await must(git, ['update-ref', `refs/heads/${m.branch}`, made.branch], clone);
    undone('branch');
  }
  if (made.detached) {
    await must(git, ['checkout', '-q', m.branch], clone);
    undone('detached');
  }
}

/** One move at a time in each clone, so two moves into one serialize. */
export class CloneLocks {
  private locks = new Map<string, Promise<void>>();

  async run<T>(clone: string, step: () => Promise<T>): Promise<T> {
    const key = clean(clone);
    const before = this.locks.get(key) ?? Promise.resolve();
    let release!: () => void;
    const tail = before.then(() => new Promise<void>((resolve) => { release = resolve; }));
    this.locks.set(key, tail);
    await before;
    try {
      return await step();
    } finally {
      release();
      if (this.locks.get(key) === tail) this.locks.delete(key);
    }
  }
}

/** Unlocks the worktree a robot left at `root` and resets it to `sha`, cleaned, for the bundle that brings the robot back. */
export async function takeBack(root: string, sha: string, git: GitRunner): Promise<void> {
  const r = await git(['worktree', 'unlock', root], root);
  if (r.code !== 0 && !/is not locked/.test(r.stderr)) throw new Error(`${root} was not unlocked: ${r.stderr.trim()}`);
  await must(git, ['reset', '-q', '--hard', '--no-recurse-submodules', sha], root);
  await cleanWorktree(root, git);
}

/** Leaves a worktree a move took back as the robot had left it: at `sha`, cleaned, locked with `reason`; answers its fingerprint. */
export async function leaveAgain(root: string, sha: string, reason: string, git: GitRunner): Promise<string> {
  await must(git, ['reset', '-q', '--hard', '--no-recurse-submodules', sha], root);
  await cleanWorktree(root, git);
  await lockWorktree(root, reason, git);
  return fingerprintOf(root, git);
}

type Wake = {
  store: Pick<Store, 'state' | 'subscribe'>;
  fleet: Pick<Fleet, 'reviveRobot' | 'openSecond' | 'onSessionStart'>;
  tmux: Pick<Tmux, 'screen' | 'sendBytes'>;
  log: Logger;
  watchMs: number;
  open?: Failpoint;
  /** Whether the agent may ask to trust its folder, which no seed answered. */
  trust?: boolean;
};

// answers the agent's trust question if it shows before the robot's session reports its start or `watchMs` passes
function watchTrust(w: Wake, j: MoveJournal, name: string, pane: string, adapter: SessionAdapter): void {
  const stop = new AbortController();
  const unheard = w.fleet.onSessionStart((robotId, term) => { if (robotId === j.robotId && term === undefined) stop.abort(); });
  void answerTrustPrompt(w.tmux, pane, adapter, { forMs: w.watchMs, signal: stop.signal })
    .catch((e: Error) => w.log.error(`move ${j.id}: ${name}'s trust question went unwatched: ${e.message}`))
    .finally(unheard);
}

/**
 * Opens the terminals the rest closed and watches `watchMs` for the robot's session to start, answering its trust question if
 * `trust`. Answers the resume's error, or undefined once it is up or coming up; one already up gets its second terminal.
 */
export async function wake(w: Wake, j: MoveJournal): Promise<string | undefined> {
  const id = j.robotId;
  const c = w.store.state.robots[id];
  if (!c) return `no robot ${id}`;
  const second = async () => {
    if (!j.rest?.stoppedTerminals.some((t) => t.term === 2)) return;
    await w.fleet.openSecond(id, undefined, j.id).catch((e: Error) => w.log.error(`move ${j.id}: ${c.name}'s second terminal did not open: ${e.message}`));
  };
  if (c.tmux) {
    await second();
    return undefined;
  }
  const agent = c.revive?.command ? c.agent : undefined;
  let heard!: () => void;
  const started = new Promise<undefined>((resolve) => { heard = () => resolve(undefined); });
  const unheard = w.fleet.onSessionStart((robotId, term, sessionId) => { if (robotId === id && term === undefined && sessionId === agent?.sessionId) heard(); });
  let failed!: (error: string) => void;
  const dormant = new Promise<string>((resolve) => { failed = resolve; });
  const unwatched = w.store.subscribe(() => {
    const now = w.store.state.robots[id];
    if (now && !now.tmux && now.resumeError) failed(now.resumeError);
  });
  const watch = new AbortController();
  try {
    const open = () => w.fleet.reviveRobot(id, undefined, undefined, j.id);
    try { await (w.open ? boundary(w.open, open) : open()); } catch (e) { return (e as Error).message; }
    await second();
    const pane = w.store.state.robots[id]?.tmux?.paneId;
    const adapter = agent && sessionAdapter(agent.kind);
    if (!adapter || !pane) return undefined;
    if (w.trust) watchTrust(w, j, c.name, pane, adapter);
    // a CLI that reports no session until its first turn is up once its window is
    if (!adapter.sessionStartOnResume) return undefined;
    return await Promise.race([started, dormant, nap(w.watchMs, watch.signal).then(() => undefined)]);
  } finally {
    watch.abort();
    unheard();
    unwatched();
  }
}
