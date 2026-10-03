import type { Character, FleetState, Island } from '@svall/protocol';
import { charactersByPriority, islandsSorted, wantsUser, type DisplayStatus } from '../selectors.js';

export type Section = { island: Island; characters: Character[] };

/**
 * The fleet as a phone reads it: islands in the order their crew needs the user, each holding its own
 * characters in that same order. Islands with nobody on them come last; they still have a "+" to tap.
 */
export function sections(f: FleetState): Section[] {
  const out: Section[] = [];
  const index = new Map<string, Section>();
  for (const c of charactersByPriority(f)) {
    const island = f.islands[c.islandId];
    if (!island) continue;
    let section = index.get(island.id);
    if (!section) { section = { island, characters: [] }; index.set(island.id, section); out.push(section); }
    section.characters.push(c);
  }
  for (const island of islandsSorted(f)) if (!index.has(island.id)) out.push({ island, characters: [] });
  return out;
}

export const waiting = (f: FleetState): number => Object.values(f.characters).filter(wantsUser).length;

/** The line under a character's name: its note flattened to one line, or nothing. */
export const subtitle = (c: Character): string => c.note.trim().replace(/\s*\n+\s*/g, ' · ');

const LABEL: Record<DisplayStatus, string> = {
  working: 'working', idle: 'idle', blocked: 'needs you', done: 'done', shell: 'shell',
};
/** A status as the phone words it, in the list and over the terminal alike. */
export const statusLabel = (s: DisplayStatus): string => LABEL[s];
