import { farRootId, type FleetState, type MachineId, type ResourceKind, type ResourceSource } from '@svall/protocol';
import { docsDir, repoSlug } from '../docs.js';
import { relocate } from '../handover/relocate.js';
import { docsGroups, rootIdOf } from './scan.js';

// a worker's docs are its copy of this Mac's, and its memory and MCP servers are in its user's Claude config
const FAR_ONLY = new Set<ResourceKind>(['docs', 'autoMemory', 'mcp']);

/**
 * The shelf with each worker's clones on it, their root ids and rows naming the worker, their docs in this Mac's folder
 * for each clone as this Mac names it; a slug folder that is one of those is no orphan. A worker's other sources are its
 * copies of this Mac's, and are left out.
 */
export function mergeSources(
  home: ResourceSource[], far: { machine: MachineId; sources: ResourceSource[] }[], o: { docs: string; machines: FleetState['machines']; homedir: string },
): ResourceSource[] {
  const taken = new Set<string>();
  const clones = far.flatMap(({ machine, sources }) => {
    const from = o.machines?.[machine]?.home;
    return sources.filter((s) => s.tier === 'repo' && s.robotIds.length > 0).map((s): ResourceSource => {
      const folder = docsDir(o.docs, 'repo', repoSlug(from ? relocate(s.root, { from, to: o.homedir }) : s.root));
      taken.add(folder);
      const rootId = farRootId(machine, s.root);
      const groups = s.groups.filter((g) => !FAR_ONLY.has(g.kind)).map((g) => ({
        ...g, items: g.items.map((i) => ({ ...i, id: `${machine}\u0000${i.id}`, ...(i.open?.rootId === s.rootId && { open: { ...i.open, rootId } }) })),
      }));
      return { ...s, rootId, docs: rootIdOf(folder), groups: [...docsGroups(folder), ...groups] };
    });
  });
  return [...home.filter((s) => !(s.tier === 'repo' && s.robotIds.length === 0 && taken.has(s.root))), ...clones];
}
