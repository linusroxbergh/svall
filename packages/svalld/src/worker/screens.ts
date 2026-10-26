import { z } from 'zod';
import type { MachineId } from '@svall/protocol';
import type { Fleet } from '../fleet.js';
import type { HomeConnection } from '../link/worker.js';
import type { Store } from '../store.js';
import type { Tmux } from '../tmux/tmux.js';

/** What a worker sends its home of a robot's pane after a hook: its last lines, and when they were read. */
export const ScreenNotice = z.object({ id: z.string(), text: z.string(), at: z.number() });

/**
 * On a worker: the last lines of each robot's pane here, sent home after a hook for the home to show while this worker is
 * out of its reach. At most one per robot each `everyMs`; a hook within that is read once it has passed.
 */
export class ScreenTails {
  private sent = new Map<string, number>();
  private due = new Map<string, NodeJS.Timeout>();
  private readonly onHook = (id: string) => this.hooked(id);

  constructor(private o: {
    fleet: Pick<Fleet, 'on' | 'off'>; store: Store; tmux: Pick<Tmux, 'capture'>; connection: Pick<HomeConnection, 'notify'>; me: MachineId;
    lines?: number; everyMs?: number;
  }) {}

  start(): void {
    this.o.fleet.on('hook', this.onHook);
  }

  stop(): void {
    this.o.fleet.off('hook', this.onHook);
    for (const t of this.due.values()) clearTimeout(t);
    this.due.clear();
  }

  private hooked(id: string): void {
    if (this.due.has(id)) return;
    const wait = (this.sent.get(id) ?? -Infinity) + (this.o.everyMs ?? 5000) - Date.now();
    if (wait <= 0) { void this.send(id); return; }
    this.due.set(id, setTimeout(() => { this.due.delete(id); void this.send(id); }, wait).unref());
  }

  private async send(id: string): Promise<void> {
    const c = this.o.store.state.robots[id];
    if (!c?.tmux || c.machine !== this.o.me) return;
    const at = Date.now();
    this.sent.set(id, at);
    try {
      const text = (await this.o.tmux.capture(c.tmux.paneId, this.o.lines ?? 40)).toString('utf8');
      this.o.connection.notify('screen', { id, text, at });
    } catch {
      // a pane gone since the hook has no screen to send
    }
  }
}
