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
// a place under a file, or one it may not look at, is no place to clone into
const absent = (p: string): boolean => {
  try { return !fs.lstatSync(p, { throwIfNoEntry: false }); } catch { return false; }
};

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
// machine that holds them, any machine for the island's folder
async function islandRows(state: FleetState, island: Island, runsHere: (c: Robot) => boolean, homedir: string, beside?: string, probe?: Probe): Promise<StartFolder[]> {
  const crew = Object.values(state.robots).filter((c) => c.islandId === island.id).sort((a, b) => Number(b.id === beside) - Number(a.id === beside));
  const rows: StartFolder[] = [];
  const held = (p: string) => rows.some((r) => r.path === p);
  const add = (p: string, repo = false) => { if (!held(p) && listable(p)) rows.push({ path: p, clone: repo || holdsClone(p) }); };
  if (island.folder) add(expandHome(island.folder, homedir));
  for (const c of crew.filter(runsHere)) add(startOf(c), !!c.repo);
  const homeOf = (m?: MachineId): string | undefined => (m && state.machines?.[m]?.home) || undefined;
  const sources: { from: MachineId; src: string; repo?: boolean }[] = [];
  for (const c of crew.filter((c) => !runsHere(c))) {
    const home = homeOf(c.machine);
    if (!home) continue;
    if (island.folder) sources.push({ from: c.machine!, src: expandHome(island.folder, home) });
    sources.push({ from: c.machine!, src: startOf(c), repo: !!c.repo });
  }
  for (const m of island.folder ? Object.keys(state.machines ?? {}) as MachineId[] : []) {
    const home = homeOf(m);
    if (home) sources.push({ from: m, src: expandHome(island.folder!, home) });
  }
  const asks: { from: MachineId; src: string; path: string }[] = [];
  for (const { from, src, repo } of sources) {
    const at = relocate(src, { from: homeOf(from)!, to: homedir });
    add(at, repo);
    if (!held(at) && absent(at) && !asks.some((a) => a.path === at)) asks.push({ from, src, path: at });
  }
  const remotes = await Promise.all(asks.map((a) => probe?.(a.from, a.src)));
  asks.forEach((a, n) => { const remote = remotes[n]; if (remote) rows.push({ path: a.path, clone: true, remote: withoutToken(remote), from: a.from }); });
  return rows;
}

/** Where a new robot can start on this machine: an island's own folders first, `start` the first of them; then each robot's here,
 *  the clones in the fleet's default folder, and the fleet's two folders, which `defaults` spells as this machine does. */
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
export async function cloneHere(remote: string, to: string, git: GitRunner = cloneGit): Promise<void> {
  const dest = path.resolve(to);
  while (cloning.has(dest)) await cloning.get(dest)!.catch(() => {});
  if (fs.lstatSync(dest, { throwIfNoEntry: false })) return;
  const run = (async () => {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    try {
      await must(git, ['clone', '-q', '--', remote, dest], path.dirname(dest), dest);
    } catch (e) {
      // git keeps a clone whose checkout failed, which would pass for a finished one; a folder made before it began is not its
      if (!/already exists/.test((e as Error).message)) fs.rmSync(dest, { recursive: true, force: true });
      throw new Invalid((e as Error).message);
    }
  })();
  cloning.set(dest, run);
  try { await run; } finally { cloning.delete(dest); }
}
