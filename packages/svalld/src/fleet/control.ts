import type { EventEmitter } from 'node:events';
import type { Robot } from '@svall/protocol';
import { loseSecond, markDormant } from '../dormancy.js';
import type { Logger } from '../log.js';
import { secondName } from '../reconcile.js';
import type { Store } from '../store.js';
import type { ControlClient } from '../tmux/control.js';
import { unescapeOutput } from '../tmux/parse.js';
import type { Tmux } from '../tmux/tmux.js';

export type PaneEvents = {
  output: [robotId: string, data: Buffer];
  pause: [robotId: string];
  continue: [robotId: string];
  'control-reset': [];
};

type Deps = {
  store: Store; tmux: Tmux; log: Logger; events: Pick<EventEmitter<PaneEvents>, 'emit'>; reconcile: () => Promise<void>;
  track: (work: Promise<unknown>, what: string) => void;
  // whether the last poll saw the agent in a window, by name, quit to its shell
  atShell: (key: string) => boolean;
  // a robot placed on another machine has its panes there, whose ids this server may use for its own
  runsHere: (c: Robot) => boolean;
};

/** The fleet's tmux control client: pane output for the terminals, windows that close, and a client attached afresh
 *  whenever the one before it is lost. */
export class ControlLink {
  private control?: ControlClient;
  private retry?: NodeJS.Timeout;
  // a server the recovery is bringing up, which a stop waits for so that a quit's kill comes after it
  private starting?: Promise<void>;
  // tmux stops reading a pane's pty once every client has it off, freezing the pane, so output is filtered here instead
  private streaming = new Set<string>();
  private stopped = false;

  constructor(private deps: Deps) {}

  start(): Promise<void> {
    this.stopped = false;
    return this.attach();
  }

  private async attach(): Promise<void> {
    const { events } = this.deps;
    const c = this.deps.tmux.connect();
    // most panes stream to no viewer, so their output is dropped before it is looked up or decoded
    c.on('output', (paneId, escaped) => {
      if (!this.streaming.size) return;
      const id = this.robotByPane(paneId);
      if (id && this.streaming.has(id)) events.emit('output', id, unescapeOutput(escaped));
    });
    c.on('pause', (paneId) => { const id = this.robotByPane(paneId); if (id) events.emit('pause', id); });
    c.on('continue', (paneId) => { const id = this.robotByPane(paneId); if (id) events.emit('continue', id); });
    c.on('window-close', (windowId) => { this.deps.track(this.windowClosed(windowId), `window ${windowId} closed`); });
    // a client that exits before it is ready fails start, and the caller's retry is the one recovery
    let ready = false;
    let gone = false;
    c.once('ready', () => { ready = true; });
    c.on('exit', (reason) => {
      gone = true;
      this.deps.log.error(`control client lost: ${reason}`);
      if (this.control === c) this.control = undefined;
      if (ready && !this.stopped) this.retry = setTimeout(() => this.recover(), 1000);
    });
    await c.start();
    // a stop while it attached, or an exit read in the same breath as its ready, leaves nothing to keep
    if (this.stopped) { c.stop(); return; }
    if (gone) return;
    c.send('refresh-client -f pause-after=3');
    this.control = c;
  }

  async stop(): Promise<void> {
    this.stopped = true;
    clearTimeout(this.retry);
    this.control?.stop();
    await this.starting?.catch(() => {});
  }

  setPaneOutput(id: string, on: boolean): void {
    if (on) this.streaming.add(id); else this.streaming.delete(id);
  }

  continuePane(id: string): void {
    const c = this.deps.store.state.robots[id];
    if (c?.tmux) this.control?.send(`refresh-client -A '${c.tmux.paneId}:continue'`);
  }

  forget(id: string): void {
    this.streaming.delete(id);
  }

  private robotByPane(paneId: string): string | undefined {
    return Object.values(this.deps.store.state.robots).find((c) => c.tmux?.paneId === paneId && this.deps.runsHere(c))?.id;
  }

  private robotByWindow(windowId: string): string | undefined {
    return Object.values(this.deps.store.state.robots).find((c) => c.tmux?.windowId === windowId && this.deps.runsHere(c))?.id;
  }

  // tmux also reports a close when a viewer session holding a linked window goes away
  private async windowClosed(windowId: string): Promise<void> {
    if (await this.deps.tmux.hasWindow(windowId)) return;
    const id = this.robotByWindow(windowId);
    if (id) { this.deps.store.update((d) => { const ch = d.robots[id]; if (ch) markDormant(ch); }); return; }
    const owner = Object.values(this.deps.store.state.robots).find((ch) => ch.second?.tmux?.windowId === windowId && this.deps.runsHere(ch))?.id;
    if (owner) this.deps.store.update((d) => { const ch = d.robots[owner]; if (ch) loseSecond(ch, undefined, this.deps.atShell(secondName(owner))); });
  }

  // a stop at any step ends the recovery there, or it would start the server the stop just ended
  private async recover(delayMs = 1000): Promise<void> {
    if (this.stopped) return;
    try {
      this.starting = this.deps.tmux.ensureServer();
      await this.starting;
      if (this.stopped) return;
      await this.deps.reconcile();
      if (this.stopped) return;
      await this.attach();
      if (this.stopped) return;
      this.deps.events.emit('control-reset');
    } catch (e) {
      this.deps.log.error(`recover failed: ${String(e)}`);
      if (!this.stopped) this.retry = setTimeout(() => this.recover(Math.min(delayMs * 2, 30_000)), delayMs);
    }
  }
}
