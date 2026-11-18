import { shownAgent, type Robot, type FleetState, type Island } from '@svall/protocol';
import type { Via } from '../placement.js';
import { robotsByPriority, islandsSorted, isUnread, statusOf, wantsUser, type DisplayStatus } from '../selectors.js';

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

/** A robot's second line: what its agent asks while it is blocked, else its note, on one line. */
export const subtitle = (c: Robot, blocked = false): string =>
  ((blocked && shownAgent(c)?.prompt) || c.note).trim().replace(/\s*\n+\s*/g, ' · ');

/** The robot after `id` in the list's order that is blocked, or done and unread, coming round from the top. */
export function nextWaiting(f: FleetState, id: string, via?: Via): Robot | undefined {
  const order = sections(f, via).flatMap((s) => s.robots);
  const at = order.findIndex((c) => c.id === id);
  return [...order.slice(at + 1), ...order.slice(0, Math.max(at, 0))].find((c) => {
    const s = statusOf(c, f, via);
    return s === 'blocked' || (s === 'done' && isUnread(c));
  });
}

const LABEL: Record<DisplayStatus, string> = {
  working: 'working', idle: 'idle', blocked: 'needs you', done: 'done', shell: 'shell', moving: 'moving', unknown: 'unknown',
};
export const statusLabel = (s: DisplayStatus): string => LABEL[s];

/** The machine a fleet moved to, on a page this machine still serves: only a worker's copy holds its home's snapshot. */
export const movedTo = (fleet: FleetState, via: unknown, status: string): string | undefined =>
  (!via && status === 'online' ? Object.values(fleet.machines ?? {}).find((m) => m.snapshot)?.name : undefined);
