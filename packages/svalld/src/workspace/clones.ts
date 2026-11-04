import fs from 'node:fs';
import path from 'node:path';
import type { FleetState, Robot } from '@svall/protocol';
import { expandHome } from '../paths.js';

/** Whether `p` leads to a folder; a path under a file answers ENOTDIR, which statSync's throwIfNoEntry lets through. */
export const isFolder = (p: string): boolean => {
  try { return fs.statSync(p).isDirectory(); } catch { return false; }
};
const holdsClone = (p: string): boolean => fs.existsSync(path.join(p, '.git'));

// a link is left out: it may lead anywhere, and what it leads to is listed where it is
function clonesIn(dir: string): string[] {
  try {
    return fs.readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory() && holdsClone(path.join(dir, d.name)))
      .map((d) => path.join(dir, d.name)).sort();
  } catch { return []; }
}

/** Where a new robot can start on this machine, the folders still there alone: where each robot here starts from, the clones the
 *  fleet's default folder holds, then the fleet's own two folders. */
export function startFolders(state: FleetState, runsHere: (c: Robot) => boolean): { path: string; clone: boolean }[] {
  const robots = Object.values(state.robots).filter(runsHere);
  const start = (c: Robot) => (c.repo?.isWorktree ? c.repo.mainRoot : c.cwd);
  const inClone = new Set(robots.filter((c) => c.repo).map(start));
  const started = robots.map(start).sort();
  const defaults = [state.defaultCwd, state.home.cwd].map((p) => expandHome(p));
  const paths = [...new Set([...started, ...clonesIn(defaults[0]), ...defaults])];
  return paths.filter(isFolder).map((p) => ({ path: p, clone: inClone.has(p) || holdsClone(p) }));
}
