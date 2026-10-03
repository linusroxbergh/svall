import { contextPctOf, type Character, type TerminalSlot } from '@svall/protocol';

const sessionState = (s: TerminalSlot): string =>
  (!s.tmux ? 'dormant' : s.agent ? s.agent.status + (s.unread ? '*' : '') : 'shell');

export function stateOf(c: Character): string {
  const main = sessionState(c);
  return c.second ? `${main} +${sessionState(c.second)}` : main;
}

export function contextOf(c: Character): string {
  const pct = contextPctOf(c);
  return pct === undefined ? '' : `${pct}%`;
}
