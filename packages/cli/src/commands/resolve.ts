import type { FleetState } from '@svall/protocol';

export class NoMatch extends Error {}

function pick(items: Record<string, { id: string; name: string }>, ref: string, kind: string): string {
  if (Object.hasOwn(items, ref)) return ref;
  const matches = Object.values(items).filter((i) => i.name.toLowerCase() === ref.toLowerCase());
  if (matches.length === 1) return matches[0].id;
  if (!matches.length) throw new NoMatch(`no ${kind} "${ref}"`);
  throw new Error(`"${ref}" matches ${matches.map((m) => `${m.id} (${m.name})`).join(', ')}; use the id`);
}

export const charId = (state: FleetState, ref: string): string => pick(state.characters, ref, 'character');
export const islandId = (state: FleetState, ref: string): string => pick(state.islands, ref, 'island');
