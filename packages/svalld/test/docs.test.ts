import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { HOME_ISLAND, type Character, type Island } from '@svall/protocol';
import { docFolders, docsDir, listDocs, removeDocs, repoRootOf, repoSlug } from '../src/docs.js';
import { resolvePaths } from '../src/paths.js';
import { cleanHomes, makeHome } from './helpers.js';

const put = (file: string, text: string) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); };
const doc = (description: string, name = 'ignored') => `---\nname: ${name}\ndescription: ${description}\n---\n# body\n`;
// only the fields the docs module reads
const island = (id: string) => ({ id, name: id }) as unknown as Island;
const char = (id: string, islandId: string, cwd: string, mainRoot?: string) =>
  ({ id, islandId, cwd, ...(mainRoot && { repo: { root: cwd, mainRoot, branch: 'main', isWorktree: cwd !== mainRoot } }) }) as unknown as Character;

afterEach(cleanHomes);

describe('resolvePaths', () => {
  it('puts docs under the svall home', () => {
    expect(resolvePaths('/x/home').docs).toBe('/x/home/docs');
  });
});

describe('repoSlug', () => {
  it('is the basename and eight hex characters of the main root, the same every time', () => {
    const slug = repoSlug('/Users/l/code/svall');
    expect(slug).toMatch(/^svall-[0-9a-f]{8}$/);
    expect(repoSlug('/Users/l/code/svall')).toBe(slug);
    expect(repoSlug('/Users/l/forks/svall')).not.toBe(slug);
  });
  it('writes anything unsafe in the basename as a hyphen', () => {
    expect(repoSlug('/r/my app (old)')).toMatch(/^my-app--old--[0-9a-f]{8}$/);
  });
});

describe('repoRootOf', () => {
  it('is the main root for a worktree, the folder for a plain character, and nothing for mission control', () => {
    expect(repoRootOf(char('a', 'i1', '/r/app/.claude/worktrees/x', '/r/app'))).toBe('/r/app');
    expect(repoRootOf(char('b', 'i1', '/plain'))).toBe('/plain');
    expect(repoRootOf(char('h', HOME_ISLAND, '/home/mc'))).toBeUndefined();
  });
});

describe('listDocs', () => {
  it('lists .md files by filename with the frontmatter description, in name order', () => {
    const dir = path.join(makeHome(), 'd');
    put(path.join(dir, 'b-plan.md'), doc('What is left.'));
    put(path.join(dir, 'a-notes.md'), doc('Why it broke.', 'Something Else'));
    expect(listDocs(dir)).toEqual([
      { name: 'a-notes', path: path.join(dir, 'a-notes.md'), description: 'Why it broke.', modifiedAt: expect.any(Number) },
      { name: 'b-plan', path: path.join(dir, 'b-plan.md'), description: 'What is left.', modifiedAt: expect.any(Number) },
    ]);
  });
  it('lists a file without frontmatter with no description', () => {
    const dir = path.join(makeHome(), 'd');
    put(path.join(dir, 'bare.md'), '# just text\n');
    expect(listDocs(dir)).toEqual([{ name: 'bare', path: path.join(dir, 'bare.md'), modifiedAt: expect.any(Number) }]);
  });
  it('ignores other extensions, subdirectories and links', () => {
    const home = makeHome(), dir = path.join(home, 'd');
    put(path.join(dir, 'keep.md'), doc('Kept.'));
    put(path.join(dir, 'notes.txt'), 'no');
    put(path.join(dir, 'sub/inner.md'), doc('Nested.'));
    put(path.join(home, 'outside.md'), doc('Outside.'));
    fs.symlinkSync(path.join(home, 'outside.md'), path.join(dir, 'link.md'));
    expect(listDocs(dir).map((d) => d.name)).toEqual(['keep']);
  });
  it('lists an unreadable file with its error, and a binary one too', () => {
    const dir = path.join(makeHome(), 'd');
    put(path.join(dir, 'locked.md'), doc('Locked.'));
    fs.chmodSync(path.join(dir, 'locked.md'), 0o000);
    put(path.join(dir, 'blob.md'), 'a\u0000b');
    const [blob, locked] = listDocs(dir);
    expect(blob).toEqual({ name: 'blob', path: path.join(dir, 'blob.md'), error: 'is not text' });
    expect(locked).toMatchObject({ name: 'locked', error: expect.stringContaining('cannot be read') });
    fs.chmodSync(path.join(dir, 'locked.md'), 0o644);
  });
  it('is empty for a folder that is not there', () => {
    expect(listDocs('/nowhere/at/all')).toEqual([]);
  });
});

describe('docFolders', () => {
  it('is fleet, repo, island, character for a character, and resolves a worktree to its main repository', () => {
    const docs = path.join(makeHome(), 'docs');
    const c = char('c1', 'i1', '/r/app/.claude/worktrees/x', '/r/app');
    put(path.join(docsDir(docs, 'repo', repoSlug('/r/app')), 'conventions.md'), doc('House style.'));
    put(path.join(docs, 'fleet', 'tone.md'), doc('How we write.'));
    const folders = docFolders(docs, island('i1'), c);
    expect(folders.map((f) => [f.tier, f.dir])).toEqual([
      ['fleet', path.join(docs, 'fleet')],
      ['repo', path.join(docs, 'repos', repoSlug('/r/app'))],
      ['island', path.join(docs, 'islands', 'i1')],
      ['character', path.join(docs, 'characters', 'c1')],
    ]);
    expect(folders[0].docs.map((d) => d.name)).toEqual(['tone']);
    expect(folders[1].docs.map((d) => d.name)).toEqual(['conventions']);
    expect(folders[2].docs).toEqual([]);
  });
  it('has no repo folder for a home character, and mission control resolves from islands/home', () => {
    const docs = path.join(makeHome(), 'docs');
    put(path.join(docs, 'islands', HOME_ISLAND, 'standing.md'), doc('Standing orders.'));
    const folders = docFolders(docs, island(HOME_ISLAND), char('h', HOME_ISLAND, '/home/mc'));
    expect(folders.map((f) => f.tier)).toEqual(['fleet', 'island', 'character']);
    expect(folders[1].docs.map((d) => d.name)).toEqual(['standing']);
  });
  it('is the fleet and the island alone without a character', () => {
    expect(docFolders('/d', island('i1')).map((f) => f.tier)).toEqual(['fleet', 'island']);
  });
});

describe('removeDocs', () => {
  const log = () => { const lines: string[] = []; return { lines, error: (m: string) => { lines.push(m); } }; };
  it('removes the entity’s folder and leaves its siblings', () => {
    const docs = path.join(makeHome(), 'docs');
    put(path.join(docs, 'islands/i1/a.md'), doc('A.'));
    put(path.join(docs, 'islands/i2/b.md'), doc('B.'));
    put(path.join(docs, 'characters/i1/c.md'), doc('C.'));
    removeDocs(docs, 'island', 'i1', log());
    expect(fs.existsSync(path.join(docs, 'islands/i1'))).toBe(false);
    expect(fs.existsSync(path.join(docs, 'islands/i2/b.md'))).toBe(true);
    expect(fs.existsSync(path.join(docs, 'characters/i1/c.md'))).toBe(true);
  });
  it('says nothing about a folder that was never made', () => {
    const l = log();
    removeDocs(path.join(makeHome(), 'docs'), 'character', 'c9', l);
    expect(l.lines).toEqual([]);
  });
  it('refuses an id that climbs out of its tree', () => {
    const home = makeHome(), docs = path.join(home, 'docs');
    put(path.join(home, 'precious/x.md'), 'keep');
    const l = log();
    removeDocs(docs, 'island', '../../precious', l);
    expect(fs.existsSync(path.join(home, 'precious/x.md'))).toBe(true);
    expect(l.lines).toHaveLength(1);
  });
  it('removes a folder that is a link without following it', () => {
    const home = makeHome(), docs = path.join(home, 'docs');
    put(path.join(home, 'target/x.md'), 'keep');
    fs.mkdirSync(path.join(docs, 'islands'), { recursive: true });
    fs.symlinkSync(path.join(home, 'target'), path.join(docs, 'islands/i1'));
    removeDocs(docs, 'island', 'i1', log());
    expect(fs.existsSync(path.join(docs, 'islands/i1'))).toBe(false);
    expect(fs.existsSync(path.join(home, 'target/x.md'))).toBe(true);
  });
  it('logs a removal that fails and does not throw', () => {
    const docs = path.join(makeHome(), 'docs');
    put(path.join(docs, 'islands/i1/a.md'), doc('A.'));
    fs.chmodSync(path.join(docs, 'islands'), 0o500);
    const l = log();
    expect(() => removeDocs(docs, 'island', 'i1', l)).not.toThrow();
    fs.chmodSync(path.join(docs, 'islands'), 0o700);
    expect(l.lines).toHaveLength(1);
  });
});
