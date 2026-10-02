import { PUSH_STATUSES, type PushStatus } from './messages.js';
import type { Agent, AgentStatus, Character, FleetState } from './state.js';

// A character's second terminal goes by its id and this suffix: its surface and its notification tag.
// Notifier.swift and sw.js spell it out themselves; web test/bridge-swift.test.ts holds them to it
const SECOND = '-2';
export const secondKey = (id: string): string => `${id}${SECOND}`;
export const charOfKey = (key: string): string => (key.endsWith(SECOND) ? key.slice(0, -SECOND.length) : key);

export const isPushStatus = (s: AgentStatus | undefined): s is PushStatus => (PUSH_STATUSES as readonly string[]).includes(s ?? '');

// one agent session: a character's main terminal, or its second one, keyed as above
export type Session = { key: string; charId: string; term?: 2; agent?: Agent; unread: boolean };

export const sessionsOf = (f: FleetState): Map<string, Session> =>
  new Map(Object.values(f.characters).flatMap((c): [string, Session][] => [
    [c.id, { key: c.id, charId: c.id, agent: c.agent, unread: c.unread }],
    ...(c.second ? [[secondKey(c.id), { key: secondKey(c.id), charId: c.id, term: 2, agent: c.second.agent, unread: c.second.unread }] as [string, Session]] : []),
  ]));

/** Whether a session's agent has something new to tell: another status, or a new question while it stays blocked. */
export const isNews = (was: Agent | undefined, now: Agent | undefined): boolean =>
  now?.status !== was?.status || now?.promptId !== was?.promptId;

// the fuller of the character's contexts: the one nearer to trouble
export const contextPctOf = (c: Character): number | undefined => {
  const all = [c.agent?.contextPct, c.second?.agent?.contextPct].filter((n): n is number => n !== undefined);
  return all.length ? Math.max(...all) : undefined;
};
