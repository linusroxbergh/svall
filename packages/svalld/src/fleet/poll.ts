import type { AgentKind, TerminalSlot } from '@svall/protocol';
import type { Config } from '../config.js';
import { refreshMany, slice, type Deps as LinkDeps } from '../links/refresh.js';
import type { Logger } from '../log.js';
import { secondName, snapshot, syncWindow, type Carried } from '../reconcile.js';
import type { Scribe } from '../scribe/scribe.js';
import type { Store } from '../store.js';
import { isShellCommand, type LiveWindow, type Tmux } from '../tmux/tmux.js';

// the ticks between looks for agents idle long enough to end
const DORMANCY_EVERY = 20;
// how long a resumed agent has to come up in its pane
const RESUME_MS = 60_000;

/** A resume typed into a revived terminal: the session it resumes and the command that resumes it again. */
export type Resume = { characterId: string; term?: 2; sessionId: string; kind: AgentKind; revive: { command: string }; at: number; ran: boolean };

// the resume a revive types, when it brings back the session of the agent the terminal keeps for a handover that
// carries it or could not resume it; any other resume that fails leaves its terminal at the shell
export function resumeOf(slot: TerminalSlot | undefined, carried: boolean, characterId: string, term?: 2): Resume | undefined {
  const { agent, revive } = slot ?? {};
  if (!agent || !revive?.command.includes(agent.sessionId) || (!carried && slot?.resumeError === undefined)) return undefined;
  return { characterId, ...(term && { term }), sessionId: agent.sessionId, kind: agent.kind, revive: { ...revive }, at: Date.now(), ran: false };
}

type Deps = {
  store: Store; tmux: Tmux; config: Config; log: Logger; scribe: Scribe; pollMs?: number; staleSessionMs?: number; resumeMs?: number; linkDeps?: Partial<LinkDeps>;
  // the windows tmux has, less those still closing for idleness
  listWindows: () => Promise<LiveWindow[]>;
  endIdleAgents: () => Promise<void>;
  writable: () => boolean;
  carried: Carried;
  // each revived terminal's resume, by window name, until its session starts
  resuming: Map<string, Resume>;
  // the windows closing, by name, until tmux has closed them
  ending: Map<string, Promise<void>>;
  track: (work: Promise<unknown>, what: string) => void;
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

  /** Polls until stopped; a poll stopped starts again. */
  start(): void {
    this.stopped = false;
    this.schedule();
  }

  // the next poll waits for the last, so a slow tmux never has two listings out
  private schedule(): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      this.ticking = this.tick()
        .catch((e) => this.deps.log.error(`poll: ${String(e)}`))
        .finally(() => { this.ticking = undefined; this.schedule(); });
      this.deps.track(this.ticking, 'poll');
    }, this.deps.pollMs ?? 3000);
  }

  /** Stops polling; resolves once a poll under way has finished. */
  async stop(): Promise<void> {
    this.stopped = true;
    clearTimeout(this.timer);
    await this.ticking;
  }

  forget(id: string): void {
    for (const key of [id, secondName(id)]) { this.shellStreak.delete(key); this.deps.resuming.delete(key); }
    this.codexStreak.delete(id);
  }

  private async tick(): Promise<void> {
    if (!this.deps.writable()) return;
    const before = snapshot(this.deps.store.state);
    const live = await this.deps.listWindows();
    // a stop while tmux answered has ended what the listing shows
    if (this.stopped) return;
    const byName = new Map(live.map((w) => [w.name, w]));
    const cwdChanged: string[] = [];
    const closing: { key: string; windowId: string; error: string }[] = [];
    const { resuming } = this.deps;
    const resumeMs = this.deps.resumeMs ?? RESUME_MS;
    // an agent whose pane is back at a shell prompt for two polls has ended without a SessionEnd; one a handover
    // has yet to start is still to be resumed there, and one resumed that never started its session goes dormant again
    const settleAgent = (key: string, slot: TerminalSlot, command: string, carried: boolean, dormant: (s: TerminalSlot) => void) => {
      const resume = resuming.get(key);
      const shell = isShellCommand(command, this.deps.config.shell);
      if (resume && !shell) resume.ran = true;
      if (slot.agent && shell && !carried) {
        const n = (this.shellStreak.get(key) ?? 0) + 1;
        this.shellStreak.set(key, n);
        if (n < 2) return;
        this.shellStreak.delete(key);
        if (!resume) { delete slot.agent; return; }
        if (!resume.ran && Date.now() - resume.at < resumeMs) return;
        const which = `${this.deps.store.state.characters[resume.characterId]?.name}'s ${resume.term === 2 ? 'second ' : ''}terminal`;
        const left = resume.ran ? `${resume.kind} exited back to its shell` : `${resume.kind} did not come up within ${Math.round(resumeMs / 1000)} s`;
        const error = `${which} resumed ${resume.kind} session ${resume.sessionId}, but ${left} before that session started, so it is dormant again with that session; revive it to see`;
        closing.push({ key, windowId: slot.tmux!.windowId, error });
        dormant(slot);
        slot.revive = { ...resume.revive };
        slot.resumeError = error;
        resuming.delete(key);
      } else {
        this.shellStreak.delete(key);
      }
    };
    this.deps.store.update((d) => {
      for (const c of Object.values(d.characters)) {
        const cwd = c.cwd;
        const w = syncWindow(c, byName, before, { carried: this.deps.carried, settle: settleAgent });
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
    for (const { key, windowId, error } of closing) {
      this.deps.log.error(error);
      const done: Promise<void> = this.deps.tmux.killWindow(windowId).finally(() => { if (this.deps.ending.get(key) === done) this.deps.ending.delete(key); });
      this.deps.ending.set(key, done);
      this.deps.track(done, `dormant ${key}`);
    }
    // a terminal gone dormant by any other way has no resume left to wait on
    for (const [key, r] of resuming) {
      const c = this.deps.store.state.characters[r.characterId];
      if (!(r.term === 2 ? c?.second : c)?.tmux) resuming.delete(key);
    }
    this.ticks++;
    // the fleet's links are looked at a slice per tick, so the whole crew never spawns git and gh in the same breath
    const awake = Object.values(this.deps.store.state.characters).filter((c) => c.tmux).map((c) => c.id);
    for (const id of cwdChanged) this.pendingLinks.add(id);
    if (!this.sweeping) {
      const toRefresh = [...new Set([...this.pendingLinks, ...slice(awake, this.ticks)])];
      this.pendingLinks.clear();
      this.sweeping = true;
      this.deps.track(refreshMany(this.deps.store, this.deps.config, toRefresh, this.deps.linkDeps).finally(() => { this.sweeping = false; }), 'links');
    }
    this.deps.scribe.tick();
    if (this.ticks % 10 === 0) await this.sweepViewerSessions();
    // ending an agent waits up to a minute for it to exit, which the next poll does not
    if (this.ticks % DORMANCY_EVERY === 0) this.deps.track(this.deps.endIdleAgents(), 'dormancy');
  }

  // a desktop terminal that never attached leaves its v-<charId> session behind
  private async sweepViewerSessions(): Promise<void> {
    const staleMs = this.deps.staleSessionMs ?? 60_000;
    for (const s of await this.deps.tmux.listSessions()) {
      if (s.name.startsWith('v-') && s.attached === 0 && Date.now() - s.created > staleMs) await this.deps.tmux.killSession(s.name);
    }
  }
}
