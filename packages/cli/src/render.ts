import type { Character, TerminalSlot } from '@archipelago/protocol';

const sessionState = (s: TerminalSlot): string =>
  (!s.tmux ? 'dormant' : s.agent ? s.agent.status + (s.unread ? '*' : '') : 'shell');

export function stateOf(c: Character): string {
  const main = sessionState(c);
  return c.second ? `${main} +${sessionState(c.second)}` : main;
}

// the fuller of the character's contexts: the one nearer to trouble
export function contextOf(c: Character): string {
  const pcts = [c.agent?.contextPct, c.second?.agent?.contextPct].filter((n): n is number => n !== undefined);
  return pcts.length ? `${Math.max(...pcts)}%` : '';
}
