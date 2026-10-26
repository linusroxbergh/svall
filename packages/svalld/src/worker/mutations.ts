import fs from 'node:fs';
import os from 'node:os';
import { ApiError, Mutation, UPDATE_FIELDS, type MachineId, type MethodName, type ParsedParams, type Result, type Robot } from '@svall/protocol';
import { Invalid } from '../errors.js';
import type { Fleet } from '../fleet.js';
import { writeDurable } from '../handover/durable.js';
import { newMutationId } from '../ids.js';
import type { HomeConnection } from '../link/worker.js';
import { resolveRepo } from '../links/git.js';
import type { Logger } from '../log.js';
import { expandHome, type Paths } from '../paths.js';
import { unreachableLine } from '../placement/router.js';
import type { Store } from '../store.js';
import type { Entry, Outbox } from './outbox.js';

/** How many robots a worker starts between two of its home's acks. */
export const OFFLINE_QUOTA = 5;
export const quotaLine = (worker: string, n: number) => `${worker} has started ${n} robots since this Mac last answered; wait for it`;
export const outsideClones = (worker: string, cwd: string) => `${cwd} is not inside a clone on ${worker}; start it in one`;
export const SLEPT_NOTE = (worker: string) => `started on ${worker} while this Mac slept`;
export const NOT_HOME = 'mission control stays on this Mac; start it on another island';

// the acknowledged mutations applied.ndjson keeps
const APPLIED_KEPT = 500;

type Served = 'robot.create' | 'robot.update' | 'robot.close' | 'robot.run' | 'robot.seen';

/** What a worker serves from its own store for the CLI in its panes, its home linked or not, and journals for the home to apply. */
export class WorkerMutations {
  private handlers: { [M in Served]: (p: ParsedParams<M>) => Promise<Result<M>> } = {
    'robot.create': (p) => this.create(p),
    'robot.update': (p) => this.update(p),
    'robot.close': async (p) => {
      await this.o.forget(p.id);
      this.journal({ method: 'robot.close', params: p });
      return {};
    },
    'robot.run': async (p) => {
      const delivery = await this.o.fleet.run(p.id, p.text, p.enter, p.term);
      this.journal({ method: 'robot.run', params: p, delivery });
      return { delivery };
    },
    // `unread` is this machine's, which its report carries
    'robot.seen': async (p) => this.o.fleet.markSeen(p.id, p.term),
  };
  // the starts the quota let through that are not journaled yet, by the params the fleet hands back to `created`
  private starting = new Set<object>();

  constructor(private o: {
    store: Store; fleet: Fleet; connection: Pick<HomeConnection, 'journal' | 'connected' | 'snapshotVersion'>; outbox: Pick<Outbox, 'after' | 'acked'>;
    me: MachineId; home: MachineId; paths: Pick<Paths, 'applied'>; log: Logger; forget: (id: string) => Promise<void>;
  }) {}

  /** Whether the home has acknowledged every mutation this worker has journaled; its reports change nothing it could lack. */
  drained(): boolean {
    return !this.o.outbox.after(this.o.outbox.acked()).some((e) => e.kind === 'mutation');
  }

  // until the home has taken the mutations, a change to a robot here goes after them
  private away(): boolean {
    return !this.o.connection.connected() || !this.drained();
  }

  /** Whether this worker answers the call itself: a new robot always, and a change to one of its robots while the home is away
   *  or has yet to take a mutation. */
  serves(method: MethodName, params: unknown): boolean {
    if (method === 'robot.create') return true;
    const id = (params as { id?: unknown }).id;
    const { robots } = this.o.store.state;
    if (typeof id !== 'string' || !Object.hasOwn(robots, id) || robots[id].machine !== this.o.me) return false;
    return method === 'robot.seen' || ((method === 'robot.update' || method === 'robot.close' || method === 'robot.run') && this.away());
  }

  serve<M extends MethodName>(method: M, params: ParsedParams<M>): Promise<Result<M>> {
    if (!Object.hasOwn(this.handlers, method)) throw new Error(`${method} is not served on a worker`);
    return (this.handlers[method as Served] as unknown as (p: ParsedParams<M>) => Promise<Result<M>>)(params);
  }

  /** Journals a robot made here, as the fleet has written it. */
  created(c: Robot, p: ParsedParams<'robot.create'>): void {
    this.starting.delete(p);
    this.journal({ method: 'robot.create', params: p, robot: c });
  }

  /** The robots started here, or being started, that the home has yet to acknowledge. */
  started(): number {
    const journaled = this.o.outbox.after(this.o.outbox.acked()).filter((e) => e.kind === 'mutation' && (e.data as Mutation).method === 'robot.create');
    return journaled.length + this.starting.size;
  }

  /** Records each mutation the home acknowledged, with what it changed, before the outbox drops it. */
  acked(dropped: Entry[]): void {
    const lines = dropped.flatMap((e) => {
      const m = e.kind === 'mutation' ? Mutation.safeParse(e.data) : undefined;
      return m?.success ? [JSON.stringify({ id: m.data.id, seq: e.seq, method: m.data.method, at: m.data.at, changed: changed(m.data) })] : [];
    });
    if (!lines.length) return;
    try {
      const held = fs.existsSync(this.o.paths.applied) ? fs.readFileSync(this.o.paths.applied, 'utf8').split('\n').filter(Boolean) : [];
      writeDurable(this.o.paths.applied, Buffer.from([...held, ...lines].slice(-APPLIED_KEPT).map((l) => `${l}\n`).join('')));
    } catch (e) {
      this.o.log.error(`journal: ${lines.length} acknowledged mutations not recorded: ${(e as Error).message}`);
    }
  }

  // the name the home's registry gives this worker, which its snapshot carries
  private get name(): string {
    return this.o.store.state.machines?.[this.o.me]?.name ?? os.hostname().split('.')[0];
  }

  private async create(p: ParsedParams<'robot.create'>): Promise<Result<'robot.create'>> {
    if (this.o.store.state.islands[p.islandId]?.kind === 'home') throw new Invalid(NOT_HOME);
    // the quota, the clone and the note are for a robot started while the home cannot be reached
    if (this.o.connection.connected()) return this.o.fleet.createRobot(p);
    if (this.started() >= OFFLINE_QUOTA) throw new Invalid(quotaLine(this.name, OFFLINE_QUOTA));
    const q = { ...p, note: SLEPT_NOTE(this.name) };
    this.starting.add(q);
    try {
      if (!(await resolveRepo(expandHome(p.cwd)))) throw new Invalid(outsideClones(this.name, p.cwd));
      return await this.o.fleet.createRobot(q);
    } finally {
      this.starting.delete(q);
    }
  }

  private async update(p: ParsedParams<'robot.update'>): Promise<Result<'robot.update'>> {
    const named = Object.keys(p).filter((k) => k !== 'id' && p[k as keyof typeof p] !== undefined);
    if (named.some((k) => !(UPDATE_FIELDS as readonly string[]).includes(k))) throw new ApiError('not_reachable', unreachableLine(this.name));
    const held = this.o.fleet.robot(p.id);
    const base = Object.fromEntries(named.map((k) => [k, held[k as keyof Robot]]));
    const robot = this.o.fleet.updateRobot(p.id, p);
    this.journal({ method: 'robot.update', params: p, base });
    return robot;
  }

  private journal(m: Pick<Mutation, 'method' | 'params' | 'robot' | 'base' | 'delivery'>): void {
    const mutation: Mutation = { id: newMutationId(), ...m, snapshotVersion: this.o.connection.snapshotVersion(), at: Date.now() };
    this.o.connection.journal('mutation', mutation);
  }
}

// what an acknowledged mutation changed, as applied.ndjson records it
function changed(m: Mutation): Record<string, unknown> {
  const p = m.params as Record<string, unknown>;
  if (m.method === 'robot.create') return { robotId: m.robot?.id, islandId: m.robot?.islandId, cell: m.robot?.cell };
  if (m.method === 'robot.update') return { robotId: p.id, ...Object.fromEntries(UPDATE_FIELDS.filter((k) => p[k] !== undefined).map((k) => [k, p[k]])) };
  if (m.method === 'robot.run') return { robotId: p.id, delivery: m.delivery };
  return { robotId: p.id };
}
