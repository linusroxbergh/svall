import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { frontmatter, HOME_ISLAND, type Character, type Island } from '@svall/protocol';
import type { Logger } from './log.js';
import { expandHome } from './paths.js';

// the fleet's own folder stands above the rest and names no entity, so it alone has no id
export type EntityTier = 'repo' | 'island' | 'character';
export type DocTier = 'fleet' | EntityTier;
// name is the filename without .md; a frontmatter name never replaces it
export type DocEntry = { name: string; path: string; description?: string; error?: string };
export type DocFolder = { tier: DocTier; dir: string; docs: DocEntry[] };

const TREE: Record<EntityTier, string> = { repo: 'repos', island: 'islands', character: 'characters' };

/** Notes that hold for the whole fleet, whichever island or repository a session is on. */
export const fleetDir = (docs: string): string => path.join(docs, 'fleet');

/** A repository's folder name: its basename, made one safe segment, and eight hex characters of its main root's SHA-256. */
export const repoSlug = (mainRoot: string): string =>
  `${path.basename(mainRoot).replace(/[^A-Za-z0-9._]/g, '-')}-${crypto.createHash('sha256').update(mainRoot).digest('hex').slice(0, 8)}`;

export const docsDir = (docs: string, tier: EntityTier, id: string): string => path.join(docs, TREE[tier], id);

/** The main root a character's repository docs hang off, a worktree counted as its repository; mission control's crew has none. */
export const repoRootOf = (c: Character): string | undefined =>
  (c.islandId === HOME_ISLAND ? undefined : c.repo?.mainRoot ?? expandHome(c.cwd));

/** The .md files directly in `dir`. One that cannot be read is listed with its error; a link, a folder or another extension is left out. */
export function listDocs(dir: string): DocEntry[] {
  let found: fs.Dirent[];
  try { found = fs.readdirSync(dir, { withFileTypes: true }); } catch { return []; }
  return found.filter((d) => d.isFile() && d.name.endsWith('.md')).sort((a, b) => a.name.localeCompare(b.name)).map((d): DocEntry => {
    const file = path.join(dir, d.name), name = d.name.slice(0, -3);
    let text: string;
    try { text = fs.readFileSync(file, 'utf8'); }
    catch (e) { return { name, path: file, error: `cannot be read: ${(e as NodeJS.ErrnoException).code ?? 'unknown'}` }; }
    if (text.includes('\u0000')) return { name, path: file, error: 'is not text' };
    const { description } = frontmatter(text);
    return { name, path: file, ...(description && { description }) };
  });
}

/** The doc folders in scope, broad to narrow: the fleet, a character's repository, its island, itself; an island has the fleet's and its own. */
export function docFolders(docs: string, island: Island, character?: Character): DocFolder[] {
  const at = (tier: EntityTier, id: string): DocFolder => { const dir = docsDir(docs, tier, id); return { tier, dir, docs: listDocs(dir) }; };
  const repo = character && repoRootOf(character);
  const fleet: DocFolder = { tier: 'fleet', dir: fleetDir(docs), docs: listDocs(fleetDir(docs)) };
  return [fleet, ...(repo ? [at('repo', repoSlug(repo))] : []), at('island', island.id), ...(character ? [at('character', character.id)] : [])];
}

/** Removes a deleted entity's docs. A failure is logged and goes no further: a locked file must not keep an island from being deleted. */
export function removeDocs(docs: string, tier: 'island' | 'character', id: string, log: Pick<Logger, 'error'>): void {
  const dir = path.resolve(docsDir(docs, tier, id));
  if (path.dirname(dir) !== path.join(path.resolve(docs), TREE[tier])) { log.error(`docs: ${id} names no folder of its own`); return; }
  // rm takes a link away without following it
  try { fs.rmSync(dir, { recursive: true, force: true }); }
  catch (e) { log.error(`docs: ${dir} was not removed: ${(e as Error).message}`); }
}
