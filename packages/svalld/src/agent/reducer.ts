import crypto from 'node:crypto';
import type { Agent } from '@svall/protocol';
import type { HookEvent, StatusEvent } from '../hooks/receiver.js';

// what a terminal's hooks act on: the character itself for the main terminal, its `second` for the other
export type Slot = { agent?: Agent; unread: boolean };

const BLOCKING = new Set(['permission_prompt', 'worker_permission_prompt', 'elicitation_dialog', 'elicitation_url_dialog']);

/** Puts the agent at `status` with no question open and no background work counted. */
export function settle(agent: Agent, status: Agent['status']): void {
  agent.status = status;
  delete agent.prompt;
  delete agent.promptId;
  delete agent.background;
}

// a process of another user still counts as running
export const running = (pid: number): boolean => {
  try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM'; }
};

export function applyHook<T extends Slot>(c: T, e: HookEvent, now: number, alive: (pid: number) => boolean = running): T {
  const next = structuredClone(c);
  if (e.name === 'SessionStart') {
    if (!e.sessionId) return c;
    // the process resuming the session on record holds the slot from now on, as a revive's does
    if (next.agent?.sessionId === e.sessionId) {
      if (e.transcriptPath) next.agent.transcriptPath = e.transcriptPath;
      if (e.model) next.agent.model = e.model;
      if (e.pid) next.agent.pid = e.pid;
      next.agent.lastActivityAt = now;
      return next;
    }
    // a `claude -p` or `codex exec` run inside the agent inherits its character; a new session takes the
    // slot only from the process that holds it (clear, resume, compact) or once that process is gone
    const held = next.agent?.pid;
    if (held && e.pid && e.pid !== held && alive(held)) return c;
    next.agent = {
      kind: e.backend, sessionId: e.sessionId, status: 'idle', lastActivityAt: now,
      ...(e.transcriptPath && { transcriptPath: e.transcriptPath }), ...(e.model && { model: e.model }), ...(e.pid && { pid: e.pid }),
    };
    next.unread = false;
    return next;
  }
  if (e.name === 'SessionEnd') {
    // a late end from a session the character has already left must not clear the new one
    if (e.sessionId && next.agent && next.agent.sessionId !== e.sessionId) return c;
    delete next.agent;
    return next;
  }
  if (!next.agent) {
    // a window taken back without its SessionStart reports its agent with the next prompt
    if (e.name !== 'UserPromptSubmit' || !e.sessionId) return c;
    next.agent = { kind: e.backend, sessionId: e.sessionId, status: 'working', lastActivityAt: now, ...(e.pid && { pid: e.pid }) };
  }
  // another session's events come from a run nested inside the agent, or one turned away while its holder lived:
  // taken up once the holder is gone, or from the holder's own prompt there, as after a start the daemon missed
  if (e.sessionId && e.sessionId !== next.agent.sessionId) {
    const held = next.agent.pid;
    const moved = e.pid === held && e.name === 'UserPromptSubmit';
    if (!e.pid || !held || (!moved && (e.pid === held || alive(held)))) return c;
    next.agent = { kind: e.backend, sessionId: e.sessionId, status: 'idle', lastActivityAt: now, pid: e.pid };
    next.unread = false;
  }
  // a subagent's events say only whether the question it asked is still open; the notification is what blocks
  if (e.agentId) {
    const agent = next.agent;
    if (e.name !== 'PermissionRequest' && !agent.asking?.includes(e.agentId)) return c;
    const others = (agent.asking ?? []).filter((a) => a !== e.agentId);
    const asking = e.name === 'PermissionRequest' ? [...others, e.agentId] : others;
    if (asking.length) agent.asking = asking; else delete agent.asking;
    if (!asking.length && agent.status === 'blocked') {
      agent.status = 'working';
      delete agent.prompt;
      delete agent.promptId;
    }
    return next;
  }
  // a session started before its hooks named their process learns it from its own events
  if (e.pid && !next.agent.pid && e.sessionId === next.agent.sessionId) next.agent.pid = e.pid;
  next.agent.lastActivityAt = now;
  // Claude Code moves the transcript when a session enters or leaves a worktree; Codex names it only once it exists
  if (e.transcriptPath && e.sessionId === next.agent.sessionId) next.agent.transcriptPath = e.transcriptPath;
  if (e.model && e.sessionId === next.agent.sessionId) next.agent.model = e.model;
  // the hook carries the prompt before the transcript holds it, so this is the newest one there is
  if (e.prompt && (!e.sessionId || e.sessionId === next.agent.sessionId)) next.agent.lastPrompt = { ...e.prompt, at: now };
  const agent = next.agent;
  // background agents that never re-invoke the session, killed or crashed, are over once a hook lists none
  if (e.backgroundAgents === 0) delete agent.background;
  // the main thread moving on leaves a question a subagent still has open, unless the user typed a prompt past it
  if (agent.asking && e.backend === 'claude') {
    const stop = e.name === 'Stop' || e.name === 'StopFailure';
    const over = e.prompt || (stop && !e.backgroundAgents) || (e.name === 'Notification' && e.notificationType === 'idle_prompt');
    if (over) delete agent.asking;
    else if (agent.status === 'blocked' && e.name !== 'Notification') {
      if (stop) agent.background = true;
      return next;
    }
  }
  const ask = () => {
    agent.status = 'blocked';
    agent.promptId = crypto.randomUUID();
    if (e.message) agent.prompt = e.message; else delete agent.prompt;
  };
  // a new prompt or the end of a turn leaves no tool asked about
  if (e.name === 'UserPromptSubmit' || e.name === 'Stop' || e.name === 'StopFailure' || e.name === 'Interrupt') delete agent.askedTool;
  switch (e.name) {
    case 'UserPromptSubmit':
    case 'PreToolUse':
      settle(agent, 'working');
      next.unread = false;
      break;
    // a tool is asked about between the two, so the answer it waited for is its run; another tool of the same batch
    // finishing leaves the question open
    case 'PostToolUse':
    case 'PostToolUseFailure': {
      const other = Boolean(agent.askedTool && e.toolName && e.toolName !== agent.askedTool);
      if (other && agent.status === 'blocked') break;
      if (!other) delete agent.askedTool;
      settle(agent, 'working');
      next.unread = false;
      break;
    }
    case 'Stop':
    case 'StopFailure':
      // the turn ended but background agents are still going; their completion starts a new turn
      if (e.backgroundAgents) {
        settle(agent, 'working');
        agent.background = true;
        break;
      }
      settle(agent, 'done');
      // an API error ended the turn, and its message says which
      if (e.name === 'StopFailure' && e.message) agent.prompt = e.message;
      next.unread = true;
      break;
    // codex's word that an Esc ended the turn
    case 'Interrupt':
      settle(agent, 'idle');
      break;
    // Claude Code shows its question first and notifies of it only if it is still up a few seconds on, naming no tool
    case 'PermissionRequest':
      if (e.backend === 'codex') ask();
      else if (e.toolName) agent.askedTool = e.toolName;
      else delete agent.askedTool;
      break;
    case 'Notification':
      if (e.notificationType && BLOCKING.has(e.notificationType)) ask();
      // Claude Code fires nothing on an Esc; a minute on, it says it sits at its prompt, background agents or not.
      // With background agents out, the question is gone but the work goes on
      else if (e.notificationType === 'idle_prompt' && (agent.status === 'blocked' || agent.status === 'working')) {
        const background = agent.background;
        settle(agent, background ? 'working' : 'idle');
        if (background) agent.background = true;
      }
      break;
  }
  return next;
}

// Claude Code's own context reading; a statusline from a session the character has moved on from is stale
export function applyStatus<T extends Slot>(c: T, e: StatusEvent): T {
  if (!c.agent) return c;
  if (e.sessionId && c.agent.sessionId !== e.sessionId) return c;
  const pct = Math.round(e.contextPct);
  const model = e.model ?? c.agent.model;
  if (c.agent.contextPct === pct && c.agent.model === model) return c;
  const next = structuredClone(c);
  next.agent = { ...next.agent!, contextPct: pct, model };
  return next;
}

export function markSeen<T extends Slot>(c: T): T {
  const next = structuredClone(c);
  if (next.agent?.status === 'done') next.agent.status = 'idle';
  next.unread = false;
  return next;
}
