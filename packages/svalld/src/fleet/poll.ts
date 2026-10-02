import type { Agent } from '@svall/protocol';
import type { Config } from '../config.js';
import { refreshMany, slice, type Deps as LinkDeps } from '../links/refresh.js';
import type { Logger } from '../log.js';
import { secondName, snapshot, syncWindow } from '../reconcile.js';
import type { Scribe } from '../scribe/scribe.js';
import type { Store } from '../store.js';
import { isShellCommand, type LiveWindow, type Tmux } from '../tmux/tmux.js';

// the ticks between looks for agents idle long enough to end
const DORMANCY_EVERY = 20;

type Deps = {
  store: Store; tmux: Tmux; config: Config; log: Logger; scribe: Scribe; pollMs?: number; staleSessionMs?: number; linkDeps?: Partial<LinkDeps>;
  // the windows tmux has, less those still closing for idleness
  listWindows: () => Promise<LiveWindow[]>;
  endIdleAgents: () => Promise<void>;
};

/** The fleet's poll: characters matched to tmux's windows, agents that ended without a word let go, a slice of the
 *  links looked at, and now and then stale viewer sessions swept and idle agents ended. */
export class Poll {
  private timer?: NodeJS.Timeout;
  private ticking?: Promise<void>;
  private stopped = false;
  private ticks = 0;
  private shellStreak = new Map<string, number>();
  private codexStreak = new Map<string, number>();
  // one link sweep at a time, so the cap on characters out asking holds across ticks; the characters a
  // tick found moved wait in `pendingLinks` for the sweep that follows the one running
  private sweeping = false;
  private pendingLinks = new Set<string>();

  constructor(private deps: Deps) {}

  // the next poll waits for the last, so a slow tmux never has two listings out
  schedule(): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      this.ticking = this.tick()
        .catch((e) => this.deps.log.error(`poll: ${String(e)}`))
        .finally(() => { this.ticking = undefined; this.schedule(); });
    }, this.deps.pollMs ?? 3000);
  }

  /** Stops polling; resolves once a poll under way has finished. */
  async stop(): Promise<void> {
    this.stopped = true;
    clearTimeout(this.timer);
    await this.ticking;
  }

  forget(id: string): void {
    for (const key of [id, secondName(id)]) this.shellStreak.delete(key);
    this.codexStreak.delete(id);
  }

  private async tick(): Promise<void> {
    const before = snapshot(this.deps.store.state);
    const live = await this.deps.listWindows();
    // a stop while tmux answered has ended what the listing shows
    if (this.stopped) return;
    const byName = new Map(live.map((w) => [w.name, w]));
    const cwdChanged: string[] = [];
    // an agent whose pane is back at a shell prompt for two polls has ended without a SessionEnd
    const settleAgent = (key: string, slot: { agent?: Agent }, command: string) => {
      if (slot.agent && isShellCommand(command, this.deps.config.shell)) {
        const n = (this.shellStreak.get(key) ?? 0) + 1;
        this.shellStreak.set(key, n);
        if (n >= 2) { delete slot.agent; this.shellStreak.delete(key); }
      } else {
        this.shellStreak.delete(key);
      }
    };
    this.deps.store.update((d) => {
      for (const c of Object.values(d.characters)) {
        const cwd = c.cwd;
        const w = syncWindow(c, byName, before, settleAgent);
        if (c.cwd !== cwd) cwdChanged.push(c.id);
        if (!w) continue;
        // Codex should report promptly; three polls without an event means delivery needs attention.
        if (!c.agent && w.command === 'codex') {
          const n = (this.codexStreak.get(c.id) ?? 0) + 1;
          this.codexStreak.set(c.id, n);
          if (n >= 3) c.hint = 'codex-silent';
        } else {
          this.codexStreak.delete(c.id);
          delete c.hint;
        }
      }
    });
    this.ticks++;
    // the fleet's links are looked at a slice per tick, so the whole crew never spawns git and gh in the same breath
    const awake = Object.values(this.deps.store.state.characters).filter((c) => c.tmux).map((c) => c.id);
    for (const id of cwdChanged) this.pendingLinks.add(id);
    if (!this.sweeping) {
      const toRefresh = [...new Set([...this.pendingLinks, ...slice(awake, this.ticks)])];
      this.pendingLinks.clear();
      this.sweeping = true;
      void refreshMany(this.deps.store, this.deps.config, toRefresh, this.deps.linkDeps)
        .catch((e) => this.deps.log.error(`links: ${String(e)}`))
        .finally(() => { this.sweeping = false; });
    }
    this.deps.scribe.tick();
    if (this.ticks % 10 === 0) await this.sweepViewerSessions();
    // ending an agent waits up to a minute for it to exit, which the next poll does not
    if (this.ticks % DORMANCY_EVERY === 0) this.deps.endIdleAgents().catch((e) => this.deps.log.error(`dormancy: ${String(e)}`));
  }

  // a desktop terminal that never attached leaves its v-<charId> session behind
  private async sweepViewerSessions(): Promise<void> {
    const staleMs = this.deps.staleSessionMs ?? 60_000;
    for (const s of await this.deps.tmux.listSessions()) {
      if (s.name.startsWith('v-') && s.attached === 0 && Date.now() - s.created > staleMs) await this.deps.tmux.killSession(s.name);
    }
  }
}
