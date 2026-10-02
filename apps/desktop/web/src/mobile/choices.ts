import type { FleetState } from '@svall/protocol';
import { shortPath } from '../resources/model.js';
import { charactersOf, startCwd } from '../selectors.js';

export type CwdChoice = { path: string; label: string };

/**
 * Where a new character may start without a path being typed: the island's own directories, then the
 * rest of the fleet's, then the fleet default. Home crew are offered the home cwd first.
 */
export function cwdChoices(f: FleetState, islandId: string): CwdChoice[] {
  const island = f.islands[islandId];
  const first = island?.kind === 'home' ? [f.home.cwd] : [];
  const own = island ? charactersOf(f, islandId).map(startCwd) : [];
  const rest = Object.values(f.characters).filter((c) => c.islandId !== islandId).map(startCwd).sort();
  return [...new Set([...first, ...own, ...rest, f.defaultCwd, f.home.cwd])].map((path) => ({ path, label: shortPath(path) }));
}
