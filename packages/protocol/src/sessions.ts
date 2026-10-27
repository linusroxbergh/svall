import { z } from 'zod';
import { Sha256 } from './ids.js';
import { PUSH_STATUSES, type PushStatus } from './messages.js';
import { AgentKind, type Agent, type AgentStatus, type Robot, type FleetState } from './state.js';

// A robot's second terminal goes by its id and this suffix: its surface and its notification tag.
// Notifier.swift and sw.js spell it out themselves; web test/bridge-swift.test.ts holds them to it
const SECOND = '-2';
export const secondKey = (id: string): string => `${id}${SECOND}`;
export const robotOfKey = (key: string): string => (key.endsWith(SECOND) ? key.slice(0, -SECOND.length) : key);

export const isPushStatus = (s: AgentStatus | undefined): s is PushStatus => (PUSH_STATUSES as readonly string[]).includes(s ?? '');

// one agent session: a robot's main terminal, or its second one, keyed as above
export type Session = { key: string; robotId: string; term?: 2; agent?: Agent; unread: boolean };

export const sessionsOf = (f: FleetState): Map<string, Session> =>
  new Map(Object.values(f.robots).flatMap((c): [string, Session][] => [
    [c.id, { key: c.id, robotId: c.id, agent: c.agent, unread: c.unread }],
    ...(c.second ? [[secondKey(c.id), { key: secondKey(c.id), robotId: c.id, term: 2, agent: c.second.agent, unread: c.second.unread }] as [string, Session]] : []),
  ]));

/** Whether a session's agent has something new to tell: another status, or a new question while it stays blocked. */
export const isNews = (was: Agent | undefined, now: Agent | undefined): boolean =>
  now?.status !== was?.status || now?.promptId !== was?.promptId;

// the fuller of the robot's contexts: the one nearer to trouble
export const contextPctOf = (c: Robot): number | undefined => {
  const all = [c.agent?.contextPct, c.second?.agent?.contextPct].filter((n): n is number => n !== undefined);
  return all.length ? Math.max(...all) : undefined;
};

/** One file of a carried session as the source read it, by its path under its agent home. */
export const TransferFile = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('file'), path: z.string(),
    mode: z.number().int().nonnegative(), size: z.number().int().nonnegative(), mtimeMs: z.number().int(), sha256: Sha256,
    // a Git index by its staged entries, a loose ref by its value, a packed-refs file by each ref it packs; no move writes them
    gitIndex: Sha256.optional(),
    ref: z.string().optional(),
    refs: z.record(z.string(), z.string()).optional(),
  }),
  z.object({ type: z.literal('symlink'), path: z.string(), target: z.string() }),
]);
export type TransferFile = z.infer<typeof TransferFile>;

/** One agent session, copied exactly: the transcript its terminal recorded and the files its adapter found with it. */
export const TransferSession = z.object({
  robotId: z.string().min(1),
  term: z.literal(2).optional(),
  agent: AgentKind,
  sessionId: z.string().min(1),
  sourcePath: z.string(),
  // the transcript on the destination: the same path under that machine's agent home
  destinationPath: z.string().optional(),
  // the agent home each machine keeps the session under, and the adapter that reads it; `files` are named under the source home
  sourceHome: z.string().optional(),
  destinationHome: z.string().optional(),
  adapter: z.number().int().positive().optional(),
  files: z.array(TransferFile),
});
export type TransferSession = z.infer<typeof TransferSession>;
