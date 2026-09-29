import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { TransferFile } from '@svall/protocol';
import { compareReplica, divergenceBlocker, diverged, proveReplica } from '../../src/handover/divergence.js';
import { DEFAULT_EXCLUDES, excludeMatcher } from '../../src/handover/inventory.js';
import { scanPath } from '../../src/handover/manifest.js';

const made: string[] = [];
const tmp = (): string => { const d = fs.mkdtempSync('/tmp/svall-t-'); made.push(d); return d; };
afterEach(() => { for (const d of made.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });

const file = (p: string, sha = 'a', mode = 0o644): Extract<TransferFile, { type: 'file' }> => ({ type: 'file', path: p, mode, size: 1, mtimeMs: 0, sha256: sha.repeat(64) });
const link = (p: string, target: string): TransferFile => ({ type: 'symlink', path: p, target });
const content = async (root: string, excludes: readonly string[]): Promise<TransferFile[]> => (await scanPath(root, excludeMatcher(excludes)))?.files ?? [];
const write = (base: string, rel: string, text: string): void => {
  fs.mkdirSync(path.dirname(path.join(base, rel)), { recursive: true });
  fs.writeFileSync(path.join(base, rel), text);
};

describe('compareReplica', () => {
  it('finds nothing when every path matches its baseline, whatever its mtime', () => {
    const d = compareReplica([[file('a'), link('l', 'a')]], [{ ...file('a'), mtimeMs: 99 }, link('l', 'a')]);
    expect(diverged(d)).toBe(false);
  });

  it('lists added, removed and changed paths in order, with every count and a bounded preview', () => {
    const baseline = [file('keep'), file('gone'), file('edit')];
    const added = Array.from({ length: 12 }, (_, i) => file(`new-${String(12 - i).padStart(2, '0')}`));
    const d = compareReplica([baseline], [file('keep'), file('edit', 'b'), ...added]);
    expect(d.added).toEqual({ count: 12, preview: Array.from({ length: 10 }, (_, i) => `new-${String(i + 1).padStart(2, '0')}`) });
    expect(d.removed).toEqual({ count: 1, preview: ['gone'] });
    expect(d.changed).toEqual({ count: 1, preview: ['edit'] });
    expect(d.unchecked).toEqual({ count: 0, preview: [] });
    expect(compareReplica([baseline], [file('keep'), ...added], [], 3).added.preview).toEqual(['new-01', 'new-02', 'new-03']);
  });

  it('counts a mode change, a retargeted link and a file turned link as changed', () => {
    const d = compareReplica([[file('run.sh', 'a', 0o755), link('l', 'a'), file('f')]], [file('run.sh', 'a', 0o644), link('l', 'b'), link('f', 'a')]);
    expect(d.changed.preview).toEqual(['f', 'l', 'run.sh']);
    expect(d.added.count + d.removed.count).toBe(0);
  });

  it('accepts either version of a path while a transfer was part way, and nothing else', () => {
    const baseline = [file('a'), file('b'), file('c')];
    const incoming = [file('a', 'b'), file('c'), file('d')];
    // a arrived, b was deleted as the source had, d has not arrived yet; c both versions hold, so it was removed by hand
    const partial = compareReplica([baseline, incoming], [file('a', 'b'), file('e')]);
    expect(partial.removed.preview).toEqual(['c']);
    expect(partial.added.preview).toEqual(['e']);
    expect(partial.changed.count).toBe(0);
    const edited = compareReplica([baseline, incoming], [file('a', 'c'), file('b'), file('c'), file('d')]);
    expect(edited.changed.preview).toEqual(['a']);
    expect(edited.added.count + edited.removed.count).toBe(0);
  });

  it('counts what could not be read as divergence', () => {
    const d = compareReplica([[]], [], ['locked: EACCES']);
    expect(diverged(d)).toBe(true);
    expect(d.unchecked).toEqual({ count: 1, preview: ['locked: EACCES'] });
  });
});

describe('compareReplica on Git state', () => {
  const index = (p: string, sha: string, staged: string | undefined): TransferFile => ({ ...file(p, sha), ...(staged && { gitIndex: staged.repeat(64) }) });
  const repo = (git: string, extra: TransferFile[] = []): TransferFile[] =>
    [file(`${git}/HEAD`), file(`${git}/refs/heads/main`), index(`${git}/index`, 'a', 'e'), file(`${git}/logs/HEAD`), ...extra];

  it('reads a status refresh and a fetch as no change: FETCH_HEAD, remote and prefetch refs, and objects carry no work', () => {
    const baseline = [...repo('.git', [file('.git/objects/ab/cd'), file('.git/worktrees/w/HEAD'), index('.git/worktrees/w/index', 'a', 'f')]), ...repo('.git/modules/sub')];
    // refreshed indexes, a fetch into the repository and its submodule, and a repack that dropped a loose object
    const found = [
      file('.git/HEAD'), file('.git/refs/heads/main'), index('.git/index', 'b', 'e'), file('.git/logs/HEAD'),
      file('.git/worktrees/w/HEAD'), index('.git/worktrees/w/index', 'c', 'f'), file('.git/worktrees/w/FETCH_HEAD'),
      file('.git/FETCH_HEAD'), file('.git/refs/remotes/origin/main'), file('.git/logs/refs/remotes/origin/main'),
      file('.git/refs/prefetch/remotes/origin/main'), file('.git/objects/pack/pack-1.pack'),
      ...repo('.git/modules/sub', [file('.git/modules/sub/objects/ab/cd'), file('.git/modules/sub/FETCH_HEAD')]),
    ];
    expect(diverged(compareReplica([baseline], found))).toBe(false);
  });

  it('still reads a moved branch, a changed staged entry, a new stash and a new commit as divergence', () => {
    const d = compareReplica([repo('.git')], [
      file('.git/HEAD'), file('.git/refs/heads/main', 'b'), index('.git/index', 'b', 'f'), file('.git/logs/HEAD', 'b'), file('.git/refs/stash'),
    ]);
    expect(d.changed.preview).toEqual(['.git/index', '.git/logs/HEAD', '.git/refs/heads/main']);
    expect(d.added.preview).toEqual(['.git/refs/stash']);
  });

  it('reads a fetch into a clone as no change, though origin/HEAD puts a HEAD among the remote refs', () => {
    const clone = repo('.git', [file('.git/refs/remotes/origin/HEAD'), file('.git/logs/refs/remotes/origin/HEAD'), file('.git/packed-refs'), file('.git/objects/ab/cd')]);
    const fetched = [...clone, file('.git/FETCH_HEAD'), file('.git/refs/remotes/origin/main'), file('.git/logs/refs/remotes/origin/main'), file('.git/objects/ef/01')];
    expect(diverged(compareReplica([clone], fetched))).toBe(false);
    // a remote branch named like a registration file or the object store is still only a remote ref
    const odd = [...fetched, file('.git/refs/remotes/origin/commondir'), file('.git/refs/remotes/origin/objects/x')];
    expect(diverged(compareReplica([clone], odd))).toBe(false);
    const moved = compareReplica([clone], [...fetched.filter((f) => f.path !== '.git/refs/heads/main'), file('.git/refs/heads/main', 'b')]);
    expect(moved.changed.preview).toEqual(['.git/refs/heads/main']);
  });

  it('reads a status refresh in a bare repository\'s worktree as no change, and a new commit there as one', () => {
    const bare = [file('HEAD'), file('refs/heads/main'), file('worktrees/wt/HEAD'), file('worktrees/wt/commondir'), index('worktrees/wt/index', 'a', 'e'), file('logs/HEAD')];
    const refreshed = [...bare.filter((f) => f.path !== 'worktrees/wt/index'), index('worktrees/wt/index', 'b', 'e'), file('worktrees/wt/FETCH_HEAD')];
    expect(diverged(compareReplica([bare], refreshed, [], 10, true))).toBe(false);
    const committed = [...refreshed.filter((f) => f.path !== 'worktrees/wt/HEAD'), file('worktrees/wt/HEAD', 'b'), file('refs/stash')];
    const d = compareReplica([bare], committed, [], 10, true);
    expect(d.changed.preview).toEqual(['worktrees/wt/HEAD']);
    expect(d.added.preview).toEqual(['refs/stash']);
  });

  it('compares an index by its bytes when either side does not name its staged entries', () => {
    const d = compareReplica([[file('.git/HEAD'), index('.git/index', 'a', undefined)]], [file('.git/HEAD'), index('.git/index', 'b', 'e')]);
    expect(d.changed.preview).toEqual(['.git/index']);
  });

  it('reads Git state only inside a Git directory: from the top of a Git directory carried on its own, never in a working tree', () => {
    const bare = [file('HEAD'), file('refs/heads/main')];
    expect(diverged(compareReplica([bare], [...bare, file('FETCH_HEAD'), file('objects/ab/cd')], [], 10, true))).toBe(false);
    const d = compareReplica([[file('HEAD'), file('src/index')]], [file('HEAD'), file('FETCH_HEAD'), file('objects/ab/cd'), file('src/index', 'b')]);
    expect(d.added.preview).toEqual(['FETCH_HEAD', 'objects/ab/cd']);
    expect(d.changed.preview).toEqual(['src/index']);
  });
});

describe('proveReplica', () => {
  it('leaves out the configured host-local caches but not a gitignored file or anything in .git', async () => {
    const root = tmp();
    write(root, 'src/a.ts', 'export {};\n');
    write(root, '.gitignore', 'secret.env\n');
    write(root, '.git/HEAD', 'ref: refs/heads/main\n');
    write(root, '.git/refs/heads/build/x', '1111\n');
    const excludes = [...DEFAULT_EXCLUDES, '.cache/'];
    const baseline = await content(root, excludes);

    write(root, 'node_modules/pkg/index.js', '');
    write(root, 'dist/out.js', '');
    write(root, '.cache/blob', '');
    write(root, 'secret.env', 'TOKEN=1\n');
    write(root, '.git/refs/heads/build/x', '2222\n');
    const { divergence: d, files } = await proveReplica(root, [baseline], excludes);
    expect(files.map((f) => f.path)).not.toContain('dist/out.js');
    expect(d.added.preview).toEqual(['secret.env']);
    expect(d.changed.preview).toEqual(['.git/refs/heads/build/x']);
    expect(d.removed.count + d.unchecked.count).toBe(0);
  });

  it.skipIf(process.getuid?.() === 0)('reports a name it cannot carry and a folder it cannot read as unchecked', async () => {
    const root = tmp();
    write(root, 'locked/f.txt', 'x');
    const baseline = await content(root, []);
    write(root, 'bad\nname', 'x');
    fs.chmodSync(path.join(root, 'locked'), 0);
    try {
      const { divergence: d } = await proveReplica(root, [baseline], []);
      expect(d.unchecked.count).toBe(2);
      expect(d.unchecked.preview.join('\n')).toMatch(/EACCES/);
      expect(d.unchecked.preview.join('\n')).toContain(JSON.stringify('bad\nname'));
    } finally {
      fs.chmodSync(path.join(root, 'locked'), 0o755);
    }
  });

  it('leaves out of both sides what a later transaction newly excludes', async () => {
    const root = tmp();
    write(root, 'src/a.ts', 'a');
    write(root, 'data/big.bin', 'old');
    const baseline = await content(root, []);
    fs.rmSync(path.join(root, 'data/big.bin'));
    write(root, 'data/other.bin', 'new');
    const { divergence: d } = await proveReplica(root, [baseline], ['data/']);
    expect(diverged(d)).toBe(false);
  });

  it('compares a file root as the file itself, whatever the excludes say', async () => {
    const root = path.join(tmp(), 'notes.md');
    fs.writeFileSync(root, 'mine');
    const baseline = await content(root, []);
    expect(baseline.map((f) => f.path)).toEqual(['']);
    expect(diverged((await proveReplica(root, [baseline], ['*'])).divergence)).toBe(false);
    fs.writeFileSync(root, 'edited');
    expect((await proveReplica(root, [baseline], ['*'])).divergence.changed.count).toBe(1);
  });
});

describe('divergenceBlocker', () => {
  it('names the root, every kind of change with its count and preview, and how to go on', () => {
    const d = compareReplica([[file('gone'), file('edit')]], [file('edit', 'b'), ...['x', 'y', 'z'].map((p) => file(p))], [], 2);
    const b = divergenceBlocker({ id: 'r_app' }, '/srv/app', d);
    expect(b.code).toBe('destination_diverged');
    expect(b.entity).toEqual({ kind: 'root', id: 'r_app' });
    expect(b.message).toContain('/srv/app');
    expect(b.message).toContain('3 added (x, y, …)');
    expect(b.message).toContain('1 removed (gone)');
    expect(b.message).toContain('1 changed (edit)');
    expect(b.message).toMatch(/archive/);
  });
});
