import os from 'node:os';
import { z } from 'zod';
import { ApiError, Column, methods, serverWait, type MachineId, type MethodName, type Params, type ParsedParams, type ResourceSource, type Result, type Robot } from '@svall/protocol';
import { repoRootOf } from '../docs.js';
import { loseSecond, markDormant } from '../dormancy.js';
import type { Fleet } from '../fleet.js';
import type { HomeLinks } from '../link/home.js';
import type { HomeConnection } from '../link/worker.js';
import { handoverGit } from '../links/git.js';
import type { Logger } from '../log.js';
import { FarPass, type Only } from '../scribe/scribe.js';
import type { Store } from '../store.js';
import type { TerminalHub } from '../terminals.js';
import { applyReport, type Inventory } from '../worker/snapshot.js';
import type { Workspace } from '../workspace/workspace.js';
import { probeRepo, RepoProbeParams } from './checks.js';
import type { FarViewers } from './far-viewers.js';
import { sharesBranch, withLine, type Replay } from './replay.js';
import { homeRootOf } from './repo-key.js';

// a call over the link waits as a client's call to the daemon does: the call's own wait, and 30 s beside it
const callMs = (method: MethodName, params: unknown): number => 30_000 + serverWait(method, params);
const SCRIBE_MS = 10 * 60_000;
const ScribeRun = z.object({ id: z.string(), only: z.enum(['names', 'columns']).optional(), columns: z.array(Column).optional(), sweep: z.literal(true).optional() });

type Options = {
  store: Store;
  me: MachineId;
  log: Logger;
  /** On the home: its links to the workers. */
  links?: Pick<HomeLinks, 'call'>;
  /** On a worker: the home worker.json names, and the link to it. */
  home?: { id: MachineId; connection: Pick<HomeConnection, 'call' | 'connected'> };
  /** On the home: the robots each worker's replay started, and the user folder a worker's paths are compared in. */
  replay?: Pick<Replay, 'created'>;
  homedir?: string;
};

/** Which machine answers a call about a robot: the one it runs on. */
export class Router {
  constructor(private o: Options) {}

  /** Whether this daemon serves its home's fleet as a worker. */
  get onWorker(): boolean {
    return this.o.home !== undefined;
  }

  get me(): MachineId {
    return this.o.me;
  }

  /** On a worker, the home it serves. */
  get homeId(): MachineId | undefined {
    return this.o.home?.id;
  }

  /** On a worker, whether its home is linked; the home is its own. */
  get homeConnected(): boolean {
    return this.o.home?.connection.connected() ?? true;
  }

  /** Whether a robot runs on this machine; one that names none runs on the home. */
  runsHere(c: Pick<Robot, 'machine'>): boolean {
    return (c.machine ?? this.o.home?.id ?? this.o.me) === this.o.me;
  }

  /** The machine a robot runs on, when that is another one. */
  placedAt(robotId: string): MachineId | undefined {
    const { robots } = this.o.store.state;
    if (!Object.hasOwn(robots, robotId) || this.runsHere(robots[robotId])) return undefined;
    return robots[robotId].machine ?? this.o.home?.id;
  }

  /** The machine a workspace id's folder is on, when that is another one: a robot's, or the clone robots placed there work in. */
  rootPlacedAt(id: string): MachineId | undefined {
    if (!id.startsWith('r:')) return this.placedAt(id);
    const working = Object.values(this.o.store.state.robots).filter((c) => repoRootOf(c) === id.slice(2));
    // a folder a robot here works in is this machine's
    return working.some((c) => this.runsHere(c)) || !working.length ? undefined : this.placedAt(working[0].id);
  }

  /** The answer of the machine a workspace id's folder is on to a call about it; undefined for a folder here. */
  forwardRoot<M extends MethodName>(id: string, method: M, params: Params<M>): Promise<Result<M>> | undefined {
    const at = this.rootPlacedAt(id);
    if (!at || !this.o.links) return undefined;
    return this.o.links.call<Result<M>>(at, method, params, { timeoutMs: callMs(method, params) });
  }

  /** On the home, the user folder a worker's paths are named from here. */
  get homedir(): string | undefined {
    return this.o.homedir;
  }

  /** The answer of the machine a robot runs on to a call about it; undefined for a robot here. */
  forward<M extends MethodName>(robotId: string, method: M, params: Params<M>, signal?: AbortSignal): Promise<Result<M>> | undefined {
    const at = this.placedAt(robotId);
    if (!at) return undefined;
    // a worker is linked to its home alone, which sends the call on
    if (!this.o.links) return this.toHome(method, params, signal) as Promise<Result<M>>;
    return this.o.links.call<Result<M>>(at, method, params, { timeoutMs: callMs(method, params), signal });
  }

  /** On the home: the scribe's pass over a placed robot's transcript, made on its machine; undefined when that machine made none. */
  async scribe(id: string, only?: Only, columns?: Column[], sweep?: true): Promise<FarPass | undefined> {
    const at = this.placedAt(id);
    if (!at || !this.o.links) return undefined;
    const raw = await this.o.links.call(at, 'scribe.run', { id, only, columns, sweep }, { timeoutMs: SCRIBE_MS }).catch((e: unknown) => {
      const cause = e instanceof ApiError ? e.data?.cause : undefined;
      throw typeof cause === 'string' ? new Error((e as ApiError).message, { cause }) : e;
    });
    // a pass skipped there, and an answer this Mac cannot read, wait for the robot's next turn
    const r = FarPass.safeParse(raw);
    return r.success ? r.data : undefined;
  }

  /** A worker's call to its home, refused while the home cannot be reached. */
  async toHome(method: MethodName, params: unknown, signal?: AbortSignal): Promise<unknown> {
    const { home } = this.o;
    if (!home) throw new Error(`${method}: this daemon is the home`);
    try {
      return await home.connection.call(method, params, { timeoutMs: callMs(method, params), signal });
    } catch (e) {
      throw e instanceof ApiError && e.code === 'not_reachable' && !home.connection.connected() ? this.unreachable() : e;
    }
  }

  /**
   * Takes a worker's inventory on the home: its reports, a note on each robot started there since the last reconnect that shares
   * a branch in its clone, a dormant record for each robot placed there it no longer holds, and a forget for each the home closed.
   */
  async reconcileWorker(inv: Inventory, machine: MachineId): Promise<void> {
    const { links } = this.o;
    if (!links) throw new Error(`${machine}: only the home reconciles a worker`);
    for (const r of inv.robots) applyReport(this.o.store, r, machine);
    // the repo each robot's report brings, its clone named as on the home
    const { robots, machines } = this.o.store.state;
    const root = (c: Robot) => homeRootOf(c, machines, this.o.homedir);
    const shared = new Map<string, string>();
    for (const id of this.o.replay?.created(machine) ?? []) {
      const c = Object.hasOwn(robots, id) ? robots[id] : undefined;
      const branch = c?.repo?.branch;
      if (!c || !branch) continue;
      const other = Object.values(robots).find((r) => r.id !== id && r.repo?.branch === branch && root(r) === root(c));
      if (other) shared.set(id, sharesBranch(branch, other.name));
    }
    if (shared.size) this.o.store.update((d) => { for (const [id, line] of shared) d.robots[id].note = withLine(d.robots[id].note, line); });
    const held = new Set(inv.robots.map((r) => r.robotId));
    const name = this.o.store.state.machines?.[machine]?.name ?? machine;
    const note = `${name} no longer has this robot's window`;
    this.o.store.update((d) => {
      for (const c of Object.values(d.robots)) {
        if (c.machine !== machine || held.has(c.id)) continue;
        // one already dormant keeps the revive it was given
        if (c.tmux || !c.revive) markDormant(c);
        if (c.second?.tmux) loseSecond(c);
        if (!c.note.includes(note)) c.note = c.note ? `${c.note}\n${note}` : note;
      }
    });
    const closed = inv.robots.filter((r) => !Object.hasOwn(this.o.store.state.robots, r.robotId));
    await Promise.all(closed.map(({ robotId: id }) => links.call(machine, 'robot.forget', { id })
      .catch((e: Error) => this.o.log.error(`${name}: ${id} was closed here and not forgotten there: ${e.message}`))));
  }

  // the name the home's registry gives this worker, which its snapshot carries
  private unreachable(): ApiError {
    const name = this.o.store.state.machines?.[this.o.me]?.name ?? os.hostname().split('.')[0];
    return new ApiError('not_reachable', unreachableLine(name));
  }
}

export const unreachableLine = (worker: string) => `${worker} cannot reach this Mac right now; try again when it is awake`;

type Handlers = Record<string, (params: unknown) => Promise<unknown>>;

/** Ends a robot placed here, its windows and what it started; its worktree stays, locked, for the session it may yet resume. */
export async function forgetRobot(o: { fleet: Fleet; store: Store; me: MachineId; log: Logger }, id: string): Promise<void> {
  const c = o.store.state.robots[id];
  if (!Object.hasOwn(o.store.state.robots, id) || c.machine !== o.me) return;
  await o.fleet.closeRobot(id);
  if (c.repo?.isWorktree) {
    const r = await handoverGit(['worktree', 'lock', '--reason', `closed robot ${id}`, c.repo.root], c.repo.mainRoot);
    if (r.code !== 0) o.log.error(`${id}: ${c.repo.root} was not locked: ${r.stderr.trim()}`);
  }
}

/** What a worker answers the home's calls about its robots with: each runs here, and what it changes goes home as any change does. */
export function workerCalls(o: { fleet: Fleet; store: Store; me: MachineId; log: Logger; terminals: Pick<TerminalHub, 'attach'> }): Handlers {
  const { fleet, terminals } = o;
  const on = <M extends MethodName>(method: M, run: (p: ParsedParams<M>) => Promise<Result<M>>) => async (raw: unknown) => {
    const p = methods[method].params.safeParse(raw);
    if (!p.success) throw new ApiError('invalid_params', z.prettifyError(p.error));
    return run(p.data as ParsedParams<M>);
  };
  const forget = async (raw: unknown) => {
    await forgetRobot(o, z.object({ id: z.string() }).parse(raw).id);
    return {};
  };
  return {
    'robot.run': on('robot.run', async (p) => ({ delivery: await fleet.run(p.id, p.text, p.enter, p.term) })),
    'robot.read': on('robot.read', async (p) => ({ text: p.source === 'screen' ? await fleet.readScreen(p.id, p.lines, p.term) : fleet.readTranscript(p.id, p.lines, p.term) })),
    'robot.wait': on('robot.wait', async (p) => ({ status: await fleet.waitFor(p.id, p.until, p.timeoutMs, undefined, p.term) })),
    'robot.revive': on('robot.revive', (p) => fleet.reviveRobot(p.id)),
    'robot.fresh': on('robot.fresh', (p) => fleet.startFresh(p.id, p.term)),
    'robot.second': on('robot.second', (p) => fleet.openSecond(p.id)),
    'robot.sleep': on('robot.sleep', async (p) => { await fleet.sleepRobot(p.id); return {}; }),
    'robot.seen': on('robot.seen', async (p) => fleet.markSeen(p.id, p.term)),
    'term.attach': on('term.attach', (p) => terminals.attach(p.id, p.term)),
    'robot.close': forget,
    'robot.forget': forget,
    'scribe.run': async (raw) => {
      const p = ScribeRun.safeParse(raw);
      if (!p.success) throw new ApiError('invalid_params', z.prettifyError(p.error));
      try {
        return (await fleet.scribeRead(p.data.id, p.data.only, p.data.columns, p.data.sweep)) ?? { skipped: true };
      } catch (e) {
        // the end of what a failed child printed goes home as its cause, which the scribe shows and keeps out of the log
        const { message, cause } = e as Error;
        throw typeof cause === 'string' ? new ApiError('internal', message, { cause: cause.slice(-500) }) : e;
      }
    },
    'repo.probe': async (raw) => {
      const p = RepoProbeParams.safeParse(raw);
      if (!p.success) throw new ApiError('invalid_params', z.prettifyError(p.error));
      return probeRepo(p.data, handoverGit);
    },
  };
}

const FarWatch = z.object({ id: z.string(), viewer: z.object({ key: z.string(), kind: z.enum(['app', 'phone']) }) });
const FarUnwatch = z.object({ id: z.string(), viewer: z.string() });
const FarGone = z.object({ viewer: z.string() });

/** What a worker answers the home's file views of its robots with, read from its own disk, and the watches the home's viewers keep there. */
export function fileCalls(o: { workspace: Workspace; viewers: FarViewers; resources: () => ResourceSource[] }): Handlers {
  const { workspace, viewers } = o;
  const on = <M extends MethodName>(method: M, run: (p: ParsedParams<M>) => Result<M> | Promise<Result<M>>) => async (raw: unknown) => run(parse(methods[method].params, raw) as ParsedParams<M>);
  return {
    'fs.list': on('fs.list', async (p) => ({ entries: await workspace.list(p.id, p.path) })),
    'fs.read': on('fs.read', (p) => workspace.read(p.id, p.path)),
    'repo.status': on('repo.status', (p) => workspace.status(p.id, p.base)),
    'repo.file': on('repo.file', (p) => workspace.file(p.id, p.path, p.base, p.from)),
    'resources.get': on('resources.get', () => ({ sources: o.resources() })),
    'far.repo.watch': async (raw) => {
      const p = parse(FarWatch, raw);
      workspace.watch(p.id, viewers.get(p.viewer.key, p.viewer.kind));
      return {};
    },
    'far.repo.unwatch': async (raw) => {
      const p = parse(FarUnwatch, raw);
      const v = viewers.find(p.viewer);
      if (v) workspace.unwatch(p.id, v);
      return {};
    },
    'far.viewer.gone': async (raw) => {
      const v = viewers.drop(parse(FarGone, raw).viewer);
      if (v) workspace.unwatchAll(v);
      return {};
    },
  };
}

function parse<S extends z.ZodType>(schema: S, raw: unknown): z.infer<S> {
  const p = schema.safeParse(raw);
  if (!p.success) throw new ApiError('invalid_params', z.prettifyError(p.error));
  return p.data;
}
