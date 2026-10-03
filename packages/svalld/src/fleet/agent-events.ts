import fs from 'node:fs';
import type { Character, Island } from '@svall/protocol';
import { lastTokenCount } from '../agent/codex-transcript.js';
import { followRollout, type RolloutMark } from '../agent/codex-workdir.js';
import { applyHook, applyStatus, type Slot } from '../agent/reducer.js';
import { readTail } from '../agent/transcript.js';
import type { Config } from '../config.js';
import { briefReply } from '../context/brief.js';
import type { RefreshLinks } from '../fleet.js';
import type { SocketEvent } from '../hooks/receiver.js';
import { resolveRepo } from '../links/git.js';
import type { Store } from '../store.js';

type Deps = {
  store: Store; config: Config; render: (island: Island, c?: Character) => string; refreshLinks: RefreshLinks;
  writable: () => boolean; frozen: () => boolean; track: (work: Promise<unknown>, what: string) => void;
};

/** The agents' hooks and statuslines landing on their characters, the brief each gets back, and the checkout a hook
 *  says its agent has moved to. */
export class AgentEvents {
  private hookCwd = new Map<string, string>();
  private rolloutMark = new Map<string, RolloutMark>();

  constructor(private deps: Deps) {}

  apply(e: SocketEvent): string | undefined {
    const ev = 'hook' in e ? e.hook : e.status;
    const frozen = this.deps.frozen();
    let reply: string | undefined;
    this.deps.store.update((d) => {
      const c = d.characters[ev.charId];
      if (!Object.hasOwn(d.characters, ev.charId)) return;
      // a terminal the handover has closed carries its agent to the next machine; a late SessionEnd must not take it
      if (frozen && !(ev.term === 2 ? c.second : c)?.tmux) return;
      const apply = <T extends Slot>(slot: T): T => {
        let next = 'hook' in e ? applyHook(slot, e.hook, Date.now()) : applyStatus(slot, e.status);
        // codex has no statusline to push its context reading, so each hook reads it off the tail of the rollout
        if ('hook' in e && next.agent?.kind === 'codex' && next.agent.transcriptPath) {
          const t = lastTokenCount(readTail(next.agent.transcriptPath, 64 * 1024));
          if (t) next = applyStatus(next, { charId: ev.charId, sessionId: next.agent.sessionId, contextPct: t.pct });
        }
        // the brief is the agent's own: a run nested inside it neither gets it nor takes its changes
        if ('hook' in e && next.agent && (e.hook.name === 'SessionStart' || e.hook.name === 'UserPromptSubmit')
          && (!e.hook.sessionId || e.hook.sessionId === next.agent.sessionId)) {
          const island = d.islands[c.islandId];
          const r = briefReply(e.hook.name, island ? this.deps.render(island, c) : '', next.agent.brief);
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
        d.characters[ev.charId] = next;
      }
    });
    // the second terminal is a side shell, and a run nested inside the agent or a subagent works where it likes; none moves the character
    const agent = this.deps.store.state.characters[ev.charId]?.agent;
    const nested = 'hook' in e && !!agent && !!e.hook.sessionId && e.hook.sessionId !== agent.sessionId;
    if ('hook' in e && e.hook.cwd && e.hook.term !== 2 && !nested && !e.hook.agentId && this.deps.writable()) {
      const cwd = agent?.kind === 'codex' ? this.codexCwd(ev.charId, agent.transcriptPath, e.hook.cwd) : e.hook.cwd;
      this.deps.track(this.followCwd(ev.charId, cwd), `follow ${ev.charId} to ${cwd}`);
    }
    return reply;
  }

  forget(id: string): void {
    this.hookCwd.delete(id);
    this.rolloutMark.delete(id);
  }

  // codex runs each command in the directory its call names and tells its hooks only the one the session began in;
  // the newest command that ran elsewhere says where the agent works, until that directory is gone
  private codexCwd(charId: string, transcript: string | undefined, home: string): string {
    if (!transcript) return home;
    const mark = followRollout(transcript, home, this.rolloutMark.get(charId));
    this.rolloutMark.set(charId, mark);
    return mark.dir && fs.existsSync(mark.dir) ? mark.dir : home;
  }

  // an agent that cds into another checkout from its shell leaves the pane's path behind; its hooks say where it went
  private async followCwd(charId: string, cwd: string): Promise<void> {
    const from = this.deps.store.state.characters[charId]?.cwd;
    if (!from || this.hookCwd.get(charId) === cwd) return;
    this.hookCwd.set(charId, cwd);
    const [to, now] = await Promise.all([resolveRepo(cwd), resolveRepo(from)]);
    // a report that came in while git answered is the newer one
    if (this.hookCwd.get(charId) !== cwd || !to || to.root === now?.root) return;
    try { this.deps.store.update((d) => { if (d.characters[charId]) d.characters[charId].cwd = to.root; }); }
    // a write that fails leaves the directory for the next hook that reports it
    catch (e) { this.hookCwd.delete(charId); throw e; }
    await this.deps.refreshLinks(this.deps.store, this.deps.config, charId);
  }
}
