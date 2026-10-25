import os from 'node:os';
import { z } from 'zod';
import { ApiError, methods, serverWait, type MachineId, type MethodName, type Params, type ParsedParams, type Result } from '@svall/protocol';
import { loseSecond, markDormant } from '../dormancy.js';
import type { Fleet } from '../fleet.js';
import type { HomeLinks } from '../link/home.js';
import type { HomeConnection } from '../link/worker.js';
import { handoverGit } from '../links/git.js';
import type { Logger } from '../log.js';
import type { Store } from '../store.js';
import { applyReport, ownedReport, type Inventory, type RobotSync } from '../worker/snapshot.js';

// a call over the link waits as a client's call to the daemon does: the call's own wait, and 30 s beside it
const callMs = (method: MethodName, params: unknown): number => 30_000 + serverWait(method, params);

type Options = {
  store: Store;
  me: MachineId;
  log: Logger;
  /** On the home: its links to the workers. */
  links?: Pick<HomeLinks, 'call'>;
  /** On a worker: the home worker.json names, and the link to it. */
  home?: { id: MachineId; connection: Pick<HomeConnection, 'call' | 'connected'> };
};

/** Which machine answers a call about a robot: the one it runs on. */
export class Router {
  constructor(private o: Options) {}

  /** Whether this daemon serves its home's fleet as a worker. */
  get onWorker(): boolean {
    return this.o.home !== undefined;
  }

  /** The machine a robot runs on, when that is another one; a robot that names none runs on the home. */
  placedAt(robotId: string): MachineId | undefined {
    const { robots } = this.o.store.state;
    if (!Object.hasOwn(robots, robotId)) return undefined;
    const at = robots[robotId].machine ?? this.o.home?.id ?? this.o.me;
    return at === this.o.me ? undefined : at;
  }

  /** The answer of the machine a robot runs on to a call about it; undefined for a robot here. */
  forward<M extends MethodName>(robotId: string, method: M, params: Params<M>, signal?: AbortSignal): Promise<Result<M>> | undefined {
    const at = this.placedAt(robotId);
    if (!at) return undefined;
    // a worker is linked to its home alone, which sends the call on
    if (!this.o.links) return this.toHome(method, params, signal) as Promise<Result<M>>;
    return this.o.links.call<Result<M>>(at, method, params, { timeoutMs: callMs(method, params), signal });
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
   * Takes a worker's inventory on the home: the fields it reports of each robot, a dormant record for each robot placed
   * there that it no longer holds, and a forget for each it holds that the home has closed.
   */
  async reconcileWorker(inv: Inventory, machine: MachineId): Promise<void> {
    const { links } = this.o;
    if (!links) throw new Error(`${machine}: only the home reconciles a worker`);
    for (const r of inv.robots) applyReport(this.o.store, r, machine);
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
    return new ApiError('not_reachable', `${name} cannot reach this Mac right now; try again when it is awake`);
  }
}

type Handlers = Record<string, (params: unknown) => Promise<unknown>>;

/** What a worker answers the home's calls about its robots with: each runs here, and the fields it changed go home. */
export function workerCalls(o: { fleet: Fleet; store: Store; me: MachineId; report(r: RobotSync): void; log: Logger }): Handlers {
  const { fleet, store, me } = o;
  const report = (id: string) => {
    const c = store.state.robots[id];
    if (c?.machine === me) o.report(ownedReport(c));
  };
  const on = <M extends MethodName>(method: M, run: (p: ParsedParams<M>) => Promise<Result<M>>) => async (raw: unknown) => {
    const p = methods[method].params.parse(raw) as ParsedParams<M>;
    try { return await run(p); } finally { report((p as { id: string }).id); }
  };
  // the robot's windows and what it started end, and its worktree stays, locked, for the session it may yet resume
  const forget = async (raw: unknown) => {
    const { id } = z.object({ id: z.string() }).parse(raw);
    const c = store.state.robots[id];
    if (!Object.hasOwn(store.state.robots, id) || c.machine !== me) return {};
    await fleet.closeRobot(id);
    if (c.repo?.isWorktree) {
      const r = await handoverGit(['worktree', 'lock', '--reason', `closed robot ${id}`, c.repo.root], c.repo.mainRoot);
      if (r.code !== 0) o.log.error(`${id}: ${c.repo.root} was not locked: ${r.stderr.trim()}`);
    }
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
    'robot.close': forget,
    'robot.forget': forget,
  };
}
