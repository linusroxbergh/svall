import fs from 'node:fs';
import type { Robot, Island, TerminalSlot } from '@svall/protocol';
import { lastTokenCount } from '../agent/codex-transcript.js';
import { followRollout, type RolloutMark } from '../agent/codex-workdir.js';
import { applyHook, applyStatus, type Slot } from '../agent/reducer.js';
import { readTail } from '../agent/transcript.js';
import { underCodexServer } from '../codex/server.js';
import type { Config } from '../config.js';
import { briefReply } from '../context/brief.js';
import type { Proc } from '../dormancy.js';
import type { RefreshLinks } from '../fleet.js';
import type { SocketEvent } from '../hooks/receiver.js';
import { resolveRepo } from '../links/git.js';
import type { Logger } from '../log.js';
import { appendSessions, currentLines, readSessions, sessionLines, type SessionLine } from '../retro/sessions.js';
import type { Store } from '../store.js';

type Deps = {
  store: Store; config: Config; log: Logger; render: (island: Island, c?: Robot) => string; refreshLinks: RefreshLinks;
  track: (work: Promise<unknown>, what: string) => void; processes: () => Promise<Proc[]>;
  // the retro's record of each session a robot takes; absent, none is kept
  sessions?: string;
};

// a pid is looked at again after this long, as one an ended server freed may come back as an agent
const SERVER_CHECK_MS = 60_000;

/** The agents' hooks and statuslines landing on their robots, the brief each gets back, and the checkout a hook
 *  says its agent has moved to. */
export class AgentEvents {
  private hookCwd = new Map<string, string>();
  private rolloutMark = new Map<string, RolloutMark>();
  private servers = new Map<number, { server: Promise<boolean>; at: number }>();
  private listing?: Promise<Proc[]>;
  private chains = new Map<string, Promise<unknown>>();
  private named?: Set<string>;

  constructor(private deps: Deps) {}

  // a robot's events land in the order they arrived, however long the server check on one of them takes
  apply(e: SocketEvent): Promise<string | undefined> {
    const id = ('hook' in e ? e.hook : e.status).robotId;
    const run = (this.chains.get(id) ?? Promise.resolve()).then(() => this.run(e));
    const tail = run.catch(() => {});
    this.chains.set(id, tail);
    tail.then(() => { if (this.chains.get(id) === tail) this.chains.delete(id); });
    return run;
  }

  private async run(e: SocketEvent): Promise<string | undefined> {
    if ('hook' in e && e.hook.pid && await this.fromServer(e.hook.pid)) { this.letGo(e.hook.robotId, e.hook.pid); return undefined; }
    const ev = 'hook' in e ? e.hook : e.status;
    const before = this.deps.store.state.robots[ev.robotId];
    let reply: string | undefined;
    this.deps.store.update((d) => {
      const c = d.robots[ev.robotId];
      if (!Object.hasOwn(d.robots, ev.robotId)) return;
      const apply = <T extends Slot>(slot: T): T => {
        let next = 'hook' in e ? applyHook(slot, e.hook, Date.now()) : applyStatus(slot, e.status);
        // codex has no statusline to push its context reading, so each hook reads it off the tail of the rollout
        if ('hook' in e && next.agent?.kind === 'codex' && next.agent.transcriptPath) {
          const t = lastTokenCount(readTail(next.agent.transcriptPath, 64 * 1024));
          if (t) next = applyStatus(next, { robotId: ev.robotId, sessionId: next.agent.sessionId, contextPct: t.pct });
        }
        // the brief is the agent's own: a run nested inside it neither gets it nor takes its changes
        if ('hook' in e && next.agent && (e.hook.name === 'SessionStart' || e.hook.name === 'UserPromptSubmit')
          && (!e.hook.sessionId || e.hook.sessionId === next.agent.sessionId)) {
          const island = d.islands[c.islandId];
          const r = briefReply(e.hook.name, island ? this.deps.render(island, c) : '', next.agent.brief, e.hook.backend === 'opencode');
          if (r.delivered !== undefined) next.agent.brief = r.delivered;
          reply = r.reply;
        }
        return next;
      };
      // a dormant terminal keeps the agent its revive resumes; the end its closing window sends does not clear it
      const slot = ev.term === 2 ? c.second : c;
      if (slot && !slot.tmux && 'hook' in e && e.hook.name === 'SessionEnd') return;
      // an event from a second terminal that has already gone has nowhere to land
      if (ev.term === 2) { if (c.second) c.second = apply(c.second); }
      else {
        const next = apply(c);
        if (next.agent) delete next.hint;
        // the shell's activity shows again once the agent has gone, and its end is that activity
        else if (c.agent) next.shell.lastOutputAt = Date.now();
        d.robots[ev.robotId] = next;
      }
    });
    this.record(sessionLines(before, this.deps.store.state.robots[ev.robotId], Date.now(), (s) => this.recorded().has(s)));
    // the second terminal is a side shell, and a run nested inside the agent or a subagent works where it likes; none moves the robot
    const agent = this.deps.store.state.robots[ev.robotId]?.agent;
    const nested = 'hook' in e && !!agent && !!e.hook.sessionId && e.hook.sessionId !== agent.sessionId;
    if ('hook' in e && e.hook.cwd && e.hook.term !== 2 && !nested && !e.hook.agentId) {
      const cwd = agent?.kind === 'codex' ? this.codexCwd(ev.robotId, agent.transcriptPath, e.hook.cwd) : e.hook.cwd;
      this.deps.track(this.followCwd(ev.robotId, cwd), `follow ${ev.robotId} to ${cwd}`);
    }
    return reply;
  }

  /** Records each session a robot running `here` holds now that the record doesn't name yet, such as one held before the
   *  record was kept. A robot on another machine is recorded when it comes here, with the paths it has then. */
  recordCurrent(here: (c: Robot) => boolean): void {
    if (!this.deps.sessions) return;
    this.record(currentLines(Object.values(this.deps.store.state.robots).filter(here), Date.now()).filter((l) => !this.recorded().has(l.session)));
  }

  private recorded(): Set<string> {
    return this.named ??= new Set(this.deps.sessions ? readSessions(this.deps.sessions).keys() : []);
  }

  // a record that can't be written loses the retro a session's attribution, never the hook
  private record(lines: SessionLine[]): void {
    if (!this.deps.sessions || !lines.length) return;
    try {
      appendSessions(this.deps.sessions, lines);
      for (const l of lines) this.recorded().add(l.session);
    } catch (e) { this.deps.log.error(`retro sessions: ${String(e)}`); }
  }

  forget(id: string): void {
    this.hookCwd.delete(id);
    this.rolloutMark.delete(id);
  }

  // a plain `codex` runs its hooks inside Codex's shared server, with the environment of whichever terminal started
  // it, and so does every run its sessions start: they name that terminal's robot, or none
  private fromServer(pid: number): Promise<boolean> {
    const seen = this.servers.get(pid);
    if (seen && Date.now() - seen.at < SERVER_CHECK_MS) return seen.server;
    const server = this.check(pid, seen?.server);
    if (this.servers.size > 100) this.servers.clear();
    this.servers.set(pid, { server, at: Date.now() });
    // a ps read that failed is no verdict: the pid's next event asks again
    server.catch(() => { if (this.servers.get(pid)?.server === server) this.servers.delete(pid); });
    return server;
  }

  private async check(pid: number, before?: Promise<boolean>): Promise<boolean> {
    const server = underCodexServer(pid, await this.processes(pid));
    if (server && !(await before?.catch(() => false))) this.deps.log.info(`hooks from Codex's shared server (pid ${pid}) ignored: they name no terminal of their own`);
    return server;
  }

  // one ps read serves every event that arrives while it runs; a pid it lacks started after it, and gets a fresh one
  private async processes(pid: number): Promise<Proc[]> {
    const shared = this.listing;
    const procs = await (shared ?? this.list());
    if (!shared || procs.some((p) => p.pid === pid)) return procs;
    return this.listing ?? this.list();
  }

  private list(): Promise<Proc[]> {
    this.listing = this.deps.processes().finally(() => { this.listing = undefined; });
    return this.listing;
  }

  // a slot a server's events took before svalld dropped them would never hear its end; a dormant one keeps the agent its revive resumes
  private letGo(robotId: string, pid: number): void {
    const took = (t?: TerminalSlot) => !!t?.tmux && t.agent?.pid === pid;
    const c = this.deps.store.state.robots[robotId];
    if (!took(c) && !took(c?.second)) return;
    this.deps.store.update((d) => {
      const held = d.robots[robotId];
      if (took(held)) delete held.agent;
      if (held.second && took(held.second)) delete held.second.agent;
    });
  }

  // codex runs each command in the directory its call names and tells its hooks only the one the session began in;
  // the newest command that ran elsewhere says where the agent works, until that directory is gone
  private codexCwd(robotId: string, transcript: string | undefined, home: string): string {
    if (!transcript) return home;
    const mark = followRollout(transcript, home, this.rolloutMark.get(robotId));
    this.rolloutMark.set(robotId, mark);
    return mark.dir && fs.existsSync(mark.dir) ? mark.dir : home;
  }

  // an agent that cds into another checkout from its shell leaves the pane's path behind; its hooks say where it went
  private async followCwd(robotId: string, cwd: string): Promise<void> {
    const from = this.deps.store.state.robots[robotId]?.cwd;
    if (!from || this.hookCwd.get(robotId) === cwd) return;
    this.hookCwd.set(robotId, cwd);
    const [to, now] = await Promise.all([resolveRepo(cwd), resolveRepo(from)]);
    // a report that came in while git answered is the newer one
    if (this.hookCwd.get(robotId) !== cwd || !to || to.root === now?.root) return;
    try { this.deps.store.update((d) => { if (d.robots[robotId]) d.robots[robotId].cwd = to.root; }); }
    // a write that fails leaves the directory for the next hook that reports it
    catch (e) { this.hookCwd.delete(robotId); throw e; }
    await this.deps.refreshLinks(this.deps.store, this.deps.config, robotId);
  }
}
