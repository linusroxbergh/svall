import crypto from 'node:crypto';
import { z } from 'zod';
import { ApiError, type Event, type MachineId } from '@svall/protocol';
import type { HomeLinks } from '../link/home.js';
import { PART_REPLY } from '../link/stream.js';
import type { HomeConnection } from '../link/worker.js';
import type { Logger } from '../log.js';
import type { Viewer } from '../terminals.js';
import type { Router } from './router.js';

// past this much unsent the link is behind, and a file change waits rather than add to what the heartbeat waits behind
const BEHIND = 1024 * 1024;
const LOOK_AGAIN_MS = 100;
/** The most scrollback a home viewer's screen carries over the link. */
export const REMOTE_LINES = 500;
/** The most of a screen afresh a notification carries: its base64 and the frame around it stay under PART_REPLY. */
export const REMOTE_SCREEN_BYTES = ((PART_REPLY - 4096) / 4) * 3;

/** What a worker sends a viewer on the home: the viewer's key, and a file change or what a terminal shows. */
export const ViewerNotice = z.object({
  key: z.string(),
  ev: z.discriminatedUnion('event', [
    z.object({ event: z.literal('repo.changed'), data: z.object({ id: z.string() }) }),
    z.object({ event: z.literal('term.output'), data: z.object({ id: z.string(), data: z.string() }) }),
    z.object({ event: z.literal('term.resync'), data: z.object({ id: z.string(), screen: z.string() }) }),
  ]),
});

const keys = new WeakMap<Viewer, string>();

/** The name a viewer of the home goes by on its workers. */
export function viewerKey(viewer: Viewer): string {
  let key = keys.get(viewer);
  if (!key) { key = crypto.randomUUID(); keys.set(viewer, key); }
  return key;
}

/** On a worker: the home's viewers, each a viewer here whose events go home in a `viewer` notification. */
export class FarViewers {
  private viewers = new Map<string, Viewer>();
  // the robots whose file change waits, per viewer, for the link to catch up
  private held = new Map<string, Set<string>>();
  private timer?: NodeJS.Timeout;

  constructor(private o: { connection: Pick<HomeConnection, 'notify' | 'backlog'> }) {}

  get(key: string, kind: Viewer['kind']): Viewer {
    let v = this.viewers.get(key);
    if (!v) {
      v = { kind, lines: REMOTE_LINES, screenBytes: REMOTE_SCREEN_BYTES, send: (ev) => this.send(key, ev), backlog: () => this.o.connection.backlog() };
      this.viewers.set(key, v);
    }
    return v;
  }

  find(key: string): Viewer | undefined {
    return this.viewers.get(key);
  }

  drop(key: string): Viewer | undefined {
    const v = this.viewers.get(key);
    this.viewers.delete(key);
    this.held.delete(key);
    return v;
  }

  dropAll(): Viewer[] {
    const all = [...this.viewers.values()];
    this.viewers.clear();
    this.held.clear();
    clearTimeout(this.timer);
    this.timer = undefined;
    return all;
  }

  private send(key: string, ev: Event): void {
    if (!this.viewers.has(key)) return;
    if (ev.event !== 'repo.changed' || this.o.connection.backlog() <= BEHIND) return this.o.connection.notify('viewer', { key, ev });
    // a file change only says to look again, so one per robot waits
    let ids = this.held.get(key);
    if (!ids) this.held.set(key, (ids = new Set()));
    ids.add(ev.data.id);
    this.timer ??= setTimeout(() => this.release(), LOOK_AGAIN_MS).unref();
  }

  private release(): void {
    this.timer = undefined;
    if (this.o.connection.backlog() > BEHIND) { this.timer = setTimeout(() => this.release(), LOOK_AGAIN_MS).unref(); return; }
    const held = [...this.held];
    this.held.clear();
    for (const [key, ids] of held) for (const id of ids) this.o.connection.notify('viewer', { key, ev: { event: 'repo.changed', data: { id } } });
  }
}

type Watch = { id: string; viewer: Viewer; machine: MachineId };

/** On the home: the watches its viewers keep on robots placed on a worker, held there by that worker's FarViewers. */
export class RemoteWatches {
  // by viewer key and robot id
  private watches = new Map<string, Watch>();
  // each viewer that watches on a worker, by its key, with the workers it reached
  private viewers = new Map<string, { viewer: Viewer; machines: Set<MachineId> }>();

  constructor(private o: { links: Pick<HomeLinks, 'call'>; router: Pick<Router, 'rootPlacedAt'> }) {}

  /** Watches on the robot's machine, once per viewer; a worker away takes the watch once it is back, and one the worker refuses is let go. */
  async watch(id: string, viewer: Viewer): Promise<void> {
    const machine = this.o.router.rootPlacedAt(id);
    if (!machine) return;
    const key = viewerKey(viewer);
    if (this.watches.has(`${key}\0${id}`)) return;
    const w: Watch = { id, viewer, machine };
    this.watches.set(`${key}\0${id}`, w);
    const seen = this.viewers.get(key) ?? { viewer, machines: new Set<MachineId>() };
    seen.machines.add(machine);
    this.viewers.set(key, seen);
    await this.forward(w).catch((e: unknown) => {
      if (e instanceof ApiError && e.code === 'not_reachable') return;
      if (this.watches.get(`${key}\0${id}`) === w) this.watches.delete(`${key}\0${id}`);
      throw e;
    });
  }

  // a worker away has let every viewer go already
  async unwatch(id: string, viewer: Viewer): Promise<void> {
    const key = viewerKey(viewer);
    const w = this.watches.get(`${key}\0${id}`);
    if (!w) return;
    this.watches.delete(`${key}\0${id}`);
    await this.o.links.call(w.machine, 'far.repo.unwatch', { id, viewer: key }).catch(() => {});
  }

  /** The viewer is gone: each worker it watched on lets it go. */
  unwatchAll(viewer: Viewer): void {
    const key = viewerKey(viewer);
    const seen = this.viewers.get(key);
    if (!seen) return;
    this.viewers.delete(key);
    for (const [k, w] of this.watches) if (w.viewer === viewer) this.watches.delete(k);
    for (const machine of seen.machines) this.o.links.call(machine, 'far.viewer.gone', { viewer: key }).catch(() => {});
  }

  /** A file change `machine` sent for one of this home's viewers, taken only for a robot the viewer watches there. */
  farEvent(key: string, ev: Extract<Event, { event: 'repo.changed' }>, machine: MachineId): void {
    if (this.watches.get(`${key}\0${ev.data.id}`)?.machine === machine) this.viewers.get(key)?.viewer.send(ev);
  }

  /** Forwards every watch on `machine` again, as after it linked anew; one whose robot no longer runs there is let go. Never rejects. */
  async reopen(machine: MachineId): Promise<void> {
    const again = [...this.watches].filter(([, w]) => w.machine === machine);
    await Promise.all(again.map(([k, w]) => {
      if (this.o.router.rootPlacedAt(w.id) === machine) return this.forward(w).catch(() => {});
      this.watches.delete(k);
      return undefined;
    }));
  }

  private forward(w: Watch): Promise<unknown> {
    return this.o.links.call(w.machine, 'far.repo.watch', { id: w.id, viewer: { key: viewerKey(w.viewer), kind: w.viewer.kind } });
  }
}

export type FarTerm = { id: string; viewer: Viewer; machine: MachineId; cols: number; rows: number; lines: number };

/** On the home: the terminals its viewers hold open on robots placed on a worker, each viewer one of that worker's FarViewers. */
export class FarTerminals {
  // by viewer key and robot id
  private terms = new Map<string, FarTerm>();

  constructor(private o: { links: Pick<HomeLinks, 'call'>; router: Pick<Router, 'placedAt'>; log: Logger }) {}

  /** The robot's screen on `machine`, sized for the viewer, whose output streams to it from then on. */
  async open(machine: MachineId, id: string, cols: number, rows: number, lines: number, viewer: Viewer): Promise<string> {
    const t: FarTerm = { id, viewer, machine, cols, rows, lines };
    this.terms.set(`${viewerKey(viewer)}\0${id}`, t);
    try {
      return await this.screen(t);
    } catch (e) {
      this.drop(t);
      throw e;
    }
  }

  async input(machine: MachineId, id: string, data: Buffer): Promise<void> {
    await this.o.links.call(machine, 'far.term.input', { id, data: data.toString('base64') });
  }

  async resize(id: string, cols: number, rows: number, viewer: Viewer): Promise<void> {
    const t = this.held(viewerKey(viewer), id);
    if (!t) return;
    Object.assign(t, { cols, rows });
    await this.o.links.call(t.machine, 'far.term.resize', { id, cols, rows, viewer: viewerKey(viewer) });
  }

  // a worker away has let every viewer go already
  close(id: string, viewer: Viewer): void {
    const t = this.held(viewerKey(viewer), id);
    if (!t) return;
    this.drop(t);
    this.o.links.call(t.machine, 'far.term.close', { id, viewer: viewerKey(viewer) }).catch(() => {});
  }

  /** The viewer is gone: each worker it held a terminal on lets it go. */
  closeAll(viewer: Viewer): void {
    const machines = new Set<MachineId>();
    for (const t of [...this.terms.values()]) if (t.viewer === viewer) { this.drop(t); machines.add(t.machine); }
    for (const machine of machines) this.o.links.call(machine, 'far.viewer.gone', { viewer: viewerKey(viewer) }).catch(() => {});
  }

  /** The terminal of robot `id` the viewer `key` holds open. */
  held(key: string, id: string): FarTerm | undefined {
    return this.terms.get(`${key}\0${id}`);
  }

  on(machine: MachineId): FarTerm[] {
    return [...this.terms.values()].filter((t) => t.machine === machine);
  }

  /** The screen afresh from the worker, for a viewer that missed output; a worker away sends it once it is back. */
  async resync(t: FarTerm): Promise<void> {
    const screen = await this.screen(t).catch((e: unknown) => {
      if (e instanceof ApiError && e.code === 'not_reachable') return undefined;
      throw e;
    });
    if (screen !== undefined && this.held(viewerKey(t.viewer), t.id) === t) t.viewer.send({ event: 'term.resync', data: { id: t.id, screen } });
  }

  /**
   * Opens and resyncs every terminal held on `machine`, as after it linked anew. One whose robot no longer runs there is
   * let go; one that does not open is let go there too, and its viewer told why. Never rejects.
   */
  async reopen(machine: MachineId): Promise<void> {
    await Promise.all(this.on(machine).map((t) => {
      if (this.o.router.placedAt(t.id) !== machine) return this.drop(t);
      return this.resync(t).catch((e: Error) => {
        this.o.log.error(`${machine}: terminal ${t.id} did not reopen: ${e.message}`);
        if (this.held(viewerKey(t.viewer), t.id) !== t) return;
        t.viewer.send({ event: 'term.output', data: { id: t.id, data: Buffer.from(`\r\nthis terminal did not reopen: ${e.message}\r\n`).toString('base64') } });
        this.close(t.id, t.viewer);
      });
    }));
  }

  private screen(t: FarTerm): Promise<string> {
    const { id, cols, rows, lines, viewer } = t;
    return this.o.links.call<{ screen: string }>(t.machine, 'far.term.open', { id, cols, rows, lines, viewer: { key: viewerKey(viewer), kind: viewer.kind } }).then((r) => r.screen);
  }

  private drop(t: FarTerm): void {
    const k = `${viewerKey(t.viewer)}\0${t.id}`;
    if (this.terms.get(k) === t) this.terms.delete(k);
  }
}
