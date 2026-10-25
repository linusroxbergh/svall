import type { FleetState, MachineId } from '@svall/protocol';

export class NoMatch extends Error {}

function pick(items: Record<string, { id: string; name: string }>, ref: string, kind: string): string {
  if (Object.hasOwn(items, ref)) return ref;
  const matches = Object.values(items).filter((i) => i.name.toLowerCase() === ref.toLowerCase());
  if (matches.length === 1) return matches[0].id;
  if (!matches.length) throw new NoMatch(`no ${kind} "${ref}"`);
  throw new Error(`"${ref}" matches ${matches.map((m) => `${m.id} (${m.name})`).join(', ')}; use the id`);
}

export const robotId = (state: FleetState, ref: string): string => pick(state.robots, ref, 'robot');
export const islandId = (state: FleetState, ref: string): string => pick(state.islands, ref, 'island');
export const machineId = (state: FleetState, ref: string): MachineId =>
  pick(Object.fromEntries(Object.entries(state.machines ?? {}).map(([id, m]) => [id, { id, name: m.name }])), ref, 'machine') as MachineId;
