import type { Character, FleetState } from '@svall/protocol';
import { shortPath } from '../resources/model.js';
import { charactersOf } from '../selectors.js';

export type CwdChoice = { path: string; label: string };

// a character sat in a worktree offers its repo, never the worktree
const rootOf = (c: Character): string => (c.repo?.isWorktree ? c.repo.mainRoot : c.cwd);

/**
 * Where a new character may start without a path being typed: the island's own directories, then the
 * rest of the fleet's, then the fleet default. Home crew are offered the home cwd first.
 */
export function cwdChoices(f: FleetState, islandId: string): CwdChoice[] {
  const island = f.islands[islandId];
  const first = island?.kind === 'home' ? [f.home.cwd] : [];
  const own = island ? charactersOf(f, islandId).map(rootOf) : [];
  const rest = Object.values(f.characters).filter((c) => c.islandId !== islandId).map(rootOf).sort();
  return [...new Set([...first, ...own, ...rest, f.defaultCwd, f.home.cwd])].map((path) => ({ path, label: shortPath(path) }));
}

/** Where a character made with one tap starts: the home cwd for home crew, else its island's first repo, else the fleet default. */
export const islandCwd = (f: FleetState, islandId: string): string =>
  (f.islands[islandId]?.kind === 'home' ? f.home.cwd : charactersOf(f, islandId).map(rootOf)[0] ?? f.defaultCwd);
