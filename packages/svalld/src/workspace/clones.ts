import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { FleetState, Island, MachineId, Robot } from '@svall/protocol';
import { Invalid } from '../errors.js';
import { cloneGit, must, type GitRunner } from '../links/git.js';
import { expandHome } from '../paths.js';
import { withoutToken } from '../placement/checks.js';
import { relocate } from '../placement/relocate.js';
import { startOf } from './island-folder.js';

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

export type StartFolder = { path: string; clone: boolean; remote?: string; from?: MachineId };
/** The origin of the clone at `path` on `machine`, when one is there. */
export type Probe = (machine: MachineId, path: string) => Promise<string | undefined>;

// the island's folder and its robots' folders: here when they are, else at the same place under this home, to clone from the
// machine a robot of the island works on
async function islandRows(state: FleetState, island: Island, runsHere: (c: Robot) => boolean, homedir: string, beside?: string, probe?: Probe): Promise<StartFolder[]> {
  const crew = Object.values(state.robots).filter((c) => c.islandId === island.id).sort((a, b) => Number(b.id === beside) - Number(a.id === beside));
  const rows: StartFolder[] = [];
  const held = (p: string) => rows.some((r) => r.path === p);
  const add = (p: string, repo = false) => { if (!held(p) && listable(p)) rows.push({ path: p, clone: repo || holdsClone(p) }); };
  if (island.folder) add(expandHome(island.folder, homedir));
  for (const c of crew.filter(runsHere)) add(startOf(c), !!c.repo);
  const asks: { from: MachineId; src: string; path: string }[] = [];
  for (const c of crew.filter((c) => !runsHere(c))) {
    const home = c.machine && state.machines?.[c.machine]?.home;
    if (!c.machine || !home) continue;
    for (const src of [...(island.folder ? [expandHome(island.folder, home)] : []), startOf(c)]) {
      const at = relocate(src, { from: home, to: homedir });
      add(at, !!c.repo && src === startOf(c));
      if (!held(at) && !fs.lstatSync(at, { throwIfNoEntry: false }) && !asks.some((a) => a.path === at)) asks.push({ from: c.machine, src, path: at });
    }
  }
  const remotes = await Promise.all(asks.map((a) => probe?.(a.from, a.src)));
  asks.forEach((a, n) => { const remote = remotes[n]; if (remote) rows.push({ path: a.path, clone: true, remote: withoutToken(remote), from: a.from }); });
  return rows;
}

/** Where a new robot can start on this machine, the folders still there alone: given an island, its folder and its robots' first,
 *  with those only another machine holds as clones to make here; then where each robot here starts from, the clones the fleet's
 *  default folder holds, then the fleet's own two folders, which `defaults` names as this machine spells them. `start`: the
 *  island's first, mission control's own folder. */
export async function startFolders(state: FleetState, runsHere: (c: Robot) => boolean, o: { islandId?: string; beside?: string; probe?: Probe; homedir?: string } = {}): Promise<{ folders: StartFolder[]; defaults: { cwd: string; home: string }; start?: string }> {
  const homedir = o.homedir ?? os.homedir();
  const robots = Object.values(state.robots).filter(runsHere);
  const inClone = new Set(robots.filter((c) => c.repo).map(startOf));
  const started = robots.map(startOf).sort();
  const defaults = { cwd: expandHome(state.defaultCwd, homedir), home: expandHome(state.home.cwd, homedir) };
  const island = o.islandId !== undefined && Object.hasOwn(state.islands, o.islandId) ? state.islands[o.islandId] : undefined;
  const own = island && island.kind !== 'home' ? await islandRows(state, island, runsHere, homedir, o.beside, o.probe) : [];
  const paths = [...new Set([...started, ...clonesIn(defaults.cwd), defaults.cwd, defaults.home])].filter((p) => !own.some((r) => r.path === p));
  const folders = [...own, ...paths.filter(listable).map((p) => ({ path: p, clone: inClone.has(p) || holdsClone(p) }))];
  const start = island?.kind === 'home' ? defaults.home : own[0]?.path;
  return { folders, defaults, ...(start && { start }) };
}

// one clone into a folder at a time; a robot started into it meanwhile waits and finds it there
const cloning = new Map<string, Promise<void>>();

/** Clones `remote` into `dest` when nothing is there. */
export async function cloneHere(remote: string, dest: string, git: GitRunner = cloneGit): Promise<void> {
  while (cloning.has(dest)) await cloning.get(dest)!.catch(() => {});
  if (fs.lstatSync(dest, { throwIfNoEntry: false })) return;
  const run = (async () => {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    try {
      await must(git, ['clone', '-q', '--', remote, dest], path.dirname(dest), dest);
    } catch (e) {
      throw new Invalid((e as Error).message);
    }
  })();
  cloning.set(dest, run);
  try { await run; } finally { cloning.delete(dest); }
}
