import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { bodyOf, frontmatter, HOME_ISLAND, type Robot, type Island } from '@svall/protocol';
import type { Logger } from './log.js';
import { expandHome } from './paths.js';

// the fleet's own folder stands above the rest and names no entity, so it alone has no id
type EntityTier = 'repo' | 'island' | 'robot';
export type DocTier = 'fleet' | EntityTier;
// name is the filename without .md; a frontmatter name never replaces it
export type DocEntry = { name: string; path: string; description?: string; body?: string; modifiedAt?: number; error?: string };
export type DocFolder = { tier: DocTier; dir: string; docs: DocEntry[] };

const TREE: Record<EntityTier, string> = { repo: 'repos', island: 'islands', robot: 'robots' };
// only a doc's head is read, so a long doc costs every prompt no more than a short one
const HEAD_MAX = 64 * 1024;

/** Notes that hold for the whole fleet, whichever island or repository a session is on. */
export const fleetDir = (docs: string): string => path.join(docs, 'fleet');

/** A repository's folder name: its basename, made one safe segment, and eight hex characters of its main root's SHA-256. */
export const repoSlug = (mainRoot: string): string =>
  `${path.basename(mainRoot).replace(/[^A-Za-z0-9._]/g, '-')}-${crypto.createHash('sha256').update(mainRoot).digest('hex').slice(0, 8)}`;

export const docsDir = (docs: string, tier: EntityTier, id: string): string => path.join(docs, TREE[tier], id);

/** Moves the robots' notes out of docs/characters, where an older svalld and the sessions it started keep them. */
export function liftRobotDocs(docs: string, log: Pick<Logger, 'error'>): void {
  const from = path.join(docs, 'characters');
  if (!fs.existsSync(from)) return;
  for (const id of fs.readdirSync(from)) {
    const was = path.join(from, id);
    const to = docsDir(docs, 'robot', id);
    try {
      if (!fs.existsSync(to)) {
        fs.mkdirSync(path.dirname(to), { recursive: true });
        fs.renameSync(was, to);
        continue;
      }
      // a note never replaces one of the same name, which stays behind for the next start
      for (const f of fs.readdirSync(was)) if (!fs.existsSync(path.join(to, f))) fs.renameSync(path.join(was, f), path.join(to, f));
      if (fs.readdirSync(was).length === 0) fs.rmdirSync(was);
    } catch (e) { log.error(`docs: ${was} stays where it is: ${(e as Error).message}`); }
  }
  if (fs.readdirSync(from).length === 0) fs.rmdirSync(from);
}

/**
 * The main root a robot's repository docs hang off, a worktree counted as its repository, with `~` read against
 * `home`; mission control's crew has none.
 */
export const repoRootOf = (c: Robot, home?: string): string | undefined =>
  (c.islandId === HOME_ISLAND ? undefined : c.repo?.mainRoot ?? expandHome(c.cwd, home));

function readHead(file: string): string {
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.allocUnsafe(HEAD_MAX);
    return buf.toString('utf8', 0, fs.readSync(fd, buf, 0, HEAD_MAX, 0));
  } finally { fs.closeSync(fd); }
}

/** The .md files directly in `dir`, with `withBody` each one's text after its frontmatter. One that cannot be read is listed with its error; a link, a folder or another extension is left out. */
export function listDocs(dir: string, withBody = false): DocEntry[] {
  let found: fs.Dirent[];
  try { found = fs.readdirSync(dir, { withFileTypes: true }); } catch { return []; }
  return found.filter((d) => d.isFile() && d.name.endsWith('.md')).sort((a, b) => a.name.localeCompare(b.name)).map((d): DocEntry => {
    const file = path.join(dir, d.name), name = d.name.slice(0, -3);
    let text: string, modifiedAt: number;
    try { text = readHead(file); modifiedAt = fs.statSync(file).mtimeMs; }
    catch (e) { return { name, path: file, error: `cannot be read: ${(e as NodeJS.ErrnoException).code ?? 'unknown'}` }; }
    if (text.includes('\u0000')) return { name, path: file, error: 'is not text' };
    const { description } = frontmatter(text);
    const body = withBody ? bodyOf(text).trim() : '';
    return { name, path: file, ...(description && { description }), ...(body && { body }), modifiedAt };
  });
}

/** The doc folders in scope, broad to narrow: the fleet, a robot's repository at `repoRoot`, its island, itself; an island has the fleet's and its own. */
export function docFolders(docs: string, island: Island, robot?: Robot, repoRoot = robot && repoRootOf(robot)): DocFolder[] {
  const at = (tier: EntityTier, id: string): DocFolder => { const dir = docsDir(docs, tier, id); return { tier, dir, docs: listDocs(dir) }; };
  const fleet: DocFolder = { tier: 'fleet', dir: fleetDir(docs), docs: listDocs(fleetDir(docs), true) };
  return [fleet, ...(repoRoot ? [at('repo', repoSlug(repoRoot))] : []), at('island', island.id), ...(robot ? [at('robot', robot.id)] : [])];
}

/** Removes a deleted entity's docs. A failure is logged and goes no further: a locked file must not keep an island from being deleted. */
export function removeDocs(docs: string, tier: 'island' | 'robot', id: string, log: Pick<Logger, 'error'>): void {
  const dir = path.resolve(docsDir(docs, tier, id));
  if (path.dirname(dir) !== path.join(path.resolve(docs), TREE[tier])) { log.error(`docs: ${id} names no folder of its own`); return; }
  // rm takes a link away without following it
  try { fs.rmSync(dir, { recursive: true, force: true }); }
  catch (e) { log.error(`docs: ${dir} was not removed: ${(e as Error).message}`); }
}
