import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { discoverGraph, listWorktrees, reconstruct, snapshotCheckout }
  from '../../../../scripts/spikes/probe-worktree-handover.mjs';

const hasGit = (() => {
  try { execFileSync('git', ['--version'], { stdio: 'ignore' }); return true; } catch { return false; }
})();

function git(cwd: string, ...args: string[]) {
  return execFileSync('git', ['-c', 'user.name=Probe', '-c', 'user.email=probe@example.com',
    '-c', 'commit.gpgsign=false', '-c', 'init.defaultBranch=main', '-c', 'protocol.file.allow=always',
    ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).replace(/\n$/, '');
}

const read = (file: string) => fs.readFileSync(file, 'utf8');

let tempDir: string | undefined;
afterEach(() => {
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  tempDir = undefined;
  delete process.env.GIT_CONFIG_GLOBAL;
  delete process.env.GIT_CONFIG_NOSYSTEM;
});

// A source machine holding one main checkout, a worktree nested inside it, a sibling worktree, a
// registered worktree nobody uses, a stash, dirty state everywhere and a submodule.
function seed() {
  tempDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'svall-worktree-portability-')));
  process.env.GIT_CONFIG_GLOBAL = path.join(tempDir, 'gitconfig');
  process.env.GIT_CONFIG_NOSYSTEM = '1';
  fs.writeFileSync(process.env.GIT_CONFIG_GLOBAL, '');

  const source = path.join(tempDir, 'Users', 'source', 'work');
  const destination = path.join(tempDir, 'home', 'dest', 'work');
  fs.mkdirSync(source, { recursive: true });
  fs.mkdirSync(destination, { recursive: true });

  const lib = path.join(source, 'lib');
  git(source, 'init', '-q', 'lib');
  fs.writeFileSync(path.join(lib, 'lib.txt'), 'lib\n');
  git(lib, 'add', 'lib.txt');
  git(lib, 'commit', '-qm', 'lib');

  const main = path.join(source, 'demo');
  const nested = path.join(main, '.claude', 'worktrees', 'nested');
  const sibling = path.join(source, 'sibling');
  const unused = path.join(source, 'unused');
  git(source, 'init', '-q', 'demo');
  fs.writeFileSync(path.join(main, 'a.txt'), 'hello\n');
  git(main, 'add', 'a.txt');
  git(main, 'commit', '-qm', 'first');
  for (const branch of ['nested-branch', 'sibling-branch', 'unused-branch']) git(main, 'branch', branch);
  git(main, 'worktree', 'add', '-q', nested, 'nested-branch');
  git(main, 'worktree', 'add', '-q', sibling, 'sibling-branch');
  git(main, 'worktree', 'add', '-q', unused, 'unused-branch');
  git(main, 'submodule', 'add', '-q', lib, 'sub');
  git(main, 'commit', '-qm', 'add submodule');

  // the stash first, so the dirty state below is what each checkout still carries
  fs.writeFileSync(path.join(main, 'stashed.txt'), 'stash me\n');
  git(main, 'add', 'stashed.txt');
  git(main, 'stash', 'push', '-q', '-u', '-m', 'probe-stash');
  for (const checkout of [main, nested, sibling]) {
    fs.writeFileSync(path.join(checkout, 'staged.txt'), `staged in ${path.basename(checkout)}\n`);
    git(checkout, 'add', 'staged.txt');
    fs.appendFileSync(path.join(checkout, 'a.txt'), 'edited\n');
    fs.writeFileSync(path.join(checkout, 'untracked.txt'), 'junk\n');
  }

  return {
    root: tempDir,
    source: { main, nested, sibling, unused },
    destination: {
      main: path.join(destination, 'demo'),
      nested: path.join(destination, 'demo', '.claude', 'worktrees', 'nested'),
      sibling: path.join(destination, 'sibling'),
    },
  };
}

type Fixture = ReturnType<typeof seed>;

// the main checkout carries the common git dir and the nested worktree; the unused one stays behind
function transfer(fixture: Fixture) {
  fs.cpSync(fixture.source.main, fixture.destination.main, { recursive: true });
  fs.cpSync(fixture.source.sibling, fixture.destination.sibling, { recursive: true });
}

const unplug = (fixture: Fixture) =>
  fs.rmSync(path.join(fixture.root, 'Users'), { recursive: true, force: true });

const manifest = (fixture: Fixture) => [fixture.destination.nested, fixture.destination.sibling];

// the registration id of each fixture worktree is its directory name
function expectLinkedTo(mainRoot: string, worktree: string) {
  const registration = path.join(mainRoot, '.git', 'worktrees', path.basename(worktree));
  expect(read(path.join(worktree, '.git'))).toBe(`gitdir: ${registration}\n`);
  expect(read(path.join(registration, 'gitdir'))).toBe(`${path.join(worktree, '.git')}\n`);
}

const suite = hasGit ? describe : describe.skip;

// each case runs a few dozen git commands one after another, which a loaded machine can stretch past the default
suite(`Linked worktree handover${hasGit ? '' : ' (skipped: git is not on PATH)'}`, { timeout: 30_000 }, () => {
  it('rebuilds every used checkout under a new home prefix with its HEAD, index, status and stash', () => {
    const fixture = seed();
    const before = {
      main: snapshotCheckout(fixture.source.main),
      nested: snapshotCheckout(fixture.source.nested),
      sibling: snapshotCheckout(fixture.source.sibling),
    };
    expect(before.main.stash).toContain('probe-stash');
    expect(before.main.staged).toBe('A\tstaged.txt');
    transfer(fixture);
    unplug(fixture);

    const report = reconstruct({ mainRoot: fixture.destination.main, worktrees: manifest(fixture) });
    // the rewrite left git nothing to fix, so repair says nothing
    expect(report.repairReport).toBe('');
    expect(snapshotCheckout(fixture.destination.main)).toEqual(before.main);
    expect(snapshotCheckout(fixture.destination.nested)).toEqual(before.nested);
    expect(snapshotCheckout(fixture.destination.sibling)).toEqual(before.sibling);

    expect(listWorktrees(fixture.destination.main)).toEqual([
      { path: fixture.destination.main, head: before.main.head, branch: 'refs/heads/main', prunable: false },
      { path: fixture.destination.nested, head: before.nested.head, branch: 'refs/heads/nested-branch', prunable: false },
      { path: fixture.destination.sibling, head: before.sibling.head, branch: 'refs/heads/sibling-branch', prunable: false },
    ]);

    for (const worktree of manifest(fixture)) {
      expectLinkedTo(fixture.destination.main, worktree);
      expect(discoverGraph(worktree)).toMatchObject({
        root: worktree, commonDir: path.join(fixture.destination.main, '.git'), isWorktree: true,
      });
    }
  });

  it('fixes both sides of the link from the mapped paths alone, without the rewrite', () => {
    const fixture = seed();
    transfer(fixture);
    unplug(fixture);

    git(fixture.destination.main, 'worktree', 'repair', ...manifest(fixture));
    for (const worktree of manifest(fixture)) expectLinkedTo(fixture.destination.main, worktree);
    expect(listWorktrees(fixture.destination.main).filter((entry) => !entry.prunable).map((entry) => entry.path))
      .toEqual([fixture.destination.main, ...manifest(fixture)]);
  });

  it('drops a registration the manifest leaves out and keeps its branch', () => {
    const fixture = seed();
    const unusedBranch = git(fixture.source.main, 'rev-parse', 'refs/heads/unused-branch');
    transfer(fixture);
    unplug(fixture);

    const report = reconstruct({ mainRoot: fixture.destination.main, worktrees: manifest(fixture) });
    expect(report.pruned).toEqual(['unused']);
    expect(fs.readdirSync(path.join(fixture.destination.main, '.git', 'worktrees')).sort())
      .toEqual(['nested', 'sibling']);
    expect(git(fixture.destination.main, 'rev-parse', 'refs/heads/unused-branch')).toBe(unusedBranch);
    expect(listWorktrees(fixture.destination.main).map((entry) => entry.path))
      .not.toContain(fixture.source.unused);
  });

  it('needs the mapped paths: neither a bare repair nor a prune reconstructs the copy', () => {
    const fixture = seed();
    transfer(fixture);
    unplug(fixture);

    // with no paths, repair has only the source locations recorded in the copy and cannot guess
    git(fixture.destination.main, 'worktree', 'repair');
    expect(listWorktrees(fixture.destination.main).filter((entry) => entry.prunable).map((entry) => entry.path).sort())
      .toEqual([fixture.source.nested, fixture.source.sibling, fixture.source.unused].sort());

    // and a prune, which would normally clear stale registrations, takes the transferred ones too
    const rehearsal = path.join(fixture.root, 'prune-rehearsal');
    fs.cpSync(fixture.destination.main, rehearsal, { recursive: true });
    git(rehearsal, 'worktree', 'prune');
    expect(fs.existsSync(path.join(rehearsal, '.git', 'worktrees'))).toBe(false);

    reconstruct({ mainRoot: fixture.destination.main, worktrees: manifest(fixture) });
    expect(listWorktrees(fixture.destination.main).map((entry) => entry.path))
      .toEqual([fixture.destination.main, ...manifest(fixture)]);
  });

  it('follows a left-over registration back to the source machine and rewrites it', () => {
    const fixture = seed();
    const gitfile = path.join(fixture.source.unused, '.git');
    const before = read(gitfile);
    transfer(fixture);

    git(fixture.destination.main, 'worktree', 'repair', ...manifest(fixture));
    expect(read(gitfile)).not.toBe(before);
    expect(read(gitfile)).toBe(`gitdir: ${path.join(fixture.destination.main, '.git', 'worktrees', 'unused')}\n`);
  });

  it('touches nothing on a still-reachable source when the registrations are pruned first', () => {
    const fixture = seed();
    const before = {
      unused: read(path.join(fixture.source.unused, '.git')),
      nested: read(path.join(fixture.source.nested, '.git')),
      gitdir: read(path.join(fixture.source.main, '.git', 'worktrees', 'nested', 'gitdir')),
      main: snapshotCheckout(fixture.source.main),
      worktrees: listWorktrees(fixture.source.main),
    };
    transfer(fixture);

    reconstruct({ mainRoot: fixture.destination.main, worktrees: manifest(fixture) });
    expect(read(path.join(fixture.source.unused, '.git'))).toBe(before.unused);
    expect(read(path.join(fixture.source.nested, '.git'))).toBe(before.nested);
    expect(read(path.join(fixture.source.main, '.git', 'worktrees', 'nested', 'gitdir'))).toBe(before.gitdir);
    expect(snapshotCheckout(fixture.source.main)).toEqual(before.main);
    expect(listWorktrees(fixture.source.main)).toEqual(before.worktrees);
  });

  it('inventories a submodule as its own graph and moves it without a rewrite', () => {
    const fixture = seed();
    const sub = path.join(fixture.source.main, 'sub');
    const gitlink = git(fixture.source.main, 'ls-files', '-s', 'sub');
    const head = git(sub, 'rev-parse', 'HEAD');
    // a character working in here is its own repository graph: git dir and common dir are the same
    // path under the superproject's .git/modules, and the toplevel is the submodule itself
    expect(discoverGraph(sub)).toEqual({
      root: sub,
      commonDir: path.join(fixture.source.main, '.git', 'modules', 'sub'),
      gitDir: path.join(fixture.source.main, '.git', 'modules', 'sub'),
      isWorktree: false,
    });

    transfer(fixture);
    unplug(fixture);
    reconstruct({ mainRoot: fixture.destination.main, worktrees: manifest(fixture) });

    // both of a submodule's back-references are relative, so the move leaves them alone
    const moved = path.join(fixture.destination.main, 'sub');
    expect(read(path.join(moved, '.git')).trim()).toBe('gitdir: ../.git/modules/sub');
    expect(read(path.join(fixture.destination.main, '.git', 'modules', 'sub', 'config')))
      .toContain('worktree = ../../../sub');
    expect(discoverGraph(moved)).toEqual({
      root: moved,
      commonDir: path.join(fixture.destination.main, '.git', 'modules', 'sub'),
      gitDir: path.join(fixture.destination.main, '.git', 'modules', 'sub'),
      isWorktree: false,
    });
    expect(git(moved, 'rev-parse', 'HEAD')).toBe(head);
    expect(git(fixture.destination.main, 'ls-files', '-s', 'sub')).toBe(gitlink);
  });
});
