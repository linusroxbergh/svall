import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { handoverGit } from '../../src/links/git.js';
import { convertMainCheckout, worktreeSlug } from '../../src/placement/convert.js';
import { git, hasGit } from '../handover/git-fixture.js';
import { cleanHomes, makeHome } from '../helpers.js';

afterEach(cleanHomes);

const put = (root: string, rel: string, data: string): void => {
  fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  fs.writeFileSync(path.join(root, rel), data);
};

// a main checkout with one commit, in a real folder the fixture's git reads with an empty global configuration
function mainCheckout(): { base: string; main: string; g: (cwd: string, ...args: string[]) => string } {
  const base = fs.realpathSync(makeHome());
  fs.writeFileSync(path.join(base, 'gitconfig'), '');
  const g = (cwd: string, ...args: string[]): string => git(base, cwd, ...args);
  const main = path.join(base, 'app');
  g(base, 'init', '-q', main);
  put(main, 'a.txt', 'one\n');
  put(main, 'b.txt', 'two\n');
  put(main, '.gitignore', 'build/\n');
  g(main, 'add', '.');
  g(main, 'commit', '-qm', 'base');
  return { base, main, g };
}

const stashes = (g: (cwd: string, ...args: string[]) => string, main: string): string => g(main, 'stash', 'list', '--format=%H %gs');

describe.skipIf(!hasGit)('convertMainCheckout', () => {
  it('a clean main with an older stash on the stack converts without touching the stash list', async () => {
    const { main, g } = mainCheckout();
    put(main, 'a.txt', 'stashed\n');
    g(main, 'stash', 'push', '-q', '-m', 'older');
    const before = stashes(g, main);
    expect(before).toMatch(/ On main: older$/);
    const head = g(main, 'rev-parse', 'HEAD');

    const r = await convertMainCheckout(main, { git: handoverGit, slug: 'kanban-board' });
    expect(r).toEqual({ root: path.join(main, '.claude/worktrees/kanban-board'), branch: 'kanban-board' });
    expect(stashes(g, main)).toBe(before);
    expect(stashes(g, r.root)).toBe(before);
    expect(g(r.root, 'rev-parse', 'HEAD')).toBe(head);
    expect(g(r.root, 'symbolic-ref', '--short', 'HEAD')).toBe('kanban-board');
    expect(g(r.root, 'status', '--porcelain')).toBe('');
    expect(g(main, 'symbolic-ref', '--short', 'HEAD')).toBe('main');
    expect(g(main, 'status', '--porcelain')).toBe('?? .claude/');
  });

  it('staged and unstaged changes keep their split in the new worktree, and main is clean afterwards', async () => {
    const { main, g } = mainCheckout();
    put(main, 'b.txt', 'stashed\n');
    g(main, 'stash', 'push', '-q', '-m', 'older');
    put(main, 'a.txt', 'one\nstaged\n');
    put(main, 'new.txt', 'staged new\n');
    g(main, 'add', 'a.txt', 'new.txt');
    put(main, 'a.txt', 'one\nstaged\nunstaged\n');
    fs.rmSync(path.join(main, 'b.txt'));
    put(main, 'notes/todo.md', 'todo\n');
    put(main, '.env', 'SECRET=1\n');
    put(main, 'build/out.o', 'ignored\n');
    const [staged, unstaged, stash] = [g(main, 'diff', '--cached'), g(main, 'diff'), stashes(g, main)];
    expect(staged).toContain('+staged new');
    expect(unstaged).toContain('+unstaged');

    const r = await convertMainCheckout(main, { git: handoverGit, slug: 'kanban' });
    expect(g(r.root, 'diff', '--cached')).toBe(staged);
    expect(g(r.root, 'diff')).toBe(unstaged);
    expect(fs.readFileSync(path.join(r.root, 'notes/todo.md'), 'utf8')).toBe('todo\n');
    expect(fs.readFileSync(path.join(r.root, '.env'), 'utf8')).toBe('SECRET=1\n');
    expect(fs.existsSync(path.join(r.root, 'build'))).toBe(false);

    expect(g(main, 'status', '--porcelain')).toBe('?? .claude/');
    expect(fs.readFileSync(path.join(main, 'a.txt'), 'utf8')).toBe('one\n');
    expect(fs.readFileSync(path.join(main, 'b.txt'), 'utf8')).toBe('two\n');
    expect(fs.existsSync(path.join(main, 'new.txt'))).toBe(false);
    expect(fs.existsSync(path.join(main, 'notes'))).toBe(false);
    expect(fs.existsSync(path.join(main, '.env'))).toBe(false);
    expect(fs.readFileSync(path.join(main, 'build/out.o'), 'utf8')).toBe('ignored\n');
    expect(stashes(g, main)).toBe(stash);
  });

  it('a submodule\'s own uncommitted edits stay in main even when the config says submodule.recurse', async () => {
    const { base, main, g } = mainCheckout();
    const lib = path.join(base, 'lib');
    g(base, 'init', '-q', lib);
    put(lib, 'f.txt', 'v1\n');
    g(lib, 'add', '.');
    g(lib, 'commit', '-qm', 'lib');
    g(main, 'submodule', 'add', '-q', lib, 'lib');
    g(main, 'commit', '-qm', 'add lib');
    g(main, 'config', 'submodule.recurse', 'true');
    put(main, 'lib/f.txt', 'DIRTY\n');
    put(main, 'a.txt', 'one\nstaged\n');
    g(main, 'add', 'a.txt');

    const r = await convertMainCheckout(main, { git: handoverGit, slug: 'kanban' });
    expect(fs.readFileSync(path.join(main, 'lib/f.txt'), 'utf8')).toBe('DIRTY\n');
    expect(g(r.root, 'diff', '--cached', '--name-only')).toBe('a.txt');
    expect(fs.readFileSync(path.join(main, 'a.txt'), 'utf8')).toBe('one\n');
  });

  it('refuses, touching nothing, while an assume-unchanged file or a merge in progress would be lost', async () => {
    const hidden = mainCheckout();
    hidden.g(hidden.main, 'update-index', '--assume-unchanged', 'a.txt');
    put(hidden.main, 'a.txt', 'LOCAL\n');
    await expect(convertMainCheckout(hidden.main, { git: handoverGit, slug: 'kanban' })).rejects.toThrow(/a\.txt.*assume-unchanged/);
    expect(fs.readFileSync(path.join(hidden.main, 'a.txt'), 'utf8')).toBe('LOCAL\n');
    expect(fs.existsSync(path.join(hidden.main, '.claude'))).toBe(false);
    expect(hidden.g(hidden.main, 'branch', '--list', 'kanban')).toBe('');

    const merging = mainCheckout();
    merging.g(merging.main, 'checkout', '-q', '-b', 'other');
    put(merging.main, 'o.txt', 'other\n');
    merging.g(merging.main, 'add', '.');
    merging.g(merging.main, 'commit', '-qm', 'other');
    merging.g(merging.main, 'checkout', '-q', 'main');
    merging.g(merging.main, 'merge', '-q', '--no-ff', '--no-commit', 'other');
    await expect(convertMainCheckout(merging.main, { git: handoverGit, slug: 'kanban' })).rejects.toThrow(/merge/);
    expect(fs.existsSync(path.join(merging.main, '.git/MERGE_HEAD'))).toBe(true);
    expect(fs.existsSync(path.join(merging.main, '.claude'))).toBe(false);
  });

  it('feat/kanban on robot "Kanban Board" slugs to kanban-board and avoids a taken name', async () => {
    const { main, g } = mainCheckout();
    g(main, 'checkout', '-q', '-b', 'feat/kanban');
    const o = { main, git: handoverGit };
    expect(await worktreeSlug('Kanban Board', 'feat/kanban', o)).toBe('kanban-board');
    g(main, 'branch', 'kanban-board');
    expect(await worktreeSlug('Kanban Board', 'feat/kanban', o)).toBe('kanban-board-2');
    fs.mkdirSync(path.join(main, '.claude/worktrees/kanban-board-2'), { recursive: true });
    const slug = await worktreeSlug('Kanban Board', 'feat/kanban', o);
    expect(slug).toBe('kanban-board-3');
    expect(await worktreeSlug('ロボット', 'feat/kanban', o)).toBe('feat-kanban');
    expect(await worktreeSlug(`${'Very Long Robot Name '.repeat(4)}`, 'feat/kanban', o)).toBe('very-long-robot-name-very-long-robot-nam');

    const r = await convertMainCheckout(main, { git: handoverGit, slug });
    expect(r).toEqual({ root: path.join(main, '.claude/worktrees/kanban-board-3'), branch: 'kanban-board-3' });
    expect(g(main, 'symbolic-ref', '--short', 'HEAD')).toBe('feat/kanban');
  });
});
