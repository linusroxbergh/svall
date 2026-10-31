import type { FleetState, MachineId, Robot } from '@svall/protocol';
import { shortPath } from '../paths.js';
import { robotsOf, startCwd } from '../selectors.js';

export type CwdChoice = { path: string; label: string };

/** Start directories offered without typing a path: the home cwd for home crew, then the island's own, then the rest; on a
 *  worker, only the folders of the robots running there, as the Mac's paths mean nothing on it. */
export function cwdChoices(f: FleetState, islandId: string, worker?: MachineId): CwdChoice[] {
  const island = f.islands[islandId];
  const there = (c: Robot) => !worker || c.machine === worker;
  const first = island?.kind === 'home' && !worker ? [f.home.cwd] : [];
  const own = island ? robotsOf(f, islandId).filter(there).map(startCwd) : [];
  const rest = Object.values(f.robots).filter((c) => c.islandId !== islandId && there(c)).map(startCwd).sort();
  const fallback = worker ? [] : [f.defaultCwd, f.home.cwd];
  return [...new Set([...first, ...own, ...rest, ...fallback])].map((path) => ({ path, label: shortPath(path) }));
}
