import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { z } from 'zod';
import {
  ApiError, MachineId, MoveId, MovePhase, ObjectName, Robot, TransferSession, WORKER_OWNED,
  type FleetId, type LeftBehind, type MoveSheet, type Refusal, type SystemInfo,
} from '@svall/protocol';
import { AGENTS } from '../agents.js';
import { Invalid, NotFound } from '../errors.js';
import type { Fleet } from '../fleet.js';
import { DurableJson } from '../handover/durable.js';
import { boundary, type Failpoint } from '../handover/failpoints.js';
import { must } from '../handover/git-graph.js';
import { hashStream, sha256Hex } from '../handover/hash.js';
import { SourceJournal, type JournalState } from '../handover/journal.js';
import { clean } from '../handover/portable-path.js';
import { ProcessTable } from '../handover/processes.js';
import { relocate } from '../handover/relocate.js';
import { classifyTerminals, restTerminals, type RestChoices, type RestDeps } from '../handover/rest.js';
import { cliRunner, installSession, sessionAdapter, type AgentProber } from '../handover/sessions/registry.js';
import { SessionError, type CliRun, type SessionAdapter } from '../handover/sessions/types.js';
import type { HomeLinks, WorkerHello } from '../link/home.js';
import type { GitRunner } from '../links/git.js';
import type { Logger } from '../log.js';
import { installedScripts, type Paths } from '../paths.js';
import type { Store } from '../store.js';
import { noServer, type Tmux } from '../tmux/tmux.js';
import { applyBundle, BundleManifest, buildBundle, CREDENTIAL_PATTERNS, fingerprintOf, verifyBundle } from './bundle.js';
import { converted, homesOf, MovePlan, moveChecks, type Carried, type CheckDeps, type CheckResult } from './checks.js';
import { convertMainCheckout, WORKTREES } from './convert.js';
import { destinationPaths, sessionLanding } from './paths.js';
import { answerTrustPrompt } from './trust.js';

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
  // what the rest stopped, as a handover's source journal records it
  rest: SourceJournal.optional(),
  branchSha: ObjectName.optional(),
  // what this machine changed for the move, each journaled before it is made, so an abort undoes only that
  made: z.object({
    // the worktree the robot left here, taken back for this move
    unlocked: z.literal(true).optional(),
    worktree: z.literal(true).optional(),
    // the clone's main checkout let go of the branch
    detached: z.literal(true).optional(),
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

const JOURNALED: Record<MovePhase, Failpoint> = {
  rest: 'move.journal.rest', bundle: 'move.journal.bundle', prepare: 'move.journal.prepare', commit: 'move.journal.commit',
  activate: 'move.journal.activate', release: 'move.journal.release', done: 'move.journal.done', aborted: 'move.journal.aborted',
};
const BEFORE_COMMIT = new Set<MovePhase>(['rest', 'bundle', 'prepare']);

const SNAPSHOT_MS = 60_000;
const WATCH_MS = 60_000;
// a rest waits up to 3 minutes for a turn, a prepare may clone
const REST_MS = 10 * 60_000;
const PREPARE_MS = 15 * 60_000;

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

const newMoveId = (): string => `mv_${[...crypto.randomBytes(10)].map((b) => (b % 36).toString(36)).join('')}`;

export const fileSha = async (file: string): Promise<string> => (await hashStream(fs.createReadStream(file))).sha256;

/** The blob ids a move's files travel under. */
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
 * Copies each terminal's session into `into/<n>` by its path under its agent home, and names where it lands: the
 * transcript at the plan's place for it, the files beside it as under the source's agent home. A CLI that keeps its
 * sessions in a database of its own writes the session out to its export file there.
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
  for (const k of ['tmux', 'hint', 'codexDaemon', 'resumeError', 'restedBy', 'panePath', 'repo', 'machine'] as const) delete r[k];
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
    for (const k of ['tmux', 'resumeError', 'restedBy'] as const) delete r.second[k];
    if (p.second) r.second.cwd = p.second;
    if (r.second.agent) {
      delete r.second.agent.pid;
      if (p.secondTranscriptPath) r.second.agent.transcriptPath = p.secondTranscriptPath;
    }
  }
  return r;
}

type RestSide = Omit<RestDeps, 'journal'>;

/** Rests the robot's terminals and closes their windows, recording what it stops as the journal's `rest`. */
export async function restRobot(deps: RestSide, j: MoveJournal, save: (j: MoveJournal) => void, fleetId: FleetId, choices: RestChoices): Promise<MoveJournal> {
  let cur: MoveJournal = j.rest ? j : {
    ...j,
    rest: {
      role: 'source', transactionId: j.id, generation: 0, fleetId, fromMachineId: j.from, toMachineId: j.to, phase: 'freeze',
      updatedAt: Date.now(), stoppedTerminals: [], terminated: [], serverKills: [],
    },
  };
  save(cur);
  const journal = {
    journalState: (): JournalState => ({ kind: 'open', journal: cur.rest! }),
    write: (rest: SourceJournal) => { cur = { ...cur, rest }; save(cur); },
  };
  const r = await boundary('move.rest', () => restTerminals({ ...deps, journal }, { choices, only: (t) => t.robotId === j.robotId }));
  if (!r.ok) throw new Error(r.blockers.map((b) => b.message).join('; '));
  return cur;
}

/** Locks the worktree at `root` with `reason`; one locked already stays as it is. */
export async function lockWorktree(root: string, reason: string, git: GitRunner): Promise<void> {
  const r = await git(['worktree', 'lock', '--reason', reason, root], root);
  if (r.code !== 0 && !/already locked/.test(r.stderr)) throw new Error(`${root} was not locked: ${r.stderr.trim()}`);
}

/** Empties a worktree of what git does not ignore and it does not track, but for credential files, which stay where they were. */
export const cleanWorktree = (root: string, git: GitRunner): Promise<string> =>
  must(git, ['clean', '-q', '-f', '-d', ...CREDENTIAL_PATTERNS.flatMap((p) => ['-e', p])], root);

export type Failure = Omit<Refusal, 'details'>;
export const refused = (f: Failure): ApiError => new ApiError('refused', `${f.reason}; ${f.action}`, { refusal: { ...f, details: [] } });

/** What moved in the worktree a robot left since it left, as a move that takes it back refuses it; `where` names its machine. */
export async function changedSince(left: LeftBehind, where: string, git: GitRunner): Promise<Failure | undefined> {
  const sha = await git(['rev-parse', '--verify', '-q', `refs/heads/${left.branch}^{commit}`], left.path);
  if (sha.stdout.trim() !== left.branchSha) return { reason: `${left.branch} moved ${where} since the move`, action: 'merge or rename it' };
  if (await fingerprintOf(left.path, git) !== left.fingerprint) return { reason: `changes ${where} in ${left.path} since the move`, action: 'stash or commit them' };
  return undefined;
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

// `ms`, or less when `signal` aborts first
const nap = (ms: number, signal: AbortSignal): Promise<void> => new Promise((resolve) => {
  const done = () => { clearTimeout(timer); signal.removeEventListener('abort', done); resolve(); };
  const timer = setTimeout(done, ms);
  signal.addEventListener('abort', done);
});

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
 * Opens the terminals the move's rest closed, resuming the robot's agent, and watches for `watchMs` for its session to
 * start, answering its trust question if `trust` and it asks. Answers the resume's error, or undefined once the robot
 * is up or still coming up; a robot an earlier activation opened is up.
 */
export async function wake(w: Wake, j: MoveJournal): Promise<string | undefined> {
  const id = j.robotId;
  const c = w.store.state.robots[id];
  if (!c) return `no robot ${id}`;
  if (c.tmux) return undefined;
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
    if (j.rest?.stoppedTerminals.some((t) => t.term === 2)) {
      await w.fleet.openSecond(id, undefined, j.id).catch((e: Error) => w.log.error(`move ${j.id}: ${c.name}'s second terminal did not open: ${e.message}`));
    }
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

export type StartOptions = { interruptAfterMs?: number; carry?: string[] };

export type PlacementDeps = {
  store: Store;
  fleet: Pick<Fleet, 'reviveRobot' | 'openSecond' | 'onSessionStart'>;
  links: Pick<HomeLinks, 'for' | 'call' | 'pushSnapshot' | 'pushMirror'>;
  me: MachineId;
  fleetId: FleetId;
  paths: Pick<Paths, 'moves'>;
  git: GitRunner;
  agents: AgentProber;
  gateway: CheckDeps['gateway'];
  release: string;
  homedir: string;
  tmux: RestDeps['tmux'] & Pick<Tmux, 'screen' | 'sendBytes'>;
  viewers: RestDeps['viewers'];
  processes?: RestDeps['processes'];
  kill?: RestDeps['kill'];
  log: Logger;
  moves?: MoveFiles;
  watchMs?: number;
  /** Runs an agent CLI that keeps its sessions in a database of its own. */
  cli?: CliRun;
};

/**
 * The home's side of every move: a robot goes to a worker and comes back through rest, bundle, prepare, commit, activate
 * and release, each journaled before it runs. Before the commit a failure reopens the robot where it was; from the
 * commit on the robot is the destination's, and a crash resumes from the journal.
 */
export class Placement {
  private files: MoveFiles;
  private running = new Map<string, Promise<void>>();
  private linked = new Set<MachineId>();
  private unsubscribe: () => void;

  constructor(private d: PlacementDeps) {
    this.files = d.moves ?? new MoveFiles(d.paths.moves);
    // a worker linked again finishes what its moves left; a link marks its machine in the state as it comes and goes
    this.unsubscribe = d.store.subscribe(() => {
      for (const id of Object.keys(d.store.state.machines ?? {})) {
        const m = id as MachineId;
        const up = !!d.links.for(m)?.connected();
        if (up && !this.linked.has(m)) void this.recoverMoves(m).catch((e: Error) => d.log.error(`moves with ${m}: ${e.message}`));
        if (up) this.linked.add(m); else this.linked.delete(m);
      }
    });
  }

  stop(): void {
    this.unsubscribe();
  }

  /** Whether `robotId` can move to `to`, and the sheet and plan when it can; `to` this Mac checks the way back. */
  async check(robotId: string, to: MachineId, o: StartOptions = {}): Promise<CheckResult> {
    const c = this.robot(robotId);
    if (to === this.d.me) return this.checkReturn(c, o);
    if (c.machine && c.machine !== this.d.me) return { ok: false, refusal: { reason: 'a robot moves home first', action: `move ${c.name} to this Mac first`, details: [] } };
    const checked = await moveChecks(this.checkDeps(), robotId, to, o);
    // the worktree the robot left there is the one it goes back into, as it left it
    if (!checked.ok || c.left?.machine !== to) return checked;
    const { refusal } = await this.d.links.call<{ refusal?: Failure }>(to, 'move.compare', { left: c.left })
      .catch((e: Error) => ({ refusal: { reason: e.message, action: 'try again when it is awake' } }));
    return refusal ? { ok: false, refusal: { ...refusal, details: [] } } : checked;
  }

  /** Moves `robotId` to `to`; resolves with the move's id once it is committed, or rejects with why it was refused or undone. */
  start(robotId: string, to: MachineId, o: StartOptions = {}): Promise<string> {
    let id = '';
    return this.run(robotId, async () => {
      const c = this.robot(robotId);
      const back = to === this.d.me;
      const there = back ? c.machine : to;
      const link = there && this.d.links.for(there);
      if (link && link.connected() && !link.outboxDrained()) throw new ApiError('busy', `${this.name(there)} is still catching up with this Mac; try again in a moment`);
      const checked = await this.check(robotId, to, o);
      if (!checked.ok) throw refused(checked.refusal);
      id = newMoveId();
      // journaled before the robot is marked, so a move a crash cut short is always found
      const j = this.enter({
        id, robotId, from: back ? there! : this.d.me, to, phase: 'rest', generation: (c.placement?.generation ?? 0) + 1, plan: checked.plan, updatedAt: Date.now(),
      }, 'rest');
      this.d.store.update((d) => { d.robots[robotId].moving = { id, to, phase: 'rest' }; });
      await (back ? this.back(j) : this.out(j));
    }).then(() => id);
  }

  /** Runs a committed move on from the step it stopped at, as the card's Retry does. */
  async retry(moveId: string): Promise<void> {
    const j = this.status(moveId);
    if (BEFORE_COMMIT.has(j.phase) || j.phase === 'done' || j.phase === 'aborted') throw new Invalid(`move ${moveId} is ${j.phase}; there is nothing to retry`);
    await this.run(j.robotId, () => this.finish(j));
  }

  /**
   * Takes up every move a stop left unfinished, or only those with `machine`: one before its commit is undone, one
   * committed runs on. One whose worker is out of reach waits for it.
   */
  async recoverMoves(machine?: MachineId): Promise<void> {
    for (const id of this.files.ids()) {
      const j = this.readable(id);
      if (!j) continue;
      if (j.phase === 'done' || j.phase === 'aborted') {
        // a stop between the journal and the robot leaves the robot marked
        if (this.d.store.state.robots[j.robotId]?.moving?.id === j.id) this.d.store.update((d) => { delete d.robots[j.robotId].moving; });
        continue;
      }
      const there = j.to === this.d.me ? j.from : j.to;
      if (machine && there !== machine) continue;
      const busy = this.running.get(j.robotId);
      if (busy) { await busy; continue; }
      const why = new Error(j.error ?? 'svalld stopped during the move');
      await this.run(j.robotId, async () => {
        if (!BEFORE_COMMIT.has(j.phase)) return this.finish(j);
        if (j.to === this.d.me) return this.abortBack(j, why);
        return this.abortOut(j, why);
      }).catch((e: Error) => this.d.log.error(`move ${j.id}: ${e.message}`));
    }
  }

  // a journal that cannot be read is left where it is for a person to look at
  private readable(id: string): MoveJournal | undefined {
    try { return this.files.read(id); } catch (e) {
      this.d.log.error((e as Error).message);
      return undefined;
    }
  }

  status(moveId: string): MoveJournal {
    if (!MoveId.safeParse(moveId).success) throw new NotFound(`no move ${moveId}`);
    const j = this.files.read(moveId);
    if (!j) throw new NotFound(`no move ${moveId}`);
    return j;
  }

  private run(robotId: string, work: () => Promise<void>): Promise<void> {
    if (this.running.has(robotId)) {
      const m = this.d.store.state.robots[robotId]?.moving;
      return Promise.reject(new ApiError('moving', `moving to ${m ? this.name(m.to) : 'another machine'}`));
    }
    const p = work().finally(() => this.running.delete(robotId));
    this.running.set(robotId, p.catch(() => {}));
    return p;
  }

  private robot(id: string): Robot {
    if (!Object.hasOwn(this.d.store.state.robots, id)) throw new NotFound(`no robot ${id}`);
    return this.d.store.state.robots[id];
  }

  private name(m: MachineId): string {
    return m === this.d.me ? 'this Mac' : this.d.store.state.machines?.[m]?.name ?? m;
  }

  private save(j: MoveJournal): void {
    this.files.write({ ...j, updatedAt: Date.now() });
  }

  // journaled before the step runs; the card follows, and a move that has ended leaves the robot
  private enter(j: MoveJournal, phase: MovePhase): MoveJournal {
    const { error, ...rest } = j;
    const next: MoveJournal = { ...rest, phase, updatedAt: Date.now(), ...(phase === 'aborted' && error !== undefined && { error }) };
    boundary(JOURNALED[phase], () => this.files.write(next));
    this.d.store.update((d) => {
      const c = d.robots[j.robotId];
      if (c?.moving?.id !== j.id) return;
      if (phase === 'done' || phase === 'aborted') delete c.moving;
      else if (phase !== 'release') c.moving = { id: j.id, to: j.to, phase };
    });
    return next;
  }

  // the move as the card shows it until it is retried: stopped at its step, with why
  private stall(j: MoveJournal, error: string): void {
    this.save({ ...j, error });
    this.d.store.update((d) => {
      const c = d.robots[j.robotId];
      if (c?.moving?.id === j.id) c.moving = { id: j.id, to: j.to, phase: j.phase, error };
    });
    this.d.log.error(`move ${j.id}: ${error}`);
  }

  private checkDeps(): CheckDeps {
    const { store, me, links, git, agents, gateway, release, homedir, cli } = this.d;
    return { store, me, links, git, agents, gateway, release, homedir, terminals: () => this.terminals(), ...(cli && { cli }) };
  }

  private async terminals() {
    const live = await this.d.tmux.listWindows().catch((e: unknown) => { if (noServer(e)) return []; throw e; });
    const table = await (this.d.processes ?? (() => ProcessTable.read({ scripts: installedScripts() })))();
    return classifyTerminals(this.d.store.state, live, table);
  }

  private restDeps(): RestSide {
    const { store, tmux, viewers, processes, kill } = this.d;
    return { store, tmux, viewers, ...(processes && { processes }), ...(kill && { kill }) };
  }

  // ---- out: from this Mac to a worker

  private async out(j: MoveJournal): Promise<void> {
    try {
      if (j.phase === 'rest') {
        const { interruptAfterMs } = j.plan;
        // what a sheet's choice to interrupt or move anyway covers: an agent's turn and a command holding a shell
        const choices: RestChoices = interruptAfterMs === undefined ? {} : { interruptAfterMs, terminate: true };
        j = this.enter(await restRobot(this.restDeps(), j, (x) => this.save(x), this.d.fleetId, choices), 'bundle');
      }
      if (j.phase === 'bundle') {
        // the agent there is the one the user talks to here; a mirror that does not go is logged, and the move goes on
        await this.d.links.pushMirror(j.to);
        await this.convert(j);
        const c = this.robot(j.robotId);
        const packed = await packMove(c, j, this.files.stage(j.id), this.d.git, this.d.cli);
        j = this.enter({ ...j, robot: structuredClone(c), ...packed }, 'prepare');
      }
      if (j.phase === 'prepare') {
        await this.prepareThere(j);
        j = this.enter(j, 'commit');
      }
    } catch (e) {
      await this.abortOut(j, e as Error);
      throw e;
    }
    await this.finish(j);
  }

  // a main checkout becomes the robot's worktree once, and the robot moves into it, whatever the move does next
  private async convert(j: MoveJournal): Promise<void> {
    const cv = j.plan.convert;
    if (!cv) return;
    if (!fs.existsSync(path.join(cv.main, WORKTREES, cv.slug))) await convertMainCheckout(cv.main, { git: this.d.git, slug: cv.slug });
    this.settleConversion(j);
  }

  private settleConversion(j: MoveJournal): void {
    const cv = j.plan.convert;
    const c = this.d.store.state.robots[j.robotId];
    if (!cv || !c?.repo) return;
    const root = path.join(cv.main, WORKTREES, cv.slug);
    if (clean(c.repo.root) === clean(root) || !fs.existsSync(root)) return;
    this.d.store.update((d) => { d.robots[j.robotId] = converted(d.robots[j.robotId], c.repo!, cv.slug); });
  }

  // the worker takes the blobs' ids first, then the blobs, then prepares from them
  private async prepareThere(j: MoveJournal): Promise<void> {
    const link = this.d.links.for(j.to);
    if (!link) throw new ApiError('not_reachable', `${this.name(j.to)} is not reachable`);
    const stage = this.files.stage(j.id);
    const ids = blobIds(j.id);
    const bundle = j.manifest ? path.join(stage, 'bundle.tar') : undefined;
    const session = path.join(stage, 'session.tar');
    const blobs = { ...(bundle && { bundle: await fileSha(bundle) }), session: await fileSha(session) };
    await this.d.links.call(j.to, 'move.offer', { journal: j });
    if (bundle) await link.sendBlob(ids.bundle, bundle);
    await link.sendBlob(ids.session, session);
    await this.d.links.call(j.to, 'move.prepare', { id: j.id, blobs }, { timeoutMs: PREPARE_MS });
    fs.rmSync(stage, { recursive: true, force: true });
  }

  // before the commit: the worker removes what it prepared, the robot reopens here, and the move ends aborted; a worker
  // out of reach is told once it is back, and the journal waits for it
  private async abortOut(failed: MoveJournal, error: Error): Promise<void> {
    this.d.log.error(`move ${failed.id}: ${error.message}`);
    // what a rest that failed part way had stopped is on disk
    const j = this.readable(failed.id) ?? failed;
    const told = j.phase !== 'prepare' || await this.d.links.call<{ fingerprint?: string }>(j.to, 'move.abort', { id: j.id }).then((r) => {
      // a worktree the robot left there, taken back and left again, holds what it holds now
      if (r.fingerprint) this.d.store.update((d) => { const l = d.robots[j.robotId]?.left; if (l?.machine === j.to) l.fingerprint = r.fingerprint!; });
      return true;
    }, (e: Error) => {
      this.d.log.error(`move ${j.id}: ${this.name(j.to)} was not told to remove what it prepared: ${e.message}`);
      return false;
    });
    this.settleConversion(j);
    await this.reopen(j);
    fs.rmSync(this.files.stage(j.id), { recursive: true, force: true });
    if (told) this.enter({ ...j, error: error.message }, 'aborted');
    else this.save({ ...j, error: error.message });
  }

  // the terminals the rest closed open again where they were
  private async reopen(j: MoveJournal): Promise<void> {
    const id = j.robotId;
    this.d.store.update((d) => {
      const c = d.robots[id];
      if (!c) return;
      if (c.moving?.id === j.id) delete c.moving;
      delete c.restedBy;
      if (c.second) delete c.second.restedBy;
    });
    for (const t of j.rest?.stoppedTerminals ?? []) {
      await (t.term === 2 ? this.d.fleet.openSecond(id) : this.d.fleet.reviveRobot(id))
        .catch((e: Error) => this.d.log.error(`move ${j.id}: ${id} did not reopen: ${e.message}`));
    }
  }

  // ---- back: from a worker to this Mac

  private async back(j: MoveJournal): Promise<void> {
    try {
      if (j.phase === 'rest') {
        const r = await this.d.links.call<{ ok: boolean; error?: string }>(j.from, 'move.rest', { journal: j }, { timeoutMs: REST_MS });
        if (!r.ok) throw new Error(r.error ?? 'the rest failed');
        j = this.enter(j, 'bundle');
      }
      if (j.phase === 'bundle') j = this.enter(await this.bundleThere(j), 'prepare');
      if (j.phase === 'prepare') j = this.enter(await this.prepareHere(j), 'commit');
    } catch (e) {
      await this.abortBack(j, e as Error);
      throw e;
    }
    await this.finish(j);
  }

  // this Mac takes the blobs' ids first, then the worker builds and sends them
  private async bundleThere(j: MoveJournal): Promise<MoveJournal> {
    const link = this.d.links.for(j.from);
    if (!link) throw new ApiError('not_reachable', `${this.name(j.from)} is not reachable`);
    const stage = this.files.stage(j.id);
    fs.rmSync(stage, { recursive: true, force: true });
    fs.mkdirSync(stage, { recursive: true });
    const ids = blobIds(j.id);
    const repo = !!this.robot(j.robotId).repo;
    const receipts = Promise.all([
      repo ? link.receiveBlob(ids.bundle, path.join(stage, 'bundle.tar')) : undefined,
      link.receiveBlob(ids.session, path.join(stage, 'session.tar')),
    ]);
    receipts.catch(() => {});
    type Bundled = Pick<MoveJournal, 'manifest' | 'branchSha' | 'sessions' | 'rest'> & { robot: Robot; blobs: { bundle?: string; session: string } };
    const r = await this.d.links.call<Bundled>(j.from, 'move.bundle', { id: j.id }, { timeoutMs: REST_MS });
    const [bundle, session] = await receipts;
    if (bundle?.sha256 !== r.blobs.bundle || session.sha256 !== r.blobs.session) throw new Error(`the files of move ${j.id} did not arrive as they left`);
    // what the worker's rest stopped is what opens here
    return MoveJournal.parse({ ...j, robot: r.robot, manifest: r.manifest, branchSha: r.branchSha, sessions: r.sessions ?? [], rest: r.rest });
  }

  // the worktree the robot left here, as it was then, takes what comes back: reset to its base, cleaned, applied, once
  // all that comes is checked
  private async prepareHere(j: MoveJournal): Promise<MoveJournal> {
    const c = this.robot(j.robotId);
    const stage = this.files.stage(j.id);
    const { left } = c;
    const m = j.manifest;
    const [dir, sessions] = [path.join(stage, 'bundle'), path.join(stage, 'session')];
    const run = this.d.cli ?? cliRunner();
    if (left && !m) throw new Error(`${c.name} comes back without the worktree it left`);
    if (left && m) {
      const changed = await changedSince(left, 'on this Mac', this.d.git);
      if (changed) throw refused(changed);
      await unpack(path.join(stage, 'bundle.tar'), dir);
      await verifyBundle(dir, m);
    }
    await unpack(path.join(stage, 'session.tar'), sessions);
    await checkSessions(j.sessions ?? [], sessions, j.plan.paths, run, 'on this Mac');
    if (left && m) {
      j = { ...j, made: { unlocked: true } };
      this.save(j);
      await takeBack(left.path, left.branchSha, this.d.git);
      await applyBundle(left.path, dir, m, this.d.git);
    }
    placeSessions(j.sessions ?? [], sessions);
    await importSessions(j.sessions ?? [], sessions, j.plan.paths, path.join(this.files.dir, 'held'), run);
    fs.rmSync(stage, { recursive: true, force: true });
    return j;
  }

  // before the commit: a worktree here this return took back is left as the robot left it and locked again, and the
  // worker reopens the robot where it was; a worker out of reach is told once it is back. A step that fails is logged,
  // and the rest still run
  private async abortBack(failed: MoveJournal, error: Error): Promise<void> {
    this.d.log.error(`move ${failed.id}: ${error.message}`);
    const j = this.readable(failed.id) ?? failed;
    const left = this.d.store.state.robots[j.robotId]?.left;
    if (left && j.made?.unlocked) {
      await leaveAgain(left.path, left.branchSha, `moved to ${this.name(j.from)} ${left.moveId}`, this.d.git).then(
        (fingerprint) => this.d.store.update((d) => { d.robots[j.robotId].left = { ...left, fingerprint }; }),
        (e: Error) => this.d.log.error(`move ${j.id}: ${left.path} was not locked again: ${e.message}`),
      );
    }
    const told = await this.d.links.call(j.from, 'move.abort', { id: j.id }).then(() => true, (e: Error) => {
      this.d.log.error(`move ${j.id}: ${this.name(j.from)} was not told to reopen ${j.robotId}: ${e.message}`);
      return false;
    });
    fs.rmSync(this.files.stage(j.id), { recursive: true, force: true });
    this.d.store.update((d) => { if (d.robots[j.robotId]?.moving?.id === j.id) delete d.robots[j.robotId].moving; });
    if (told) this.enter({ ...j, error: error.message }, 'aborted');
    else this.save({ ...j, error: error.message });
  }

  // the robot's record on the way back: its paths on this Mac, read back from the worker's by the homes of both
  private async checkReturn(c: Robot, o: StartOptions): Promise<CheckResult> {
    const from = c.machine;
    if (!from || from === this.d.me) throw new Invalid(`${c.name} runs on this Mac`);
    const fail = (f: Failure): CheckResult => ({ ok: false, refusal: { ...f, details: [] } });
    const link = this.d.links.for(from);
    const hello = link?.connected() ? link.hello() : undefined;
    if (!hello) return fail({ reason: `${this.name(from)} is not reachable`, action: 'try again when it is awake' });
    if (c.moving) return fail({ reason: `moving to ${this.name(c.moving.to)}`, action: 'wait for the move to finish' });
    if (c.repo && !c.left) throw new Invalid(`${c.name} left no worktree on this Mac to come back to`);
    if (c.left) {
      const changed = await changedSince(c.left, 'on this Mac', this.d.git);
      if (changed) return fail(changed);
    }
    const plan = await this.returnPlan(c, from, hello, o.interruptAfterMs ?? (c.agent?.status === 'blocked' ? 0 : undefined));
    const carried = await this.d.links.call<Carried | { refusal: Failure }>(from, 'move.sheet', { robotId: c.id, have: plan.have })
      .catch((e: Error) => ({ refusal: { reason: e.message, action: 'try again when it is awake' } }));
    if ('refusal' in carried) return fail(carried.refusal);
    const sheet: MoveSheet = {
      ...carried, branch: c.repo?.branch ?? '', clone: 'warm', credentialFiles: [], stays: [],
      interrupts: plan.interruptAfterMs !== undefined, question: c.agent?.status === 'blocked', notInRepo: !c.repo,
    };
    return { ok: true, sheet, plan };
  }

  private async returnPlan(c: Robot, from: MachineId, hello: WorkerHello, interruptAfterMs: number | undefined): Promise<MovePlan> {
    const info = await this.d.links.call<SystemInfo>(from, 'system.info', {});
    const homes = homesOf(hello.home, this.d.homedir, info.agentAdapters, await this.d.agents());
    const main = c.repo ? relocate(c.repo.mainRoot, homes.user) : '';
    const paths = destinationPaths(c, main, homes);
    if (c.left && clean(paths.root) !== clean(c.left.path)) throw new Error(`${c.name} would come back to ${paths.root}, not to ${c.left.path} where it left from`);
    const have = c.left ? [...new Set((await must(this.d.git, ['for-each-ref', '--format=%(objectname)'], c.left.path)).split('\n').filter(Boolean))] : [];
    return { clone: main, paths, have, carry: [], ...(interruptAfterMs !== undefined && { interruptAfterMs }) };
  }

  // ---- from the commit on, both ways

  private async finish(j: MoveJournal): Promise<void> {
    const back = j.to === this.d.me;
    try {
      if (j.phase === 'commit') {
        this.commit(j);
        j = this.enter(j, 'activate');
      }
      if (j.phase === 'activate') {
        const error = back ? await this.activateHere(j) : await this.activateThere(j);
        if (error !== undefined) return this.stall(j, error);
        j = this.enter(j, 'release');
      }
      if (j.phase === 'release' && await this.release(j)) this.enter(j, 'done');
    } catch (e) {
      this.stall(j, (e as Error).message);
      throw e;
    }
  }

  // the robot is the destination's: where it runs, at the next generation, its paths there and what it left
  private commit(j: MoveJournal): void {
    const back = j.to === this.d.me;
    const c = this.robot(j.robotId);
    if (c.placement?.generation !== j.generation || (c.machine ?? this.d.me) !== j.to) {
      boundary('move.commit.state', () => this.d.store.update((d) => {
        const cur = d.robots[j.robotId];
        // the robot's own fields as its rest left them, everything else as this Mac holds it
        const base: Record<string, unknown> = { ...cur };
        const owned = j.robot ?? cur;
        for (const k of WORKER_OWNED) { if (owned[k] === undefined) delete base[k]; else base[k] = structuredClone(owned[k]); }
        const next = landed(base as Robot, j, back ? undefined : j.to);
        next.moving = { id: j.id, to: j.to, phase: 'commit' };
        delete next.left;
        // the worktree the robot leaves, which a move back to that machine takes it back into
        const root = j.robot?.repo?.root;
        if (root && j.manifest && j.branchSha) {
          next.left = { moveId: j.id, machine: j.from, path: root, branch: j.manifest.branch, branchSha: j.branchSha, fingerprint: j.manifest.fingerprint };
        }
        d.robots[j.robotId] = next;
      }));
    }
    if (!this.d.store.flush()) throw new Error('state.json was not written');
  }

  // the worker holds this Mac's record of the move before it is asked to start the robot: a snapshot built after the
  // commit, which a worker linked but not yet synced takes once it is
  private async snapshotTaken(machine: MachineId): Promise<void> {
    const link = this.d.links.for(machine);
    if (!link?.connected()) throw new ApiError('not_reachable', `${this.name(machine)} is not reachable`);
    let timer: NodeJS.Timeout | undefined;
    const late = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${this.name(machine)} did not take this Mac's record of the move within ${SNAPSHOT_MS / 1000} s; retry`)), SNAPSHOT_MS);
    });
    try { await Promise.race([this.d.links.pushSnapshot().then((v) => link.took(v)), late]); } finally { clearTimeout(timer); }
  }

  // the worker says how far it got, and starts the robot unless it has
  private async activateThere(j: MoveJournal): Promise<string | undefined> {
    try {
      await this.snapshotTaken(j.to);
      const s = await this.d.links.call<{ phase: string }>(j.to, 'move.state', { id: j.id });
      if (s.phase === 'done') return undefined;
      if (s.phase !== 'commit' && s.phase !== 'activate') return `${this.name(j.to)} holds nothing prepared for move ${j.id}`;
      const r = await this.d.links.call<{ ok: boolean; error?: string }>(j.to, 'move.activate', { id: j.id }, { timeoutMs: (this.d.watchMs ?? WATCH_MS) + 60_000 });
      return r.ok ? undefined : r.error ?? 'the robot did not start';
    } catch (e) {
      return (e as Error).message;
    }
  }

  // the robot is this Mac's from the commit on; the worker takes the snapshot that says so whenever it is linked
  private activateHere(j: MoveJournal): Promise<string | undefined> {
    const { store, fleet, tmux, log } = this.d;
    return wake({ store, fleet, tmux, log, watchMs: this.d.watchMs ?? WATCH_MS }, j);
  }

  // the worktree the robot left is locked with the move's id. The robot runs at its destination from here on, so a worker
  // out of reach locks its worktree once it is back
  private async release(j: MoveJournal): Promise<boolean> {
    const root = j.robot?.repo?.root;
    if (j.to !== this.d.me) {
      if (root) await boundary('move.release.lock', () => lockWorktree(root, `moved to ${this.name(j.to)} ${j.id}`, this.d.git));
      return true;
    }
    this.d.store.update((d) => { if (d.robots[j.robotId]?.moving?.id === j.id) delete d.robots[j.robotId].moving; });
    try {
      await this.d.links.call(j.from, 'move.release', { id: j.id });
      return true;
    } catch (e) {
      this.save({ ...j, error: `${this.name(j.from)} has not locked its worktree yet: ${(e as Error).message}` });
      return false;
    }
  }
}
