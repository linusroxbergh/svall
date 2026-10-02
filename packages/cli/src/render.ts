import { contextPctOf, type Character } from '@svall/protocol';

const sessionState = (s: { agent?: Character['agent']; unread: boolean }): string =>
  (s.agent ? s.agent.status + (s.unread ? '*' : '') : 'shell');

export function stateOf(c: Character): string {
  const main = c.tmux ? sessionState(c) : 'dormant';
  return c.second ? `${main} +${sessionState(c.second)}` : main;
}

export function contextOf(c: Character): string {
  const pct = contextPctOf(c);
  return pct === undefined ? '' : `${pct}%`;
}
