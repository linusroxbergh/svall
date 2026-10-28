import type { FleetState } from '@svall/protocol';
import { shortPath } from '../paths.js';
import { robotsOf, startCwd } from '../selectors.js';

export type CwdChoice = { path: string; label: string };

/** Start directories offered without typing a path: the home cwd for home crew, then the island's own, then the rest. */
export function cwdChoices(f: FleetState, islandId: string): CwdChoice[] {
  const island = f.islands[islandId];
  const first = island?.kind === 'home' ? [f.home.cwd] : [];
  const own = island ? robotsOf(f, islandId).map(startCwd) : [];
  const rest = Object.values(f.robots).filter((c) => c.islandId !== islandId).map(startCwd).sort();
  return [...new Set([...first, ...own, ...rest, f.defaultCwd, f.home.cwd])].map((path) => ({ path, label: shortPath(path) }));
}
