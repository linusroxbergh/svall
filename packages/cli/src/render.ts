import { contextPctOf, type Character, type TerminalSlot } from '@svall/protocol';

const sessionState = (s: TerminalSlot): string =>
  (!s.tmux ? 'dormant' : s.agent ? s.agent.status + (s.unread ? '*' : '') : 'shell');

export function stateOf(c: Character): string {
  const main = sessionState(c);
  return c.second ? `${main} +${sessionState(c.second)}` : main;
}

/** Why each of a character's dormant terminals did not resume, where it holds why. */
export function resumeFailures(c: Character): string[] {
  return ([[c, ''], [c.second, ' (second terminal)']] as const)
    .flatMap(([t, which]) => (t && !t.tmux && t.resumeError ? [`${c.name}${which}: resume failed: ${t.resumeError}`] : []));
}

export function contextOf(c: Character): string {
  const pct = contextPctOf(c);
  return pct === undefined ? '' : `${pct}%`;
}
