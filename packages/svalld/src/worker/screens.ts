import { z } from 'zod';
import type { MachineId, Robot } from '@svall/protocol';
import type { Fleet } from '../fleet.js';
import type { HomeLinks } from '../link/home.js';
import type { HomeConnection } from '../link/worker.js';
import type { Store } from '../store.js';
import type { TerminalHub } from '../terminals.js';
import type { Tmux } from '../tmux/tmux.js';

/** What a worker sends its home of a robot's pane after a hook: its last lines, and when they were read. */
export const ScreenNotice = z.object({ id: z.string(), text: z.string(), at: z.number() });

/**
 * The last lines of each robot's pane on this machine, sent after a hook to the machine that shows them while this one is out
 * of its reach: from a worker to its home, or from a home to the workers that dial it. At most one per robot each `everyMs`; a
 * hook within that is read once it has passed.
 */
export class ScreenTails {
  private sent = new Map<string, number>();
  private due = new Map<string, NodeJS.Timeout>();
  private readonly onHook = (id: string) => this.hooked(id);

  constructor(private o: {
    fleet: Pick<Fleet, 'on' | 'off'>; store: Store; tmux: Pick<Tmux, 'capture'>; connection: Pick<HomeConnection, 'notify'>; runsHere: (c: Robot) => boolean;
    lines?: number; everyMs?: number; wanted?: () => boolean;
  }) {}

  private get every(): number {
    return this.o.everyMs ?? 5000;
  }

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
    const wait = (this.sent.get(id) ?? -Infinity) + this.every - Date.now();
    if (wait <= 0) { void this.send(id); return; }
    this.due.set(id, setTimeout(() => { this.due.delete(id); void this.send(id); }, wait).unref());
  }

  private async send(id: string): Promise<void> {
    const c = this.o.store.state.robots[id];
    if (!c?.tmux || !this.o.runsHere(c) || this.o.wanted?.() === false) return;
    const at = Date.now();
    // a send longer ago than the window holds nothing back
    for (const [k, t] of this.sent) if (at - t >= this.every) this.sent.delete(k);
    this.sent.set(id, at);
    try {
      const text = (await this.o.tmux.capture(c.tmux.paneId, this.o.lines ?? 40)).toString('utf8');
      this.o.connection.notify('screen', { id, text, at });
    } catch {
      // a pane gone since the hook has no screen to send
    }
  }
}

/** A home's tails, for the workers that dial it, as no other worker opens a window that shows them; none is read without one. */
export function homeTails(o: { fleet: Pick<Fleet, 'on' | 'off'>; store: Store; tmux: Pick<Tmux, 'capture'>; runsHere: (c: Robot) => boolean; links: Pick<HomeLinks, 'connectedWorkers' | 'for' | 'call'> }): ScreenTails {
  const dialIns = () => o.links.connectedWorkers().filter((m) => o.links.for(m)?.dialsIn);
  return new ScreenTails({
    ...o, wanted: () => dialIns().length > 0,
    connection: { notify: (_kind, data) => { for (const m of dialIns()) o.links.call(m, 'screen.home', data).catch(() => {}); } },
  });
}

/** What a worker does with a screen from its home: the hub holds it for a window that loses that home. */
export const homeScreenCall = (terminals: Pick<TerminalHub, 'sawHomeScreen'>, home: MachineId) => (p: unknown): Promise<unknown> => {
  const s = ScreenNotice.parse(p);
  terminals.sawHomeScreen(s.id, s.text, s.at, home);
  return Promise.resolve({});
};
