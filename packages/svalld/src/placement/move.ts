import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { ApiError, MachineId, MoveId, MovePhase, Robot, WORKER_OWNED, type MoveSheet, type SystemInfo } from '@svall/protocol';
import { Invalid, NotFound } from '../errors.js';
import type { Fleet } from '../fleet.js';
import { boundary, type Failpoint } from '../failpoints.js';
import { clean } from '../path-tools.js';
import { relocate } from './relocate.js';
import type { Classified, RestChoices, RestDeps } from './rest.js';
import { cliRunner, type AgentProber } from '../sessions/registry.js';
import type { CliRun } from '../sessions/types.js';
import type { HomeLinks, WorkerHello } from '../link/home.js';
import { must, type GitRunner } from '../links/git.js';
import type { Logger } from '../log.js';
import type { Paths } from '../paths.js';
import type { Store } from '../store.js';
import type { Tmux } from '../tmux/tmux.js';
import { applyBundle, fileSha, verifyBundle } from './bundle.js';
import { converted, homesOf, MovePlan, moveChecks, reach, refusalOf, restCheck, type CheckDeps, type CheckResult } from './checks.js';
import { convertMainCheckout, WORKTREES } from './convert.js';
import { destinationPaths } from './paths.js';
import {
  blobIds, changedSince, checkSessions, importSessions, landed, leaveAgain, liveTerminals, lockWorktree, MoveFiles, MoveJournal, packMove, placeSessions, refused,
  restRobot, serversLeft, takeBack, unpack, wake, type Failure, type RestSide, type ReturnSheet,
} from './move-steps.js';

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
const SHEET_MS = 30_000;
const RELINK_MS = 60_000;

// a worker that gives no sheet: too slow, on a release without one, or out of reach
const sheetRefusal = (e: Error, name: string): Failure => {
  const code = e instanceof ApiError ? e.code : undefined;
  if (code === 'timeout') return { reason: `${name} did not answer the move sheet in ${SHEET_MS / 1000} s`, action: 'try again' };
  if (code === 'unknown_method') return { reason: `${name} runs a release without move.sheet`, action: 'upgrade it under Machines' };
  return { reason: e.message, action: 'try again when it is awake' };
};

// a move undone before its commit rejects with the phase it failed at, which the move sheet names
const failedAt = (e: Error & { data?: Record<string, unknown> }, j: MoveJournal): Error => Object.assign(e, { data: { ...e.data, moveId: j.id, phase: j.phase } });

const newMoveId = (): string => `mv_${[...crypto.randomBytes(10)].map((b) => (b % 36).toString(36)).join('')}`;

export type StartOptions = { interruptAfterMs?: number; carry?: string[]; ownWorktree?: boolean };

export type PlacementDeps = {
  store: Store;
  fleet: Pick<Fleet, 'reviveRobot' | 'openSecond' | 'onSessionStart'>;
  links: Pick<HomeLinks, 'for' | 'call' | 'pushSnapshot' | 'pushMirror' | 'mirrorSettled'>;
  me: MachineId;
  paths: Pick<Paths, 'moves'>;
  git: GitRunner;
  agents: AgentProber;
  release: string;
  homedir: string;
  tmux: RestDeps['tmux'] & Pick<Tmux, 'screen' | 'sendBytes'>;
  viewers: RestDeps['viewers'];
  processes?: RestDeps['processes'];
  kill?: RestDeps['kill'];
  clock?: RestDeps['clock'];
  log: Logger;
  moves?: MoveFiles;
  watchMs?: number;
  /** Runs an agent CLI that keeps its sessions in a database of its own. */
  cli?: CliRun;
};

/**
 * The home's side of every move, each phase journaled before it runs. Before the commit a failure reopens the robot where it
 * was; from the commit on the robot is the destination's, and a crash resumes from the journal.
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
    const { store, me, links, git, agents, release, homedir, cli } = this.d;
    return { store, me, links, git, agents, release, homedir, terminals: () => this.terminals(), ...(cli && { cli }) };
  }

  private terminals(): Promise<Classified[]> {
    return liveTerminals(this.d);
  }

  private restDeps(): RestSide {
    const { store, tmux, viewers, processes, kill, clock } = this.d;
    return { store, tmux, viewers, ...(processes && { processes }), ...(kill && { kill }), ...(clock && { clock }) };
  }

  // ---- out: from this Mac to a worker

  private async out(j: MoveJournal): Promise<void> {
    try {
      if (j.phase === 'rest') {
        const { interruptAfterMs } = j.plan;
        // what a sheet's choice to interrupt or move anyway covers: an agent's turn and a command holding a shell
        const choices: RestChoices = interruptAfterMs === undefined ? {} : { interruptAfterMs, terminate: true };
        j = this.enter(await restRobot(this.restDeps(), j, (x) => this.save(x), choices), 'bundle');
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
      throw failedAt(e as Error, j);
    }
    await this.finish(j);
  }

  // a main checkout becomes the robot's worktree once, and the robot moves into it, whatever the move does next
  private async convert(j: MoveJournal): Promise<void> {
    const cv = j.plan.convert;
    if (!cv) return;
    if (!fs.existsSync(path.join(cv.main, WORKTREES, cv.slug))) await convertMainCheckout(cv.main, { git: this.d.git, slug: cv.slug, head: cv.head });
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

  // the worker takes the blobs' ids first, then the blobs, then prepares from them; a link that dropped since the checks,
  // as one to a worker too busy writing to answer a ping, is waited for
  private async prepareThere(j: MoveJournal): Promise<void> {
    const link = this.d.links.for(j.to);
    const relinking = !link?.synced;
    if (!link || !(await link.linked(RELINK_MS))) throw new ApiError('not_reachable', `${this.name(j.to)} is not reachable`);
    // a link that came back pushes the agent configuration without waiting; the move waits for that push to end
    if (relinking) await this.d.links.mirrorSettled(j.to);
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
    await serversLeft(this.restDeps(), j, (x) => this.save(x));
    this.d.store.update((d) => {
      const c = d.robots[id];
      if (!c) return;
      if (c.moving?.id === j.id) delete c.moving;
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
      throw failedAt(e as Error, j);
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
      await applyBundle(left.path, dir, m, this.d.git, { machine: 'this Mac', ...(left.branch === m.branch && { keep: left.branchSha }) });
    }
    placeSessions(j.sessions ?? [], sessions);
    await importSessions(j.sessions ?? [], sessions, j.plan.paths, path.join(this.files.dir, 'held'), run);
    fs.rmSync(stage, { recursive: true, force: true });
    return j;
  }

  // before the commit: a worktree this return took back is locked again as the robot left it, and the worker reopens the
  // robot, told once it is back if out of reach; a step that fails is logged and the rest still run
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
    const reached = reach(this.d.links.for(from), this.name(from), this.d.release);
    if ('failure' in reached) return fail(reached.failure);
    const { hello } = reached;
    if (c.moving) return fail({ reason: `moving to ${this.name(c.moving.to)}`, action: 'wait for the move to finish' });
    if (c.repo && !c.left) throw new Invalid(`${c.name} left no worktree on this Mac to come back to`);
    if (c.left) {
      const changed = await changedSince(c.left, 'on this Mac', this.d.git);
      if (changed) return fail(changed);
    }
    const plan = await this.returnPlan(c, from, hello);
    // this Mac's branch of the robot's branch's name, which the way back would reset, but the one it left here, compared above
    const name = c.repo?.branch;
    const sha = name && c.left && c.left.branch !== name ? (await this.d.git(['rev-parse', '--verify', '-q', `refs/heads/${name}^{commit}`], c.left.path)).stdout.trim() : '';
    const branch = sha ? { name: name!, sha } : undefined;
    const answer = await this.d.links.call<ReturnSheet | { refusal: Failure }>(from, 'move.sheet', { robotId: c.id, have: plan.have, ...(branch && { branch }) }, { timeoutMs: SHEET_MS })
      .catch((e: Error) => ({ refusal: sheetRefusal(e, this.name(from)) }));
    if ('refusal' in answer) return fail(answer.refusal);
    const { terminals, ...carried } = answer;
    // 7, over the robot's terminals there
    const rest = restCheck(c.name, terminals, o.interruptAfterMs !== undefined);
    if (rest.failures.length) return { ok: false, refusal: refusalOf(rest.failures) };
    // a question is cut at once: the agent resumes idle and asks again
    const interruptAfterMs = o.interruptAfterMs ?? (rest.question ? 0 : undefined);
    const sheet: MoveSheet = {
      ...carried, branch: c.repo?.branch ?? '', clone: 'warm', credentialFiles: [], stays: [],
      interrupts: rest.interrupts, question: rest.question, notInRepo: !c.repo,
    };
    return { ok: true, sheet, plan: { ...plan, ...(interruptAfterMs !== undefined && { interruptAfterMs }) } };
  }

  private async returnPlan(c: Robot, from: MachineId, hello: WorkerHello): Promise<MovePlan> {
    const info = await this.d.links.call<SystemInfo>(from, 'system.info', {});
    const homes = homesOf(hello.home, this.d.homedir, info.agentAdapters, await this.d.agents());
    const main = c.repo ? relocate(c.repo.mainRoot, homes.user) : '';
    const paths = destinationPaths(c, main, homes);
    if (c.left && clean(paths.root) !== clean(c.left.path)) throw new Error(`${c.name} would come back to ${paths.root}, not to ${c.left.path} where it left from`);
    const have = c.left ? [...new Set((await must(this.d.git, ['for-each-ref', '--format=%(objectname)'], c.left.path)).split('\n').filter(Boolean))] : [];
    return { clone: main, paths, have, carry: [] };
  }

  // ---- from the commit on, both ways

  private async finish(j: MoveJournal): Promise<void> {
    const back = j.to === this.d.me;
    try {
      if (j.phase === 'commit') {
        await this.commit(j);
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
  private async commit(j: MoveJournal): Promise<void> {
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
    if (!(await this.d.store.flush())) throw new Error('state.json was not written');
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
