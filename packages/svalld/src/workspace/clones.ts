import fs from 'node:fs';
import path from 'node:path';
import type { FleetState, Robot } from '@svall/protocol';
import { expandHome } from '../paths.js';

/** Whether `p` leads to a folder. A path that is not there is no folder; anything else, such as one it may not read, is thrown for the caller to say. */
export function isFolder(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch (e) {
    const { code } = e as NodeJS.ErrnoException;
    if (code === 'ENOENT' || code === 'ENOTDIR') return false;
    throw e;
  }
}

// one folder it cannot read does not cost the whole list
const listable = (p: string): boolean => {
  try { return isFolder(p); } catch { return false; }
};
const holdsClone = (p: string): boolean => fs.existsSync(path.join(p, '.git'));

// a link is left out, as it may lead anywhere and what it leads to is listed where it is, and a dot folder, which is a tool's checkout
function clonesIn(dir: string): string[] {
  try {
    return fs.readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory() && !d.name.startsWith('.') && holdsClone(path.join(dir, d.name)))
      .map((d) => path.join(dir, d.name)).sort();
  } catch { return []; }
}

/** Where a new robot can start on this machine, the folders still there alone: where each robot here starts from, the clones the
 *  fleet's default folder holds, then the fleet's own two folders, which `defaults` names as this machine spells them. */
export function startFolders(state: FleetState, runsHere: (c: Robot) => boolean): { folders: { path: string; clone: boolean }[]; defaults: { cwd: string; home: string } } {
  const robots = Object.values(state.robots).filter(runsHere);
  const start = (c: Robot) => (c.repo?.isWorktree ? c.repo.mainRoot : c.cwd);
  const inClone = new Set(robots.filter((c) => c.repo).map(start));
  const started = robots.map(start).sort();
  const defaults = { cwd: expandHome(state.defaultCwd), home: expandHome(state.home.cwd) };
  const paths = [...new Set([...started, ...clonesIn(defaults.cwd), defaults.cwd, defaults.home])];
  return { folders: paths.filter(listable).map((p) => ({ path: p, clone: inClone.has(p) || holdsClone(p) })), defaults };
}
