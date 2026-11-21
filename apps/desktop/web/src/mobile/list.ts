import { shownAgent, type Agent, type Robot, type FleetState, type Island } from '@svall/protocol';
import { elsewhere, type Via } from '../placement.js';
import { robotsByPriority, islandsSorted, slotStatus, statusOf, wantsUser, type DisplayStatus } from '../selectors.js';

export type Section = { island: Island; robots: Robot[] };

/** Islands in the order their crew needs the user, each with its robots in that order; empty islands come last. */
export function sections(f: FleetState, via?: Via): Section[] {
  const out: Section[] = [];
  const index = new Map<string, Section>();
  for (const c of robotsByPriority(f, via)) {
    const island = f.islands[c.islandId];
    if (!island) continue;
    let section = index.get(island.id);
    if (!section) { section = { island, robots: [] }; index.set(island.id, section); out.push(section); }
    section.robots.push(c);
  }
  for (const island of islandsSorted(f)) if (!index.has(island.id)) out.push({ island, robots: [] });
  return out;
}

export const waiting = (f: FleetState, via?: Via): number => Object.values(f.robots).filter((c) => wantsUser(c, f, via)).length;

/** A robot's second line: what the blocked terminal's agent asks while it is blocked, else its note, on one line. */
export const subtitle = (c: Robot, blocked = false): string =>
  ((blocked && (slotStatus(c, 1) === 'blocked' ? shownAgent(c) : c.second?.agent)?.prompt) || c.note).trim().replace(/\s*\n+\s*/g, ' · ');

/** The robot after `id` in the list's order that wants the user, coming round from the top. */
export function nextWaiting(f: FleetState, id: string, via?: Via): Robot | undefined {
  const order = sections(f, via).flatMap((s) => s.robots);
  const at = order.findIndex((c) => c.id === id);
  return [...order.slice(at + 1), ...order.slice(0, Math.max(at, 0))].find((c) => wantsUser(c, f, via));
}

/** What waits on the user, in the list's order: robots blocked on an answer, and apart from them those with unread work. */
export function waitingOn(f: FleetState, via?: Via): { asks: Robot[]; unread: Robot[] } {
  const all = sections(f, via).flatMap((s) => s.robots).filter((c) => wantsUser(c, f, via));
  const asks = all.filter((c) => statusOf(c, f, via) === 'blocked');
  return { asks, unread: all.filter((c) => !asks.includes(c)) };
}

export type Ask = { term: 1 | 2; agent: Agent };

/** The terminal a robot is blocked in, the main one first, and what its agent asks there. */
export function blockedAsk(c: Robot): Ask | undefined {
  if (slotStatus(c, 1) === 'blocked') return { term: 1, agent: shownAgent(c)! };
  if (slotStatus(c, 2) === 'blocked') return { term: 2, agent: c.second!.agent! };
  return undefined;
}

// answering sends Enter or Esc, which in a question picks the highlighted option
const QUESTIONS = new Set(['AskUserQuestion', 'request_user_input']);

/** Whether a card answers the ask: a yes or no on the main terminal, the one robot.answer reaches, from a machine that takes it.
 *  A worker refuses robot messages held for the user, which only the home lets in. */
export const answersInline = (c: Robot, ask: Ask, via?: Via): boolean => {
  if (ask.term !== 1 || elsewhere(c, via)) return false;
  if (c.relayed?.held !== undefined && ask.agent.promptId === c.relayed.held) return !via;
  // a permission names its tool; OpenCode's asks and Claude Code's forms name none, and may be questions
  return ask.agent.askedTool !== undefined && !QUESTIONS.has(ask.agent.askedTool);
};

const LABEL: Record<DisplayStatus, string> = {
  working: 'working', idle: 'idle', blocked: 'needs you', done: 'done', shell: 'shell', moving: 'moving', unknown: 'unknown',
};
export const statusLabel = (s: DisplayStatus): string => LABEL[s];

/** The machine a fleet moved to, on a page this machine still serves: only a worker's copy holds its home's snapshot. */
export const movedTo = (fleet: FleetState, via: unknown, status: string): string | undefined =>
  (!via && status === 'online' ? Object.values(fleet.machines ?? {}).find((m) => m.snapshot)?.name : undefined);
