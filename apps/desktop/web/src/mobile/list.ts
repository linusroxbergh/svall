import type { Robot, FleetState, Island } from '@svall/protocol';
import { robotsByPriority, islandsSorted, wantsUser, type DisplayStatus } from '../selectors.js';

export type Section = { island: Island; robots: Robot[] };

/**
 * The fleet as a phone reads it: islands in the order their crew needs the user, each holding its own
 * robots in that same order. Islands with nobody on them come last; they still have a "+" to tap.
 */
export function sections(f: FleetState): Section[] {
  const out: Section[] = [];
  const index = new Map<string, Section>();
  for (const c of robotsByPriority(f)) {
    const island = f.islands[c.islandId];
    if (!island) continue;
    let section = index.get(island.id);
    if (!section) { section = { island, robots: [] }; index.set(island.id, section); out.push(section); }
    section.robots.push(c);
  }
  for (const island of islandsSorted(f)) if (!index.has(island.id)) out.push({ island, robots: [] });
  return out;
}

export const waiting = (f: FleetState): number => Object.values(f.robots).filter((c) => wantsUser(c, f)).length;

/** The line under a robot's name: its note flattened to one line, or nothing. */
export const subtitle = (c: Robot): string => c.note.trim().replace(/\s*\n+\s*/g, ' · ');

const LABEL: Record<DisplayStatus, string> = {
  working: 'working', idle: 'idle', blocked: 'needs you', done: 'done', shell: 'shell', moving: 'moving', unknown: 'unknown',
};
/** A status as the phone words it, in the list and over the terminal alike. */
export const statusLabel = (s: DisplayStatus): string => LABEL[s];
