import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { HOME_ISLAND, type Robot, type Island } from '@svall/protocol';
import { docFolders, docsDir, liftRobotDocs, listDocs, removeDocs, repoRootOf, repoSlug } from '../src/docs.js';
import { resolvePaths } from '../src/paths.js';
import { homeRootOf } from '../src/placement/repo-key.js';
import { cleanHomes, makeHome } from './helpers.js';
import { W, placed } from './placement/world.js';

const put = (file: string, text: string) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); };
const doc = (description: string, name = 'ignored') => `---\nname: ${name}\ndescription: ${description}\n---\n# body\n`;
// only the fields the docs module reads
const island = (id: string) => ({ id, name: id }) as unknown as Island;
const robot = (id: string, islandId: string, cwd: string, mainRoot?: string) =>
  ({ id, islandId, cwd, ...(mainRoot && { repo: { root: cwd, mainRoot, branch: 'main', isWorktree: cwd !== mainRoot } }) }) as unknown as Robot;

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
  it('is the main root for a worktree, the folder for a plain robot, and nothing for mission control', () => {
    expect(repoRootOf(robot('a', 'i1', '/r/app/.claude/worktrees/x', '/r/app'))).toBe('/r/app');
    expect(repoRootOf(robot('b', 'i1', '/plain'))).toBe('/plain');
    expect(repoRootOf(robot('h', HOME_ISLAND, '/home/mc'))).toBeUndefined();
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
  // every prompt lists the docs in scope, so a long one is read only as far as its frontmatter can reach
  it('reads a long doc only at its head', () => {
    const dir = path.join(makeHome(), 'd');
    put(path.join(dir, 'log.md'), `${doc('A pasted log.')}${'x'.repeat(1024 * 1024)}\u0000`);
    expect(listDocs(dir)).toEqual([{ name: 'log', path: path.join(dir, 'log.md'), description: 'A pasted log.', modifiedAt: expect.any(Number) }]);
  });
});

describe('docFolders', () => {
  it('is fleet, repo, island, robot for a robot, and resolves a worktree to its main repository', () => {
    const docs = path.join(makeHome(), 'docs');
    const c = robot('c1', 'i1', '/r/app/.claude/worktrees/x', '/r/app');
    put(path.join(docsDir(docs, 'repo', repoSlug('/r/app')), 'conventions.md'), doc('House style.'));
    put(path.join(docs, 'fleet', 'tone.md'), doc('How we write.'));
    const folders = docFolders(docs, island('i1'), c);
    expect(folders.map((f) => [f.tier, f.dir])).toEqual([
      ['fleet', path.join(docs, 'fleet')],
      ['repo', path.join(docs, 'repos', repoSlug('/r/app'))],
      ['island', path.join(docs, 'islands', 'i1')],
      ['robot', path.join(docs, 'robots', 'c1')],
    ]);
    expect(folders[0].docs.map((d) => d.name)).toEqual(['tone']);
    expect(folders[1].docs.map((d) => d.name)).toEqual(['conventions']);
    expect(folders[2].docs).toEqual([]);
  });
  it('has no repo folder for a home robot, and mission control resolves from islands/home', () => {
    const docs = path.join(makeHome(), 'docs');
    put(path.join(docs, 'islands', HOME_ISLAND, 'standing.md'), doc('Standing orders.'));
    const folders = docFolders(docs, island(HOME_ISLAND), robot('h', HOME_ISLAND, '/home/mc'));
    expect(folders.map((f) => f.tier)).toEqual(['fleet', 'island', 'robot']);
    expect(folders[1].docs.map((d) => d.name)).toEqual(['standing']);
  });
  it('is the fleet and the island alone without a robot', () => {
    expect(docFolders('/d', island('i1')).map((f) => f.tier)).toEqual(['fleet', 'island']);
  });
  it('a placed robot\'s repo docs hang off the home\'s main root, not the clone path, on both machines', () => {
    const c = placed({ id: 'c_1', repo: { root: '/home/ada/code/app/.claude/worktrees/kb', mainRoot: '/home/ada/code/app', branch: 'kb', isWorktree: true } });
    expect(homeRootOf(c, { [W]: { name: 'w1', reachable: true, since: 1, home: '/home/ada' } }, '/Users/ada')).toBe('/Users/ada/code/app');
    // a worker before its first snapshot names the clone's
    expect(homeRootOf(c, { [W]: { name: 'w1', reachable: true, since: 1, home: '/home/ada' } }, undefined)).toBe('/home/ada/code/app');
    expect(docFolders('/d', island('i_1'), c, '/Users/ada/code/app')[1].dir).toBe(`/d/repos/${repoSlug('/Users/ada/code/app')}`);
  });
});

describe('removeDocs', () => {
  const log = () => { const lines: string[] = []; return { lines, error: (m: string) => { lines.push(m); } }; };
  it('removes the entity’s folder and leaves its siblings', () => {
    const docs = path.join(makeHome(), 'docs');
    put(path.join(docs, 'islands/i1/a.md'), doc('A.'));
    put(path.join(docs, 'islands/i2/b.md'), doc('B.'));
    put(path.join(docs, 'robots/i1/c.md'), doc('C.'));
    removeDocs(docs, 'island', 'i1', log());
    expect(fs.existsSync(path.join(docs, 'islands/i1'))).toBe(false);
    expect(fs.existsSync(path.join(docs, 'islands/i2/b.md'))).toBe(true);
    expect(fs.existsSync(path.join(docs, 'robots/i1/c.md'))).toBe(true);
  });
  it('says nothing about a folder that was never made', () => {
    const l = log();
    removeDocs(path.join(makeHome(), 'docs'), 'robot', 'c9', l);
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

describe('liftRobotDocs', () => {
  it("moves the robots' notes out of the characters folder, joins one written there later to the robot's, and replaces none", () => {
    const docs = resolvePaths(makeHome()).docs;
    const lines: string[] = [];
    const log = { error: (m: string) => { lines.push(m); } };
    const robotDir = (id: string) => docsDir(docs, 'robot', id);
    put(path.join(docs, 'characters', 'c1', 'a.md'), doc('A.'));
    liftRobotDocs(docs, log);
    expect(fs.existsSync(path.join(docs, 'characters'))).toBe(false);
    expect(fs.readFileSync(path.join(robotDir('c1'), 'a.md'), 'utf8')).toBe(doc('A.'));
    put(path.join(docs, 'characters', 'c1', 'a.md'), doc('Later.'));
    put(path.join(docs, 'characters', 'c1', 'b.md'), doc('B.'));
    put(path.join(docs, 'characters', 'c2', 'c.md'), doc('C.'));
    liftRobotDocs(docs, log);
    expect(fs.readdirSync(robotDir('c1')).sort()).toEqual(['a.md', 'b.md']);
    expect(fs.readFileSync(path.join(robotDir('c1'), 'a.md'), 'utf8')).toBe(doc('A.'));
    expect(fs.readdirSync(path.join(docs, 'characters'))).toEqual(['c1']);
    expect(fs.existsSync(path.join(robotDir('c2'), 'c.md'))).toBe(true);
    expect(lines).toEqual([]);
  });
});
