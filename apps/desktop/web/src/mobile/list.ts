import type { Robot, FleetState, Island } from '@svall/protocol';
import type { Via } from '../placement.js';
import { robotsByPriority, islandsSorted, wantsUser, type DisplayStatus } from '../selectors.js';

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

export const subtitle = (c: Robot): string => c.note.trim().replace(/\s*\n+\s*/g, ' · ');

const LABEL: Record<DisplayStatus, string> = {
  working: 'working', idle: 'idle', blocked: 'needs you', done: 'done', shell: 'shell', moving: 'moving', unknown: 'unknown',
};
export const statusLabel = (s: DisplayStatus): string => LABEL[s];

/** The machine a fleet moved to, on a page this machine still serves: only a worker's copy holds its home's snapshot. */
export const movedTo = (fleet: FleetState, via: unknown, status: string): string | undefined =>
  (!via && status === 'online' ? Object.values(fleet.machines ?? {}).find((m) => m.snapshot)?.name : undefined);
