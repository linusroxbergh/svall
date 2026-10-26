import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { ApiError, LeftBehind, MoveId, ObjectName, Sha256, type AgentKind, type FleetId, type MachineId } from '@svall/protocol';
import { processes as allProcesses, runsAgent } from '../dormancy.js';
import type { Fleet } from '../fleet.js';
import { boundary } from '../failpoints.js';
import { clean, realPath } from '../path-tools.js';
import type { RestDeps } from './rest.js';
import { cliRunner, type AgentProber } from '../sessions/registry.js';
import type { CliRun } from '../sessions/types.js';
import type { HomeConnection } from '../link/worker.js';
import { cloneGit, must, type GitRunner } from '../links/git.js';
import type { Logger } from '../log.js';
import type { Paths } from '../paths.js';
import type { Store } from '../store.js';
import type { Tmux } from '../tmux/tmux.js';
import { applyBundle, branchAhead, holdsWhole, verifyBundle } from './bundle.js';
import { carriedFrom } from './checks.js';
import {
  blobIds, changedSince, checkSessions, fileSha, importSessions, landed, leaveAgain, liveTerminals, lockWorktree, MoveFiles, MoveJournal, packMove, placeSessions, refused, restRobot, takeBack, unpack, wake,
  type ReturnSheet,
} from './move.js';
import { seedTrust } from './trust.js';

const WATCH_MS = 60_000;

export type PrepareDeps = {
  store: Store;
  fleet: Pick<Fleet, 'reviveRobot' | 'openSecond' | 'onSessionStart'>;
  tmux: RestDeps['tmux'] & Pick<Tmux, 'screen' | 'sendBytes'>;
  viewers: RestDeps['viewers'];
  connection: Pick<HomeConnection, 'sendBlob' | 'receiveBlob'>;
  me: MachineId;
  fleetId: FleetId;
  /** The home's name, as worker.json gives it. */
  homeName: string;
  paths: Pick<Paths, 'moves'>;
  git: GitRunner;
  cloneGit?: GitRunner;
  /** This machine's agent CLIs, whose config folders trust is seeded in. */
  agents: AgentProber;
  processes?: RestDeps['processes'];
  kill?: RestDeps['kill'];
  clock?: RestDeps['clock'];
  agentRunning?: (kind: AgentKind) => Promise<boolean>;
  log: Logger;
  moves?: MoveFiles;
  watchMs?: number;
  /** Runs an agent CLI that keeps its sessions in a database of its own. */
  cli?: CliRun;
};

type Handlers = Record<string, (params: unknown) => Promise<unknown>>;

const ById = z.object({ id: MoveId });
const WithJournal = z.object({ journal: MoveJournal });
const Prepare = z.object({ id: MoveId, blobs: z.object({ bundle: Sha256.optional(), session: Sha256 }) });
const Compare = z.object({ left: LeftBehind });
// branch: the home's branch of the robot's branch's name, which the way back would reset
const Sheet = z.object({ robotId: z.string(), have: z.array(z.string()), branch: z.object({ name: z.string(), sha: ObjectName }).optional() });

type Made = NonNullable<MoveJournal['made']>;

const parse = <T>(schema: z.ZodType<T>, raw: unknown): T => {
  const p = schema.safeParse(raw);
  if (!p.success) throw new ApiError('invalid_params', z.prettifyError(p.error));
  return p.data;
};

// the worktree that has `branch` checked out in the repository at `repo`, if one has
async function holding(repo: string, branch: string, git: GitRunner): Promise<string | undefined> {
  const entries = (await must(git, ['worktree', 'list', '--porcelain'], repo)).split('\n\n');
  const entry = entries.find((e) => e.split('\n').includes(`branch refs/heads/${branch}`));
  return entry?.split('\n')[0].slice('worktree '.length);
}

/**
 * A worker's side of every move: it takes a robot into a worktree of its clone and starts it once the home has
 * committed, or rests and bundles one of its own for the way back. What it does is journaled per move, as the home's is.
 */
export class PrepareService {
  readonly handlers: Handlers;
  private files: MoveFiles;
  private locks = new Map<string, Promise<void>>();
  private receipts = new Map<string, Promise<[{ sha256: string } | undefined, { sha256: string }]>>();
  private busy = new Map<string, Promise<unknown>>();

  constructor(private d: PrepareDeps) {
    this.files = d.moves ?? new MoveFiles(d.paths.moves);
    // each call about one move waits for the one before it
    const byId = (run: (id: string) => Promise<unknown>) => (raw: unknown) => { const { id } = parse(ById, raw); return this.serial(id, () => run(id)); };
    const byJournal = (run: (j: MoveJournal) => Promise<unknown>) => (raw: unknown) => { const { journal } = parse(WithJournal, raw); return this.serial(journal.id, () => run(journal)); };
    this.handlers = {
      'move.offer': byJournal((j) => this.offer(j)),
      'move.prepare': (raw) => { const p = parse(Prepare, raw); return this.serial(p.id, () => this.prepare(p.id, p.blobs)); },
      'move.activate': byId((id) => this.activate(id)),
      'move.abort': byId((id) => this.abort(id)),
      'move.state': async (raw) => {
        const j = this.files.read(parse(ById, raw).id);
        return { phase: j?.phase ?? 'none', ...(j?.error && { error: j.error }) };
      },
      'move.rest': byJournal((j) => this.rest(j)),
      'move.bundle': byId((id) => this.bundle(id)),
      'move.release': byId((id) => this.release(id)),
      // what a robot of this machine's carries to the home, which holds `have`, and what its terminals here are doing
      'move.sheet': async (raw): Promise<ReturnSheet | { refusal: unknown }> => {
        const { robotId, have, branch } = parse(Sheet, raw);
        const c = this.d.store.state.robots[robotId];
        if (c?.machine !== this.d.me) throw new ApiError('invalid', `${c?.name ?? robotId} does not run on ${this.name}`);
        if (c.repo && branch) {
          const on = (await this.d.git(['symbolic-ref', '-q', '--short', 'HEAD'], c.repo.root)).stdout.trim();
          if (on === branch.name && !await holdsWhole(branch.sha, 'HEAD', c.repo.root, this.d.git)) return { refusal: branchAhead('this Mac', branch.name) };
        }
        const carried = await carriedFrom(c, have, this.d.git, this.d.cli ?? cliRunner());
        if ('refusal' in carried) return carried;
        const terminals = (await liveTerminals(this.d)).filter((t) => t.robotId === robotId).map((t) => ({ ...(t.term && { term: t.term }), class: t.class }));
        return { ...carried, terminals };
      },
      // what moved in the worktree a robot left here since it left
      'move.compare': async (raw) => {
        const { left } = parse(Compare, raw);
        const refusal = fs.existsSync(left.path) ? await changedSince(left, `on ${this.name}`, this.d.git) : undefined;
        return refusal ? { refusal } : {};
      },
    };
  }

  // one call at a time for each move
  private serial<T>(id: string, work: () => Promise<T>): Promise<T> {
    const p = (this.busy.get(id) ?? Promise.resolve()).catch(() => {}).then(work);
    const tail = p.catch(() => {});
    this.busy.set(id, tail);
    void tail.then(() => { if (this.busy.get(id) === tail) this.busy.delete(id); });
    return p;
  }

  // one move at a time in each clone, so two moves into one serialize
  private async repoLock<T>(clone: string, step: () => Promise<T>): Promise<T> {
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

  private journal(id: string): MoveJournal {
    const j = this.files.read(id);
    if (!j) throw new ApiError('not_found', `no move ${id} here`);
    return j;
  }

  private save(j: MoveJournal): void {
    this.files.write({ ...j, updatedAt: Date.now() });
  }

  private get name(): string {
    return this.d.store.state.machines?.[this.d.me]?.name ?? 'this machine';
  }

  // ---- a robot coming here

  // the blobs' ids are taken before the home sends a byte of them
  private async offer(j: MoveJournal): Promise<{ ready: true }> {
    const held = this.files.read(j.id);
    if (held && held.phase !== 'prepare') throw new ApiError('invalid', `move ${j.id} is ${held.phase} on ${this.name}`);
    this.save({ ...j, phase: 'prepare' });
    const stage = this.files.stage(j.id);
    fs.rmSync(stage, { recursive: true, force: true });
    fs.mkdirSync(stage, { recursive: true });
    const ids = blobIds(j.id);
    const receipts = Promise.all([
      j.manifest ? this.d.connection.receiveBlob(ids.bundle, path.join(stage, 'bundle.tar')) : undefined,
      this.d.connection.receiveBlob(ids.session, path.join(stage, 'session.tar')),
    ]);
    receipts.catch(() => {});
    this.receipts.set(j.id, receipts);
    return { ready: true };
  }

  private async prepare(id: string, blobs: z.infer<typeof Prepare>['blobs']): Promise<{ prepared: true; paths: MoveJournal['plan']['paths'] }> {
    const j = this.journal(id);
    if (j.phase !== 'prepare') throw new ApiError('invalid', `move ${id} is ${j.phase} on ${this.name}`);
    const receipts = this.receipts.get(id);
    this.receipts.delete(id);
    if (!receipts) throw new Error(`the files of move ${id} did not come to ${this.name}`);
    const [bundle, session] = await receipts;
    if (bundle?.sha256 !== blobs.bundle || session.sha256 !== blobs.session) throw new Error(`the files of move ${id} did not arrive as they left`);
    const stage = this.files.stage(id);
    const run = this.d.cli ?? cliRunner();
    return this.repoLock(j.plan.clone, async () => {
      let cur = j;
      const made = (m: Made): void => { cur = { ...cur, made: { ...cur.made, ...m } }; this.save(cur); };
      const m = j.manifest;
      const { clone, paths } = j.plan;
      await unpack(path.join(stage, 'session.tar'), path.join(stage, 'session'));
      await checkSessions(j.sessions ?? [], path.join(stage, 'session'), paths, run, `on ${this.name}`);
      if (m) {
        const dir = path.join(stage, 'bundle');
        await unpack(path.join(stage, 'bundle.tar'), dir);
        await verifyBundle(dir, m);
        await boundary('worker.prepare.worktree', () => this.worktree(j, made));
        await boundary('worker.prepare.apply', async () => {
          made({ branch: (await this.d.git(['rev-parse', '--verify', '-q', `refs/heads/${m.branch}^{commit}`], clone)).stdout.trim() || null });
          const left = j.robot?.left;
          const keep = left?.machine === this.d.me && left.branch === m.branch ? left.branchSha : undefined;
          await applyBundle(paths.root, dir, m, this.d.git, { machine: this.name, ...(keep && { keep }) });
        });
      }
      boundary('worker.prepare.session', () => {
        made({ files: (j.sessions ?? []).flatMap((s) => s.files.map((f) => path.join(s.destinationHome!, f.path))).filter((f) => !fs.existsSync(f)) });
        placeSessions(j.sessions ?? [], path.join(stage, 'session'));
      });
      await importSessions(j.sessions ?? [], path.join(stage, 'session'), paths, path.join(this.files.dir, 'held'), run);
      // the robot is here at the move's generation, marked as this machine's own record until the commit's snapshot
      // replaces it, which keeps what this machine holds of it
      boundary('worker.prepare.journal', () => {
        this.d.store.update((d) => { if (j.robot) d.robots[j.robotId] = { ...landed(j.robot, j, this.d.me), moving: { id: j.id, to: this.d.me, phase: 'prepare' } }; });
        this.save({ ...cur, phase: 'commit' });
      });
      fs.rmSync(stage, { recursive: true, force: true });
      return { prepared: true as const, paths: j.plan.paths };
    });
  }

  // the clone, made from the remote when there is none, and a worktree in it at the plan's place: the one the robot left
  // here, unchanged since, or a new one, the branch let go of first
  private async worktree(j: MoveJournal, made: (m: Made) => void): Promise<void> {
    const { clone, remote, paths } = j.plan;
    const m = j.manifest!;
    const git = this.d.git;
    if (!fs.existsSync(clone)) {
      if (!remote) throw new Error(`${clone} is not on ${this.name}`);
      fs.mkdirSync(path.dirname(clone), { recursive: true });
      await must(this.d.cloneGit ?? cloneGit, ['clone', '-q', '--', remote, clone], path.dirname(clone));
    }
    const left = j.robot?.left;
    if (left?.machine === this.d.me && clean(left.path) === clean(paths.root) && fs.existsSync(paths.root)) {
      const changed = await changedSince(left, `on ${this.name}`, git);
      if (changed) throw refused(changed);
      made({ unlocked: true });
      return takeBack(paths.root, left.branchSha, git);
    }
    if (fs.existsSync(paths.root)) throw new Error(`${paths.root} on ${this.name} is in the way; move it out of the way there first`);
    const holder = await holding(clone, m.branch, git);
    if (holder) {
      const idle = holder === realPath(clone) && !(await must(git, ['status', '--porcelain', '--untracked-files=no'], clone)).trim();
      if (!idle) throw new Error(`${m.branch} is checked out in ${holder} on ${this.name}; check out another branch there first`);
      made({ detached: true });
      await must(git, ['checkout', '-q', '--detach'], clone);
    }
    // at a commit the clone holds; the bundle's commits and the branch come with its apply
    const start = m.commits ? m.commits.prerequisites[0] ?? 'HEAD' : m.base;
    made({ worktree: true });
    await must(git, ['worktree', 'add', '-q', '--detach', paths.root, start], clone);
  }

  // what the home's commit made this machine's: trust for the clone, the robot's terminals opened, its agent watched
  private async activate(id: string): Promise<{ ok: true } | { ok: false; error: string }> {
    const j = this.journal(id);
    if (j.phase === 'done') return { ok: true };
    if (j.phase !== 'commit' && j.phase !== 'activate') throw new ApiError('invalid', `move ${id} is ${j.phase} on ${this.name}`);
    const c = this.d.store.state.robots[j.robotId];
    if (c?.machine !== this.d.me || c.placement?.generation !== j.generation || c.moving?.phase === 'prepare') {
      return { ok: false, error: `${this.name} has not taken this Mac's record of the move yet; retry` };
    }
    if (j.phase === 'commit') this.save({ ...j, phase: 'activate' });
    const seeded = new Set<AgentKind>();
    if (j.plan.clone) {
      const probes = await this.d.agents();
      for (const kind of new Set([c.agent?.kind, c.second?.agent?.kind].filter((k) => k !== undefined))) {
        const agentHome = probes.find((p) => p.kind === kind)?.home;
        if (!agentHome) continue;
        const agentRunning = () => (this.d.agentRunning ?? running)(kind);
        const r = await boundary('worker.activate.trust', () => seedTrust(kind, j.plan.clone, { agentHome, agentRunning }))
          .catch((e: Error) => this.d.log.error(`move ${id}: trust for ${j.plan.clone} was not seeded: ${e.message}`));
        if (r === 'seeded') seeded.add(kind);
      }
    }
    const { store, fleet, tmux, log } = this.d;
    const trust = !!c.agent && !seeded.has(c.agent.kind);
    const error = await wake({ store, fleet, tmux, log, watchMs: this.d.watchMs ?? WATCH_MS, open: 'worker.activate.open', trust }, { ...j, phase: 'activate' });
    if (error !== undefined) {
      this.save({ ...j, phase: 'activate', error });
      return { ok: false, error };
    }
    this.save({ ...j, phase: 'done' });
    return { ok: true };
  }

  // before anything ran here: what this move made goes and what it changed is put back, and the robot's record goes; on
  // the way back the robot reopens here as it was. A worktree the robot left here is left again, with its fingerprint
  private async abort(id: string): Promise<{ fingerprint?: string }> {
    const j = this.files.read(id);
    if (!j) return {};
    if (j.phase === 'aborted') return j.fingerprint ? { fingerprint: j.fingerprint } : {};
    if (j.from === this.d.me) return this.reopen(j);
    if (j.phase === 'activate' || j.phase === 'done') throw new ApiError('invalid', `${j.robot?.name ?? j.robotId} already runs on ${this.name}`);
    this.receipts.delete(id);
    const fingerprint = await this.repoLock(j.plan.clone, () => boundary('worker.abort.remove', () => this.remove(j)));
    fs.rmSync(this.files.stage(id), { recursive: true, force: true });
    this.save({ ...j, phase: 'aborted', ...(fingerprint && { fingerprint }) });
    return fingerprint ? { fingerprint } : {};
  }

  private async remove(j: MoveJournal): Promise<string | undefined> {
    const { clone, paths } = j.plan;
    const { manifest: m, made = {} } = j;
    const left = j.robot?.left;
    const git = this.d.git;
    let fingerprint: string | undefined;
    if (m && made.unlocked && left) fingerprint = await leaveAgain(paths.root, left.branchSha, `moved to ${this.d.homeName} ${left.moveId}`, git);
    else if (m) {
      if (made.worktree && fs.existsSync(paths.root)) await must(git, ['worktree', 'remove', '--force', paths.root], clone);
      if (made.branch === null) {
        const there = await git(['rev-parse', '--verify', '-q', `refs/heads/${m.branch}`], clone);
        if (there.code === 0 && !(await holding(clone, m.branch, git))) await must(git, ['branch', '-q', '-D', m.branch], clone);
      } else if (made.branch) await must(git, ['update-ref', `refs/heads/${m.branch}`, made.branch], clone);
      if (made.detached) await must(git, ['checkout', '-q', m.branch], clone);
    }
    for (const f of made.files ?? []) fs.rmSync(f, { force: true });
    this.d.store.update((d) => {
      const c = d.robots[j.robotId];
      if (c?.machine === this.d.me && c.placement?.generation === j.generation) delete c.machine;
    });
    return fingerprint;
  }

  // ---- a robot going back to the home

  private async rest(j: MoveJournal): Promise<{ ok: true } | { ok: false; error: string }> {
    const held = this.files.read(j.id);
    if (held && held.phase !== 'rest') return { ok: true };
    const c = this.d.store.state.robots[j.robotId];
    if (c?.machine !== this.d.me) throw new ApiError('invalid', `${c?.name ?? j.robotId} does not run on ${this.name}`);
    this.save({ ...j, phase: 'rest' });
    const { store, tmux, viewers, processes, kill, clock } = this.d;
    const { interruptAfterMs } = j.plan;
    try {
      const rested = await restRobot({ store, tmux, viewers, ...(processes && { processes }), ...(kill && { kill }), ...(clock && { clock }) }, j, (x) => this.save(x), this.d.fleetId,
        interruptAfterMs === undefined ? {} : { interruptAfterMs, terminate: true });
      this.save({ ...rested, phase: 'bundle' });
      return { ok: true };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  }

  // the home has taken the blobs' ids; they go out ahead of the answer
  private async bundle(id: string): Promise<unknown> {
    const j = this.journal(id);
    if (j.phase !== 'bundle') throw new ApiError('invalid', `move ${id} is ${j.phase} on ${this.name}`);
    const c = structuredClone(this.d.store.state.robots[j.robotId]);
    const stage = this.files.stage(id);
    const packed = await packMove(c, j, stage, this.d.git, this.d.cli);
    const [bundle, session] = [path.join(stage, 'bundle.tar'), path.join(stage, 'session.tar')];
    const blobs = { ...(c.repo && { bundle: await fileSha(bundle) }), session: await fileSha(session) };
    const ids = blobIds(id);
    if (c.repo) await this.d.connection.sendBlob(ids.bundle, bundle);
    await this.d.connection.sendBlob(ids.session, session);
    this.save({ ...j, robot: c, ...packed, phase: 'release' });
    fs.rmSync(stage, { recursive: true, force: true });
    return { robot: c, ...packed, ...(j.rest && { rest: j.rest }), blobs };
  }

  private async release(id: string): Promise<Record<string, never>> {
    const j = this.journal(id);
    if (j.phase === 'done') return {};
    const root = j.robot?.repo?.root;
    if (root) await lockWorktree(root, `moved to ${this.d.homeName} ${id}`, this.d.git);
    this.save({ ...j, phase: 'done' });
    return {};
  }

  // the terminals this machine's rest closed open again, while the robot is still this machine's
  private async reopen(j: MoveJournal): Promise<Record<string, never>> {
    if (j.phase === 'done') throw new ApiError('invalid', `move ${j.id} is done on ${this.name}`);
    const c = this.d.store.state.robots[j.robotId];
    if (c?.machine === this.d.me) {
      for (const t of j.rest?.stoppedTerminals ?? []) {
        await (t.term === 2 ? this.d.fleet.openSecond(j.robotId, undefined, j.id) : this.d.fleet.reviveRobot(j.robotId, undefined, undefined, j.id))
          .catch((e: Error) => this.d.log.error(`move ${j.id}: ${j.robotId} did not reopen: ${e.message}`));
      }
    }
    fs.rmSync(this.files.stage(j.id), { recursive: true, force: true });
    this.save({ ...j, phase: 'aborted' });
    return {};
  }
}

// whether an agent of `kind` runs on this machine, which would write its config over a seed
const running = async (kind: AgentKind): Promise<boolean> => (await allProcesses()).some((p) => runsAgent(p.args, kind));
