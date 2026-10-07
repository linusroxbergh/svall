import type { Event } from '@svall/protocol';
import type { Fleet } from './fleet.js';
import type { Logger } from './log.js';
import type { Store } from './store.js';
import type { Tmux } from './tmux/tmux.js';

// a phone drives the tmux window's size; an app viewer yields to the desktop terminal attached to it.
// login is the tailnet identity the proxy vouched for; an app or CLI socket has none
export type Viewer = { kind: 'app' | 'phone'; login?: string; send(ev: Event): void; backlog(): number };

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

export class TerminalHub {
  private viewers = new Map<string, Set<Viewer>>();
  private writes = new Map<string, Promise<void>>();
  // characters whose tmux window a viewer has pinned to manual sizing
  private pinned = new Set<string>();
  // viewers whose socket has closed: an open still under way for one must not add it
  private left = new WeakSet<Viewer>();
  // viewers whose socket held DRAIN_LIMIT unsent and has not drained to REJOIN_AT, and the terminals they missed output of
  private behind = new Map<Viewer, Set<string>>();

  constructor(private fleet: Fleet, private tmux: Tmux, private store: Store, private log: Logger) {
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
    const c = this.fleet.live(id);
    let set = this.viewers.get(id);
    if (!set) { set = new Set(); this.viewers.set(id, set); }
    // the viewer can leave while tmux is answering; resuming against a set close() already dropped
    // would stream to nobody and re-pin a window close() has just handed back
    const current = () => this.viewers.get(id) === set && !this.left.has(viewer);
    try {
      await this.resizeFor(viewer, id, c.tmux.windowId, cols, rows);
      if (!current()) throw new Gone(id);
      this.fleet.setPaneOutput(id, true);
      const screen = (await this.tmux.capture(c.tmux.paneId, lines, true)).toString('base64');
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
    const c = this.fleet.live(id);
    const asked = c.agent?.status === 'blocked' ? c.agent.promptId : undefined;
    const next = (this.writes.get(id) ?? Promise.resolve()).catch(() => {}).then(() => this.tmux.sendBytes(c.tmux.paneId, data));
    this.writes.set(id, next);
    try { await next; } finally { if (this.writes.get(id) === next) this.writes.delete(id); }
    this.fleet.typedAnswer(id, data, asked);
  }

  // only a viewer has a size to give: open sized the window, and close hands it back
  async resize(id: string, cols: number, rows: number, viewer: Viewer): Promise<void> {
    const c = this.fleet.live(id);
    if (!this.viewers.get(id)?.has(viewer)) return;
    await this.resizeFor(viewer, id, c.tmux.windowId, cols, rows);
  }

  async attach(id: string, term?: 2): Promise<{ socket: string; session: string }> {
    const { windowId } = this.fleet.terminal(id, term).tmux;
    const session = viewerSession(id, term);
    await this.tmux.attachSession(session, windowId);
    return { socket: this.tmux.socket, session };
  }

  /** Lets go of every desktop terminal attached to either of a character's terminals. */
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
    const windowId = this.store.state.characters[id]?.tmux?.windowId;
    if (windowId) void this.tmux.autoSize(windowId);
  }

  // a v- session nobody ever attached to is a desktop terminal that failed to start, not a viewer to yield to
  private async attached(id: string): Promise<boolean> {
    return (await this.tmux.listSessions()).some((s) => s.name === `v-${id}` && s.attached > 0);
  }

  close(id: string, viewer: Viewer): void {
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
    this.left.add(viewer);
    for (const id of [...this.viewers.keys()]) this.close(id, viewer);
  }

  private broadcast(id: string, ev: Event): void {
    for (const v of this.viewers.get(id) ?? []) v.send(ev);
  }

  /** Output goes to each viewer that keeps up; one whose socket is full misses it, and gets the screen afresh once it has mostly drained. */
  private stream(id: string, ev: Event): void {
    for (const v of this.viewers.get(id) ?? []) {
      const missed = this.behind.get(v);
      if (missed) missed.add(id);
      else if (v.backlog() >= DRAIN_LIMIT) this.catchUp(v, id);
      else v.send(ev);
    }
  }

  private catchUp(v: Viewer, id: string): void {
    const missed = new Set([id]);
    this.behind.set(v, missed);
    const attempt = () => {
      if (this.left.has(v)) { this.behind.delete(v); return; }
      if (v.backlog() > REJOIN_AT) { setTimeout(attempt, 50); return; }
      this.behind.delete(v);
      for (const t of missed) if (this.viewers.get(t)?.has(v)) this.resync(t, v).catch((e) => this.log.error(`resync ${t}: ${String(e)}`));
    };
    setTimeout(attempt, 50);
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

  private async resync(id: string, only?: Viewer): Promise<void> {
    const c = this.store.state.characters[id];
    if (!c?.tmux || !this.viewers.get(id)?.size) return;
    const screen = (await this.tmux.capture(c.tmux.paneId, SCROLLBACK, true)).toString('base64');
    const ev: Event = { event: 'term.resync', data: { id, screen } };
    if (only) only.send(ev);
    else this.broadcast(id, ev);
  }
}
