import type { Agent, Robot, TerminalSlot } from '@svall/protocol';
import { shownAgent } from '@svall/protocol/robot-message';
import { contextPctOf } from '@svall/protocol/sessions';

const sessionState = (s: TerminalSlot, agent: Agent | undefined = s.agent): string =>
  (!s.tmux ? 'dormant' : agent ? agent.status + (s.unread ? '*' : '') : 'shell');

// robot messages held for the user have the main terminal ask the user
export function stateOf(c: Robot): string {
  const main = sessionState(c, shownAgent(c));
  return c.second ? `${main} +${sessionState(c.second)}` : main;
}

/** Why each of a robot's dormant terminals did not resume, where it holds why. */
export function resumeFailures(c: Robot): string[] {
  return ([[c, ''], [c.second, ' (second terminal)']] as const)
    .flatMap(([t, which]) => (t && !t.tmux && t.resumeError ? [`${c.name}${which}: resume failed: ${t.resumeError}`] : []));
}

export function contextOf(c: Robot): string {
  const pct = contextPctOf(c);
  return pct === undefined ? '' : `${pct}%`;
}
