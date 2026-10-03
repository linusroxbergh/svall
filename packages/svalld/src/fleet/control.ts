import type { EventEmitter } from 'node:events';
import { markDormant } from '../dormancy.js';
import type { Logger } from '../log.js';
import type { Store } from '../store.js';
import type { ControlClient } from '../tmux/control.js';
import type { Tmux } from '../tmux/tmux.js';

// what the terminals hear of the panes: their output, tmux pausing and resuming one, and a client attached afresh
export type PaneEvents = {
  output: [charId: string, data: Buffer];
  pause: [charId: string];
  continue: [charId: string];
  'control-reset': [];
};

type Deps = { store: Store; tmux: Tmux; log: Logger; events: Pick<EventEmitter<PaneEvents>, 'emit'>; reconcile: () => Promise<void> };

/** The fleet's tmux control client: pane output for the terminals, windows that close, and a client attached afresh
 *  whenever the one before it is lost. */
export class ControlLink {
  private control?: ControlClient;
  // the next try at bringing the control client back
  private retry?: NodeJS.Timeout;
  // a server the recovery is bringing up, which a stop waits for so that a quit's kill comes after it
  private starting?: Promise<void>;
  // tmux stops reading a pane's pty once every client has it off, which freezes the pane;
  // output is filtered here instead.
  private streaming = new Set<string>();
  private stopped = false;

  constructor(private deps: Deps) {}

  async attach(): Promise<void> {
    const { events } = this.deps;
    const c = this.deps.tmux.connect();
    c.on('output', (paneId, data) => { const id = this.charByPane(paneId); if (id && this.streaming.has(id)) events.emit('output', id, data); });
    c.on('pause', (paneId) => { const id = this.charByPane(paneId); if (id) events.emit('pause', id); });
    c.on('continue', (paneId) => { const id = this.charByPane(paneId); if (id) events.emit('continue', id); });
    c.on('window-close', (windowId) => { this.windowClosed(windowId).catch((e) => this.deps.log.error(`window ${windowId} closed: ${String(e)}`)); });
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
    const c = this.deps.store.state.characters[id];
    if (c?.tmux) this.control?.send(`refresh-client -A '${c.tmux.paneId}:continue'`);
  }

  forget(id: string): void {
    this.streaming.delete(id);
  }

  private charByPane(paneId: string): string | undefined {
    return Object.values(this.deps.store.state.characters).find((c) => c.tmux?.paneId === paneId)?.id;
  }

  private charByWindow(windowId: string): string | undefined {
    return Object.values(this.deps.store.state.characters).find((c) => c.tmux?.windowId === windowId)?.id;
  }

  // tmux also reports a close when a viewer session holding a linked window goes away
  private async windowClosed(windowId: string): Promise<void> {
    if (await this.deps.tmux.hasWindow(windowId)) return;
    const id = this.charByWindow(windowId);
    if (id) { this.deps.store.update((d) => { const ch = d.characters[id]; if (ch) markDormant(ch); }); return; }
    const owner = Object.values(this.deps.store.state.characters).find((ch) => ch.second?.tmux.windowId === windowId)?.id;
    if (owner) this.deps.store.update((d) => { delete d.characters[owner]?.second; });
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
