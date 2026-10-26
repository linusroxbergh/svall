import { ApiError, type Event, type MachineId, type Result } from '@svall/protocol';
import type { Fleet } from './fleet.js';
import type { HomeLinks } from './link/home.js';
import type { Logger } from './log.js';
import { FarTerminals, viewerKey } from './placement/far-viewers.js';
import type { Router } from './placement/router.js';
import type { Store } from './store.js';
import type { Tmux } from './tmux/tmux.js';

// a phone drives the tmux window's size; an app viewer yields to the desktop terminal attached to it.
// login is the tailnet identity the proxy vouched for; an app or CLI socket has none; lines, the most scrollback a screen sent it carries
export type Viewer = { kind: 'app' | 'phone'; login?: string; lines?: number; send(ev: Event): void; backlog(): number };

// the viewer stopped watching before the screen was ready
class Gone extends Error {
  code = 'gone';
  constructor(id: string) { super(`terminal ${id} was closed while opening`); }
}

// the tmux session a desktop terminal attaches through, one per terminal
const viewerSession = (id: string, term?: 2): string => (term === 2 ? `v-${id}-2` : `v-${id}`);

const SCROLLBACK = 2000;
const DRAIN_LIMIT = 1_000_000;
// a viewer that fell behind rejoins once no more than this waits, so its resync and what follows fit under the limit
const REJOIN_AT = DRAIN_LIMIT / 4;
const DRAIN_TIMEOUT = 30_000;
const linesOf = (v: Viewer): number => Math.min(v.lines ?? SCROLLBACK, SCROLLBACK);

/** On the home: which robots run on a worker, and the links that reach each one. */
type Remote = { router: Pick<Router, 'placedAt' | 'forward'>; links: Pick<HomeLinks, 'for' | 'call'> };

export class TerminalHub {
  private viewers = new Map<string, Set<Viewer>>();
  private writes = new Map<string, Promise<void>>();
  // robots whose tmux window a viewer has pinned to manual sizing
  private pinned = new Set<string>();
  // how often each viewer was let go of whole, and of each terminal: a wait to rejoin, or an open, begun before the
  // last time must not go on
  private closes = new WeakMap<Viewer, number>();
  private closed = new WeakMap<Viewer, Map<string, number>>();
  // viewers whose socket held DRAIN_LIMIT unsent and has not drained to REJOIN_AT, and the terminals they missed output of
  private behind = new Map<Viewer, Set<string>>();
  // on the home: the terminals viewers here hold on placed robots, and the last lines each robot's worker sent of its pane
  private far?: FarTerminals;
  private screens = new Map<string, { text: string; at: number }>();

  constructor(private fleet: Fleet, private tmux: Tmux, private store: Store, private log: Logger, private remote?: Remote) {
    this.far = remote && new FarTerminals({ links: remote.links, router: remote.router });
    fleet.on('output', (id, data) => this.stream(id, { event: 'term.output', data: { id, data: data.toString('base64') } }));
    fleet.on('pause', (id) => this.resumeWhenDrained(id));
    fleet.on('continue', (id) => { this.resync(id).catch((e) => log.error(`resync ${id}: ${String(e)}`)); });
    fleet.on('control-reset', () => {
      for (const id of this.viewers.keys()) {
        fleet.setPaneOutput(id, true);
        this.resync(id).catch((e) => log.error(`resync ${id}: ${String(e)}`));
      }
    });
  }

  viewerCount(id: string): number {
    return this.viewers.get(id)?.size ?? 0;
  }

  async open(id: string, cols: number, rows: number, lines: number, viewer: Viewer): Promise<string> {
    const at = this.remote?.router.placedAt(id);
    if (at && this.far) return this.far.open(at, id, cols, rows, lines, viewer);
    const c = this.fleet.live(id);
    let set = this.viewers.get(id);
    if (!set) { set = new Set(); this.viewers.set(id, set); }
    // the viewer can leave while tmux is answering; resuming against a set close() already dropped
    // would stream to nobody and re-pin a window close() has just handed back
    const closed = this.closed.get(viewer)?.get(id);
    const current = () => this.viewers.get(id) === set && this.closed.get(viewer)?.get(id) === closed;
    try {
      await this.resizeFor(viewer, id, c.tmux.windowId, cols, rows);
      if (!current()) throw new Gone(id);
      this.fleet.setPaneOutput(id, true);
      const screen = (await this.tmux.viewerScreen(c.tmux.paneId, Math.min(lines, viewer.lines ?? lines))).toString('base64');
      // joining only now: output emitted while capture ran is already in the screen, so it must not also stream.
      if (!current()) throw new Gone(id);
      set.add(viewer);
      return screen;
    } catch (e) {
      if (current() && set.size === 0) { this.viewers.delete(id); this.fleet.setPaneOutput(id, false); }
      if (!this.viewers.get(id)) this.unpin(id);
      throw e;
    }
  }

  // one message per keystroke, each spawning its own tmux paste: without a queue the letters race and land
  // out of order. The desktop never saw this because it attaches its terminal to tmux directly.
  async input(id: string, data: Buffer): Promise<void> {
    const at = this.remote?.router.placedAt(id);
    if (at && this.far) return this.far.input(at, id, data);
    const c = this.fleet.live(id);
    const asked = c.agent?.status === 'blocked' ? c.agent.promptId : undefined;
    const next = (this.writes.get(id) ?? Promise.resolve()).catch(() => {}).then(() => this.tmux.sendBytes(c.tmux.paneId, data));
    this.writes.set(id, next);
    try { await next; } finally { if (this.writes.get(id) === next) this.writes.delete(id); }
    this.fleet.typedAnswer(id, data, asked);
  }

  // only a viewer has a size to give: open sized the window, and close hands it back
  async resize(id: string, cols: number, rows: number, viewer: Viewer): Promise<void> {
    if (this.remote?.router.placedAt(id)) return this.far?.resize(id, cols, rows, viewer);
    const c = this.fleet.live(id);
    if (!this.viewers.get(id)?.has(viewer)) return;
    await this.resizeFor(viewer, id, c.tmux.windowId, cols, rows);
  }

  async attach(id: string, term?: 2): Promise<Result<'term.attach'>> {
    const { remote } = this;
    const at = remote?.router.placedAt(id);
    if (remote && at) {
      // the robot's tmux is on its machine, which a terminal reaches over the ssh master the link to it runs on
      const far = await remote.router.forward(id, 'term.attach', { id, term })!;
      const link = remote.links.for(at);
      if (!link) throw new ApiError('not_reachable', `${this.store.state.machines?.[at]?.name ?? at} is not reachable`);
      return { ...far, via: link.via() };
    }
    const { windowId } = this.fleet.terminal(id, term).tmux;
    const session = viewerSession(id, term);
    await this.tmux.attachSession(session, windowId);
    return { socket: this.tmux.socket, session, tmux: this.tmux.binary };
  }

  /** Lets go of every desktop terminal attached to either of a robot's terminals. */
  async detach(id: string, signal?: AbortSignal): Promise<void> {
    await this.tmux.detachClients(viewerSession(id), signal);
    await this.tmux.detachClients(viewerSession(id, 2), signal);
  }

  // resize-window forces manual sizing, which would override an attached desktop terminal. The phone
  // forces it anyway: Claude Code's TUI only re-renders narrow when the window itself is narrow.
  private async resizeFor(viewer: Viewer, id: string, windowId: string, cols: number, rows: number): Promise<void> {
    if (viewer.kind !== 'phone' && await this.attached(id)) return;
    this.pinned.add(id);
    await this.tmux.resize(windowId, cols, rows);
  }

  // a window nobody resized is already following the Mac
  private unpin(id: string): void {
    if (!this.pinned.delete(id)) return;
    const windowId = this.store.state.robots[id]?.tmux?.windowId;
    if (windowId) void this.tmux.autoSize(windowId);
  }

  // a v- session nobody ever attached to is a desktop terminal that failed to start, not a viewer to yield to
  private async attached(id: string): Promise<boolean> {
    return (await this.tmux.listSessions()).some((s) => s.name === `v-${id}` && s.attached > 0);
  }

  close(id: string, viewer: Viewer): void {
    this.far?.close(id, viewer);
    const closed = this.closed.get(viewer) ?? new Map<string, number>();
    this.closed.set(viewer, closed.set(id, (closed.get(id) ?? 0) + 1));
    const set = this.viewers.get(id);
    if (!set) return;
    set.delete(viewer);
    const lastPhone = viewer.kind === 'phone' && ![...set].some((v) => v.kind === 'phone');
    if (set.size === 0 || lastPhone) this.unpin(id);
    if (set.size === 0) {
      this.viewers.delete(id);
      this.fleet.setPaneOutput(id, false);
    }
  }

  closeAll(viewer: Viewer): void {
    this.closes.set(viewer, (this.closes.get(viewer) ?? 0) + 1);
    this.far?.closeAll(viewer);
    for (const id of [...this.viewers.keys()]) this.close(id, viewer);
  }

  /** What a worker sent one of this home's viewers about a terminal, taken only for one the viewer holds open there. */
  farEvent(key: string, ev: Extract<Event, { event: 'term.output' | 'term.resync' }>, machine: MachineId): void {
    const t = this.far?.held(key, ev.data.id);
    if (t?.machine !== machine) return;
    if (ev.event === 'term.output' || this.behind.has(t.viewer)) this.deliver(t.viewer, t.id, ev);
    else t.viewer.send(ev);
  }

  /** The last lines of a placed robot's pane, as the worker it runs on sends them after a hook. */
  sawScreen(id: string, text: string, at: number, machine: MachineId): void {
    if (this.remote?.router.placedAt(id) === machine) this.screens.set(id, { text, at });
  }

  lastScreen(id: string): { text: string; at: number } | undefined {
    return this.screens.get(id);
  }

  /** `machine` is out of reach: each viewer of a terminal there gets the last screen it sent, which stands until it is back. */
  lostMachine(machine: MachineId): void {
    for (const t of this.far?.on(machine) ?? []) {
      const last = this.screens.get(t.id);
      if (last) t.viewer.send({ event: 'term.resync', data: { id: t.id, screen: Buffer.from(last.text).toString('base64') } });
    }
  }

  /** Opens each terminal viewers here hold on `machine` again, once it has linked anew. Never rejects. */
  reopen(machine: MachineId): Promise<void> {
    return this.far?.reopen(machine) ?? Promise.resolve();
  }

  /** Output goes to each viewer that keeps up; one whose socket is full misses it, and gets the screen afresh once it has mostly drained. */
  private stream(id: string, ev: Event): void {
    for (const v of this.viewers.get(id) ?? []) this.deliver(v, id, ev);
  }

  private deliver(v: Viewer, id: string, ev: Event): void {
    const missed = this.behind.get(v);
    if (missed) missed.add(id);
    else if (v.backlog() >= DRAIN_LIMIT) this.catchUp(v, id);
    else v.send(ev);
  }

  private catchUp(v: Viewer, id: string): void {
    const missed = new Set([id]);
    this.behind.set(v, missed);
    const closes = this.closes.get(v);
    const attempt = () => {
      if (this.closes.get(v) !== closes) { this.behind.delete(v); return; }
      if (v.backlog() > REJOIN_AT) { setTimeout(attempt, 50); return; }
      this.behind.delete(v);
      for (const t of missed) this.rejoin(t, v);
    };
    setTimeout(attempt, 50);
  }

  // a terminal the viewer holds on a worker gets its screen afresh from there
  private rejoin(id: string, v: Viewer): void {
    const far = this.far?.held(viewerKey(v), id);
    const again = far ? this.far?.resync(far) : this.viewers.get(id)?.has(v) ? this.resync(id, v) : undefined;
    again?.catch((e) => this.log.error(`resync ${id}: ${String(e)}`));
  }

  private resumeWhenDrained(id: string): void {
    const deadline = Date.now() + DRAIN_TIMEOUT;
    const attempt = () => {
      const set = this.viewers.get(id);
      // a viewer that fell behind gets the screen afresh when it drains, so it holds no pane for the others
      const max = Math.max(0, ...[...(set ?? [])].filter((v) => !this.behind.has(v)).map((v) => v.backlog()));
      if (max >= DRAIN_LIMIT && Date.now() < deadline) { setTimeout(attempt, 50); return; }
      if (max >= DRAIN_LIMIT) this.log.error(`terminal ${id}: viewer did not drain, resuming the pane anyway`);
      this.fleet.continuePane(id);
    };
    attempt();
  }

  // one capture for each scrollback the viewers take
  private async resync(id: string, only?: Viewer): Promise<void> {
    const c = this.store.state.robots[id];
    if (!c?.tmux || !this.viewers.get(id)?.size) return;
    const to = only ? [only] : [...this.viewers.get(id)!];
    for (const lines of new Set(to.map(linesOf))) {
      const screen = (await this.tmux.viewerScreen(c.tmux.paneId, lines)).toString('base64');
      for (const v of to) if (linesOf(v) === lines) v.send({ event: 'term.resync', data: { id, screen } });
    }
  }
}
