import { execFile } from 'node:child_process';
import fs from 'node:fs';
import { promisify } from 'node:util';
import type { Agent, AgentKind, TerminalSlot } from '@svall/protocol';
import { interruptedAt } from '../agent/claude-transcript.js';
import { readComposer } from '../agent/composer.js';
import { applyHook, type Slot } from '../agent/reducer.js';
import { readTail } from '../agent/transcript.js';
import { onSharedServer } from '../codex/server.js';
import type { Config } from '../config.js';
import type { Proc } from '../dormancy.js';
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
export type Resume = { robotId: string; term?: 2; sessionId: string; kind: AgentKind; revive: { command: string }; at: number; ran: boolean };

// the resume a revive types, when it brings back the session of the agent the terminal keeps for a handover that
// carries it or could not resume it; any other resume that fails leaves its terminal at the shell
export function resumeOf(slot: TerminalSlot | undefined, carried: boolean, robotId: string, term?: 2): Resume | undefined {
  const { agent, revive } = slot ?? {};
  if (!agent || !revive?.command.includes(agent.sessionId) || (!carried && slot?.resumeError === undefined)) return undefined;
  return { robotId, ...(term && { term }), sessionId: agent.sessionId, kind: agent.kind, revive: { ...revive }, at: Date.now(), ran: false };
}

const exec = promisify(execFile);

// the pids among `pids` that job control has stopped, as ctrl+z does; ps fails when none of them runs
async function stoppedPids(pids: number[]): Promise<Set<number>> {
  if (!pids.length) return new Set();
  const out = await exec('ps', ['-o', 'pid=,stat=', '-p', pids.join(',')], { timeout: 2000 }).then((r) => r.stdout, () => '');
  return new Set(out.split('\n').flatMap((line) => { const m = /^\s*(\d+)\s+\S*T/.exec(line); return m ? [Number(m[1])] : []; }));
}

const interrupt = <T extends Slot>(robotId: string, slot: T): T => applyHook(slot, { robotId, backend: 'claude', name: 'Interrupt' }, Date.now());

type Deps = {
  store: Store; tmux: Tmux; config: Config; log: Logger; scribe: Scribe; pollMs?: number; staleSessionMs?: number; resumeMs?: number; linkDeps?: Partial<LinkDeps>;
  // the windows tmux has, less those still closing for idleness or a sleep
  listWindows: () => Promise<LiveWindow[]>;
  endIdleAgents: () => Promise<void>;
  writable: () => boolean;
  carried: Carried;
  // each revived terminal's resume, by window name, until its session starts
  resuming: Map<string, Resume>;
  // the windows closing, by name, until tmux has closed them
  ending: Map<string, Promise<void>>;
  track: (work: Promise<unknown>, what: string) => void;
  processes: () => Promise<Proc[]>;
};

/** The fleet's poll: robots matched to tmux's windows, agents that ended without a word let go, a slice of the
 *  links looked at, and now and then stale viewer sessions swept and idle agents ended. */
export class Poll {
  private timer?: NodeJS.Timeout;
  private ticking?: Promise<void>;
  private stopped = false;
  private ticks = 0;
  private shellStreak = new Map<string, number>();
  private codexStreak = new Map<string, number>();
  // the Codex questions whose prompt line read empty on the last tick
  private emptyOnce = new Set<string>();
  private transcriptSize = new Map<string, number>();
  // one link sweep at a time, so the cap on robots out asking holds across ticks; the robots a
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
    for (const key of [id, secondName(id)]) { this.shellStreak.delete(key); this.transcriptSize.delete(key); this.deps.resuming.delete(key); }
    this.codexStreak.delete(id);
  }

  /** Whether the last poll saw the agent in window `key` quit to its shell's prompt, with no resume there waiting on its session. */
  atShell(key: string): boolean {
    return this.shellStreak.has(key) && !this.deps.resuming.has(key);
  }

  // Claude Code fires no hook when an Esc or a "No" ends its turn, so a waiting or working agent's transcript is read
  // for the mark it leaves, each time it grows; one older than the last hook was already answered
  private interrupted(key: string, agent: Agent | undefined): boolean {
    if (agent?.kind !== 'claude' || !agent.transcriptPath || (agent.status !== 'blocked' && agent.status !== 'working')) {
      this.transcriptSize.delete(key);
      return false;
    }
    let size: number;
    try { size = fs.statSync(agent.transcriptPath).size; } catch { return false; }
    if (size === this.transcriptSize.get(key)) return false;
    this.transcriptSize.set(key, size);
    const at = interruptedAt(readTail(agent.transcriptPath, 64 * 1024));
    return at !== undefined && at > agent.lastActivityAt;
  }

  private async tick(): Promise<void> {
    if (!this.deps.writable()) return;
    const before = snapshot(this.deps.store.state);
    const activeAt = new Map(Object.values(this.deps.store.state.robots)
      .flatMap((c) => [[c.id, c.agent?.lastActivityAt], [secondName(c.id), c.second?.agent?.lastActivityAt]]));
    const live = await this.deps.listWindows();
    // a stop while tmux answered has ended what the listing shows, and a freeze leaves the fleet to the handover
    if (this.stopped || !this.deps.writable()) return;
    const byName = new Map(live.map((w) => [w.name, w]));
    const atShell = (key: string, agent?: Agent) => (agent?.pid && isShellCommand(byName.get(key)?.command ?? '', this.deps.config.shell) ? [agent.pid] : []);
    // an agent ctrl+z stopped leaves its shell in front until `fg` brings it back
    const suspended = await stoppedPids(Object.values(this.deps.store.state.robots)
      .flatMap((c) => [...atShell(c.id, c.agent), ...atShell(secondName(c.id), c.second?.agent)]));
    if (this.stopped || !this.deps.writable()) return;
    const cwdChanged: string[] = [];
    const silent: { id: string; pid: number }[] = [];
    const closing: { key: string; windowId: string; error: string }[] = [];
    const { resuming } = this.deps;
    const resumeMs = this.deps.resumeMs ?? RESUME_MS;
    // an agent whose pane is back at a shell prompt for two polls has ended without a SessionEnd; one a handover
    // has yet to start is still to be resumed there, and one resumed that never started its session goes dormant again
    const settleAgent = (key: string, slot: TerminalSlot, command: string, carried: boolean, dormant: (s: TerminalSlot) => void) => {
      const resume = resuming.get(key);
      const shell = isShellCommand(command, this.deps.config.shell);
      if (resume && !shell) resume.ran = true;
      // an agent that reported in while tmux answered is not the one the listing shows at a shell
      if (slot.agent && slot.agent.lastActivityAt !== activeAt.get(key)) { this.shellStreak.delete(key); return; }
      if (slot.agent && shell && !carried && !suspended.has(slot.agent.pid ?? 0)) {
        const n = (this.shellStreak.get(key) ?? 0) + 1;
        this.shellStreak.set(key, n);
        if (n < 2) return;
        this.shellStreak.delete(key);
        if (!resume) { delete slot.agent; return; }
        if (!resume.ran && Date.now() - resume.at < resumeMs) return;
        const which = `${this.deps.store.state.robots[resume.robotId]?.name}'s ${resume.term === 2 ? 'second ' : ''}terminal`;
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
      for (const c of Object.values(d.robots)) {
        const cwd = c.cwd;
        const w = syncWindow(c, byName, before, { carried: this.deps.carried, settle: settleAgent, atShell: (key) => this.atShell(key) });
        if (c.cwd !== cwd) cwdChanged.push(c.id);
        if (!w) continue;
        // Codex should report promptly; three polls without an event means delivery needs attention.
        if (!c.agent && w.command === 'codex') {
          const n = (this.codexStreak.get(c.id) ?? 0) + 1;
          this.codexStreak.set(c.id, n);
          if (n >= 3 && !c.hint) silent.push({ id: c.id, pid: w.panePid });
        } else {
          this.codexStreak.delete(c.id);
          delete c.hint;
          delete c.codexDaemon;
        }
        if (this.interrupted(c.id, c.agent)) d.robots[c.id] = interrupt(c.id, c);
        const second = d.robots[c.id].second;
        if (second && this.interrupted(secondName(c.id), second.agent)) d.robots[c.id].second = interrupt(c.id, second);
      }
    });
    // what a poll saw in a window says nothing of the next window opened under its name
    for (const key of this.shellStreak.keys()) if (!byName.has(key)) this.shellStreak.delete(key);
    for (const { key, windowId, error } of closing) {
      this.deps.log.error(error);
      const done: Promise<void> = this.deps.tmux.killWindow(windowId).finally(() => { if (this.deps.ending.get(key) === done) this.deps.ending.delete(key); });
      this.deps.ending.set(key, done);
      this.deps.track(done, `dormant ${key}`);
    }
    // a terminal gone dormant by any other way has no resume left to wait on
    for (const [key, r] of resuming) {
      const c = this.deps.store.state.robots[r.robotId];
      if (!(r.term === 2 ? c?.second : c)?.tmux) resuming.delete(key);
    }
    if (silent.length) await this.markSilent(silent);
    await this.dialogsGone();
    this.ticks++;
    // the fleet's links are looked at a slice per tick, so the whole crew never spawns git and gh in the same breath
    const awake = Object.values(this.deps.store.state.robots).filter((c) => c.tmux).map((c) => c.id);
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

  // a dialog answered, or a Codex subagent's dismissed, fires no hook until its tool ends; the prompt line back in view and
  // empty says it is gone. Codex shows every thread's dialog; Claude Code may not show a subagent's, or one about no tool
  private async dialogsGone(): Promise<void> {
    const watched = (a?: Agent): a is Agent => a?.status === 'blocked' && (a.kind === 'codex' || (a.kind === 'claude' && !!a.askedTool && !a.asking));
    const asking = Object.values(this.deps.store.state.robots).flatMap((c) => [c, c.second].flatMap((t, i) => {
      const a = t?.agent;
      return t?.tmux && watched(a) ? [{ id: c.id, second: i === 1, paneId: t.tmux.paneId, promptId: a.promptId, kind: a.kind }] : [];
    }));
    // Codex blocks on the hook itself, before its dialog is drawn, so one empty read may be the frame before it
    const once = this.emptyOnce;
    this.emptyOnce = new Set();
    for (const q of asking) {
      const screen = await this.deps.tmux.screen(q.paneId).catch(() => undefined);
      if (!screen || isShellCommand(screen.command, this.deps.config.shell) || readComposer(q.kind, screen) !== 'empty') continue;
      const key = q.promptId ?? q.paneId;
      if (q.kind === 'codex' && !once.has(key)) { this.emptyOnce.add(key); continue; }
      this.deps.store.update((d) => {
        const t = q.second ? d.robots[q.id]?.second : d.robots[q.id];
        const a = t?.agent;
        if (t?.tmux?.paneId !== q.paneId || !watched(a) || a.promptId !== q.promptId) return;
        a.status = 'working';
        delete a.prompt;
        delete a.promptId;
        delete a.asking;
      });
    }
  }

  // a plain `codex` on Codex's shared server is heard as the terminal that started the server, so its events are
  // dropped; any other codex is silent for its hooks' sake
  private async markSilent(silent: { id: string; pid: number }[]): Promise<void> {
    const procs = await this.deps.processes().catch((e) => { this.deps.log.error(`codex silent: ${String(e)}`); return undefined; });
    if (!procs || this.stopped || !this.deps.writable()) return;
    this.deps.store.update((d) => {
      for (const { id, pid } of silent) {
        const c = d.robots[id];
        if (!c || c.agent || !this.codexStreak.has(id)) continue;
        c.hint = 'codex-silent';
        if (onSharedServer(pid, procs)) c.codexDaemon = true; else delete c.codexDaemon;
      }
    });
  }

  // a desktop terminal that never attached leaves its v-<robotId> session behind
  private async sweepViewerSessions(): Promise<void> {
    const staleMs = this.deps.staleSessionMs ?? 60_000;
    for (const s of await this.deps.tmux.listSessions()) {
      if (s.name.startsWith('v-') && s.attached === 0 && Date.now() - s.created > staleMs) await this.deps.tmux.killSession(s.name);
    }
  }
}
