import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { emptyState, type Character } from '@svall/protocol';
import { discoverGit, gitIndexDigest, graphId, parseWorktreeList, readWorktrees } from '../../src/handover/git-graph.js';
import { DEFAULT_EXCLUDES } from '../../src/handover/inventory.js';
import { runGit, type GitResult, type GitRunner } from '../../src/links/git.js';
import { char, crew, git, hasGit, seedHere } from './git-fixture.js';

const made: string[] = [];
afterEach(() => { for (const d of made.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });

const sha = (data: string | Buffer): string => crypto.createHash('sha256').update(data).digest('hex');
const NOT_A_REPO: GitResult = { code: 128, stdout: '', stderr: 'fatal: not a git repository (or any of the parent directories): .git\n' };

// a git that answers from a table keyed by cwd and argv, so each refusal can be made to happen
function fakeGit(answers: Record<string, Partial<GitResult>>): GitRunner {
  return async (args, cwd) => {
    const hit = answers[`${cwd}: ${args.join(' ')}`];
    return hit ? { code: 0, stdout: '', stderr: '', ...hit } : NOT_A_REPO;
  };
}
const DIRS = 'rev-parse --path-format=absolute --show-toplevel --git-common-dir --git-dir';

// what git before 2.36 says to `worktree list -z`
const NO_Z: GitResult = { code: 129, stdout: '', stderr: "error: unknown switch `z'\nusage: git worktree list [<options>]\n" };
const withoutZ = (git: GitRunner): GitRunner => async (args, cwd) => (args[0] === 'worktree' && args.includes('-z') ? NO_Z : git(args, cwd));

function crewOf(characters: Record<string, Partial<Character>>) {
  const state = emptyState();
  state.characters = Object.fromEntries(Object.entries(characters).map(([id, o]) => [id, char(id, o)]));
  return state;
}

// a scratch folder with the fixture's empty global git configuration
function scratch(): string {
  const base = fs.realpathSync(fs.mkdtempSync('/tmp/svall-git-'));
  made.push(base);
  fs.writeFileSync(path.join(base, 'gitconfig'), '');
  return base;
}

describe('parseWorktreeList', () => {
  it('reads every state git lists a worktree in', () => {
    const z = (...entries: string[][]): string => entries.map((e) => `${e.join('\0')}\0\0`).join('');
    const a = 'a'.repeat(40);
    expect(parseWorktreeList(z(
      ['worktree /r/bare.git', 'bare'],
      ['worktree /r/a', `HEAD ${a}`, 'branch refs/heads/a'],
      ['worktree /r/d', `HEAD ${a}`, 'detached'],
      ['worktree /r/l', `HEAD ${a}`, 'branch refs/heads/l', 'locked on a\ndisk'],
      ['worktree /r/k', `HEAD ${a}`, 'detached', 'locked'],
      ['worktree /r/p', `HEAD ${'0'.repeat(40)}`, 'branch refs/heads/new', 'prunable gitdir file points to non-existent location'],
    ))).toEqual([
      { path: '/r/bare.git', head: null, branch: null, bare: true, prunable: false },
      { path: '/r/a', head: a, branch: 'refs/heads/a', bare: false, prunable: false },
      { path: '/r/d', head: a, branch: null, bare: false, prunable: false },
      { path: '/r/l', head: a, branch: 'refs/heads/l', bare: false, locked: 'on a\ndisk', prunable: false },
      { path: '/r/k', head: a, branch: null, bare: false, locked: '', prunable: false },
      { path: '/r/p', head: null, branch: 'refs/heads/new', bare: false, prunable: true },
    ]);
  });
});

describe('readWorktrees, from a git with no -z for worktree list', () => {
  const a = 'a'.repeat(40);
  const lines = (...entries: string[][]): string => entries.map((e) => `${e.join('\n')}\n\n`).join('');

  it('reads the same entries from one attribute a line, with a lock reason git C-quoted', async () => {
    const git = withoutZ(fakeGit({ '/r: worktree list --porcelain': { stdout: lines(
      ['worktree /r', `HEAD ${a}`, 'branch refs/heads/main'],
      ['worktree /r/bare.git', 'bare'],
      ['worktree /r/d', `HEAD ${a}`, 'detached', 'locked'],
      ['worktree /r/l', `HEAD ${a}`, 'branch refs/heads/l', String.raw`locked "p\303\245 \"the\" desk\n\\ again"`],
      ['worktree /r/p', `HEAD ${'0'.repeat(40)}`, 'branch refs/heads/new', 'prunable gitdir file points to non-existent location'],
    ) } }));
    expect(await readWorktrees('/r', git)).toEqual([
      { path: '/r', head: a, branch: 'refs/heads/main', bare: false, prunable: false },
      { path: '/r/bare.git', head: null, branch: null, bare: true, prunable: false },
      { path: '/r/d', head: a, branch: null, bare: false, locked: '', prunable: false },
      { path: '/r/l', head: a, branch: 'refs/heads/l', bare: false, locked: 'på "the" desk\n\\ again', prunable: false },
      { path: '/r/p', head: null, branch: 'refs/heads/new', bare: false, prunable: true },
    ]);
  });

  it('fails on a worktree path with a line break in it, which that form cannot print whole, whatever follows the break', async () => {
    // each is `/r/x`, a line break and more of the path, then the entry git writes for it
    const broken: string[][][] = [
      [['worktree /r/x', 'lines', `HEAD ${a}`, 'detached']],
      [['worktree /r/x', 'locked', `HEAD ${a}`, 'detached']],
      [['worktree /r/x', 'bare', `HEAD ${a}`, 'branch refs/heads/x']],
      [['worktree /r/x', `HEAD ${a}`, `HEAD ${a}`, 'detached']],
      [['worktree /r/x', 'prunable gitdir file points to non-existent location', `HEAD ${a}`, 'detached']],
      [['worktree /r/x'], [`HEAD ${a}`, 'detached']],
    ];
    for (const entries of broken) {
      const git = withoutZ(fakeGit({ '/r: worktree list --porcelain': { stdout: lines(['worktree /r', `HEAD ${a}`, 'branch refs/heads/main'], ...entries) } }));
      await expect(readWorktrees('/r', git, '/r/.git'), JSON.stringify(entries)).rejects.toThrow(
        '/r/.git: git lists a worktree path with a line break in it, which git prints whole only with -z, in git 2.36 or later',
      );
    }
  });
});

describe('discoverGit, when git or the disk refuses', () => {
  const here = (p: string): boolean => p !== '/gone';

  it('leaves a folder outside any repository to be carried as a plain folder', async () => {
    const d = await discoverGit(crewOf({ a: { cwd: '/scratch' } }), { excludes: DEFAULT_EXCLUDES, git: fakeGit({}), exists: here });
    expect(d).toEqual({ graphs: [], blockers: [], warnings: [] });
  });

  it('blocks a character recorded in a checkout whose folder is gone, and passes over a plain folder that is gone', async () => {
    const state = crewOf({
      a: { cwd: '/gone', repo: { root: '/gone', mainRoot: '/r', branch: 'w', isWorktree: true } },
      b: { cwd: '/gone' },
    });
    const d = await discoverGit(state, { excludes: DEFAULT_EXCLUDES, git: fakeGit({}), exists: here });
    expect(d.blockers).toEqual([{ code: 'worktree_unresolved', message: 'a was working in the Git checkout /gone, and /gone no longer exists', entity: { kind: 'character', id: 'a' } }]);
    expect(d.graphs).toEqual([]);
  });

  it('blocks a checkout git will not read, with what git said', async () => {
    const git = fakeGit({ [`/r: ${DIRS}`]: { code: 128, stderr: "fatal: detected dubious ownership in repository at '/r'\n" } });
    const d = await discoverGit(crewOf({ a: { cwd: '/r' } }), { excludes: DEFAULT_EXCLUDES, git, exists: here });
    expect(d.blockers).toEqual([{ code: 'worktree_unresolved', message: "/r: fatal: detected dubious ownership in repository at '/r'", entity: { kind: 'character', id: 'a' } }]);
  });

  it('blocks a graph whose worktrees git will not list, and keeps no half-read graph', async () => {
    const git = fakeGit({
      [`/r: ${DIRS}`]: { stdout: '/r\n/r/.git\n/r/.git\n' },
      '/r: worktree list --porcelain -z': { code: 128, stderr: "fatal: unable to read '/r/.git/worktrees/x/gitdir': Permission denied\n" },
    });
    const d = await discoverGit(crewOf({ a: { cwd: '/r' } }), { excludes: DEFAULT_EXCLUDES, git, exists: here });
    expect(d.graphs).toEqual([]);
    expect(d.blockers).toEqual([{ code: 'worktree_unresolved', message: "/r/.git: git worktree list --porcelain -z failed: fatal: unable to read '/r/.git/worktrees/x/gitdir': Permission denied", entity: { kind: 'git', id: graphId('/r/.git') } }]);
  });
});

const real = hasGit ? describe : describe.skip;

// each seeds a real fixture with dozens of git commands, which a loaded machine takes its time over
real(`discoverGit on a real repository${hasGit ? '' : ' (skipped: git is not on PATH)'}`, { timeout: 120_000 }, () => {
  it('records the main checkout no character stands in, every used worktree with its crew, and the unused ones', async () => {
    const l = seedHere(made);
    const s = l.source;
    const d = await discoverGit(crew(l), { excludes: DEFAULT_EXCLUDES });
    expect(d.blockers).toEqual([]);
    expect(d.graphs.map((g) => [g.id, g.commonDir])).toEqual([
      [graphId(path.join(s.main, '.git')), path.join(s.main, '.git')],
      [graphId(path.join(s.main, '.git/modules/sub')), path.join(s.main, '.git/modules/sub')],
    ]);
    const [demo, sub] = d.graphs;
    expect(demo.main).toMatchObject({ path: s.main, gitDir: path.join(s.main, '.git'), head: git(l.base, s.main, 'rev-parse', 'HEAD'), branch: 'refs/heads/main', characters: [] });
    expect(demo.main!.locked).toBeUndefined();
    const registration = (name: string): string => path.join(s.main, '.git/worktrees', name);
    expect(demo.worktrees.map((w) => [w.path, w.gitDir, w.branch, w.locked, w.characters])).toEqual([
      [s.nested, registration('nested'), 'refs/heads/nested-branch', undefined, ['nested']],
      [s.detached, registration('detached'), null, undefined, ['det']],
      [s.locked, registration('locked'), 'refs/heads/locked-branch', 'on the desk', ['lock']],
      [s.sibling, registration('sibling'), 'refs/heads/sibling-branch', undefined, ['sib']],
    ]);
    // a detached HEAD is recorded as the commit it names, with no branch
    expect(demo.worktrees[1].head).toBe(git(l.base, s.detached, 'rev-parse', 'HEAD'));
    const first = git(l.base, s.unused, 'rev-parse', 'HEAD');
    expect(demo.unused).toEqual([
      { path: s.gone, head: first, branch: 'refs/heads/gone-branch', prunable: true },
      { path: s.unused, head: first, branch: 'refs/heads/unused-branch', prunable: false },
    ]);
    expect(demo.stash).toEqual([git(l.base, s.main, 'rev-parse', 'refs/stash')]);
    // a submodule a character works in is a graph of its own, its git dir and common dir one folder
    expect(sub.main).toMatchObject({ path: s.sub, gitDir: sub.commonDir, branch: 'refs/heads/main', characters: ['sub'] });
    expect(sub).toMatchObject({ worktrees: [], unused: [], stash: [] });
  });

  it('reads the same graph from a git with no -z for worktree list, a quoted lock reason included', async () => {
    const l = seedHere(made);
    const s = l.source;
    const reason = 'på "the" desk\n\\ again';
    git(l.base, s.main, 'worktree', 'unlock', s.locked);
    git(l.base, s.main, 'worktree', 'lock', '--reason', reason, s.locked);
    const d = await discoverGit(crew(l), { excludes: DEFAULT_EXCLUDES });
    expect(d.graphs[0].worktrees.find((w) => w.path === s.locked)?.locked).toBe(reason);
    expect(await discoverGit(crew(l), { excludes: DEFAULT_EXCLUDES, git: withoutZ(runGit) })).toEqual(d);
  });

  it('reads what each checkout stages and changes, and leaves untracked files to the file manifest', async () => {
    const l = seedHere(made);
    const [demo] = (await discoverGit(crew(l), { excludes: DEFAULT_EXCLUDES })).graphs;
    expect(demo.main!.index).toBe(sha(git(l.base, l.source.main, 'ls-files', '--stage', '-z')));
    expect(demo.main!.status).toEqual([
      expect.stringMatching(/^1 \.M N\.\.\. .* a\.txt$/),
      expect.stringMatching(/^1 A\. N\.\.\. .* staged\.txt$/),
      expect.stringMatching(/^1 \.M S\.M\. .* sub$/),
    ]);
    for (const w of demo.worktrees) {
      expect(w.index).toBe(sha(git(l.base, w.path, 'ls-files', '--stage', '-z')));
      expect(w.status).toEqual([expect.stringMatching(/ a\.txt$/), expect.stringMatching(/ staged\.txt$/)]);
    }
  });

  it('warns that unused worktrees are not registered on the destination, and that a submodule fetches from this machine', async () => {
    const l = seedHere(made);
    const s = l.source;
    const d = await discoverGit(crew(l), { excludes: DEFAULT_EXCLUDES });
    const demo = d.graphs[0];
    expect(d.warnings).toEqual([
      { code: 'remote_local', message: `${s.sub}: origin ${s.lib} names a place on this machine, and the destination keeps it as it is`, entity: { kind: 'git', id: d.graphs[1].id } },
      { code: 'worktree_unused', message: expect.stringContaining(`${path.join(s.main, '.git')}: worktrees no character uses are not registered on the destination`), entity: { kind: 'git', id: demo.id } },
    ]);
    const unused = d.warnings[1].message;
    expect(unused).toContain(`${s.gone} (on gone-branch, missing)`);
    expect(unused).toContain(`${s.unused} (on unused-branch)`);
  });

  it('blocks an unused worktree that alone holds work, and only warns of one that holds none', async () => {
    const l = seedHere(made);
    const s = l.source;
    const g = (cwd: string, ...args: string[]): string => git(l.base, cwd, ...args);
    const add = (name: string, ...how: string[]): string => {
      const at = path.join(s.work, name);
      g(s.main, 'worktree', 'add', '-q', ...(how[0] === '--detach' ? ['--detach', at, ...how.slice(1)] : [...how, at]));
      return at;
    };
    // staged in a clean branch checkout
    fs.writeFileSync(path.join(s.unused, 'wip.txt'), 'wip');
    g(s.unused, 'add', 'wip.txt');
    // a commit made on a detached HEAD, its folder there and gone
    const stray = add('stray', '--detach', 'HEAD');
    g(stray, 'commit', '-q', '--allow-empty', '-m', 'only here');
    const lost = add('lost', '--detach', 'HEAD');
    g(lost, 'commit', '-q', '--allow-empty', '-m', 'only here too');
    const lostHead = g(lost, 'rev-parse', 'HEAD');
    fs.rmSync(lost, { recursive: true });
    // a locked worktree whose folder is away
    const away = add('away', '-b', 'away-branch');
    g(s.main, 'worktree', 'lock', '--reason', 'on the usb disk', away);
    fs.rmSync(away, { recursive: true });
    // detached at a commit main reaches, and clean
    const safe = add('safe', '--detach', 'HEAD');

    const d = await discoverGit(crew(l), { excludes: DEFAULT_EXCLUDES });
    const demo = graphId(path.join(s.main, '.git'));
    const blocked = (at: string, message: string) => ({ code: 'worktree_unused', message: `${at}: ${message}`, entity: { kind: 'git', id: demo } });
    expect(d.blockers).toEqual([
      blocked(away, 'a locked worktree no character uses is not there, so what it holds cannot be read; mount it, or unlock or remove the worktree'),
      blocked(lost, `a worktree no character uses is detached at ${lostHead.slice(0, 12)}, which no branch or tag reaches; name it with git branch <name> ${lostHead.slice(0, 12)}, or remove the worktree`),
      blocked(stray, `a worktree no character uses is detached at ${g(stray, 'rev-parse', 'HEAD').slice(0, 12)}, which no branch or tag reaches; name it with git branch <name> ${g(stray, 'rev-parse', 'HEAD').slice(0, 12)}, or remove the worktree`),
      blocked(s.unused, 'a worktree no character uses holds changes git status reports, which a handover back would leave without their registration; commit or stash them there, or remove the worktree'),
    ]);
    // the manifest still records every unused registration as it is; only those holding no work are warned of
    expect(d.graphs[0].unused.map((u) => u.path)).toEqual([away, s.gone, lost, safe, stray, s.unused]);
    const warned = d.warnings.find((w) => w.code === 'worktree_unused')!.message;
    expect(warned).toContain(`${s.gone} (on gone-branch, missing)`);
    expect(warned).toContain(`${safe} (detached at `);
    for (const at of [away, lost, stray, s.unused]) expect(warned).not.toContain(`${at} (`);
  });

  it('reads an unused worktree the same whatever the repository says status should show', async () => {
    const l = seedHere(made);
    const s = l.source;
    // the fixture holds a stash, which every worktree's status would announce
    git(l.base, s.main, 'config', 'status.showStash', 'true');
    git(l.base, s.main, 'config', 'status.showUntrackedFiles', 'no');
    expect((await discoverGit(crew(l), { excludes: DEFAULT_EXCLUDES })).blockers).toEqual([]);
    fs.writeFileSync(path.join(s.unused, 'notes.txt'), 'kept nowhere else');
    expect((await discoverGit(crew(l), { excludes: DEFAULT_EXCLUDES })).blockers).toEqual([
      expect.objectContaining({ code: 'worktree_unused', message: expect.stringContaining(`${s.unused}: a worktree no character uses holds changes`) }),
    ]);
  });

  it('lists a character once when both its terminals stand in one checkout', async () => {
    const l = seedHere(made);
    const d = await discoverGit(crew(l), { excludes: DEFAULT_EXCLUDES });
    expect(d.graphs[0].worktrees.find((w) => w.path === l.source.sibling)!.characters).toEqual(['sib']);
  });

  it('blocks tracked files the excludes would leave behind', async () => {
    const base = scratch();
    const repo = path.join(base, 'app');
    fs.mkdirSync(path.join(repo, 'dist'), { recursive: true });
    fs.writeFileSync(path.join(repo, 'dist/app.js'), 'built');
    git(base, base, 'init', '-q', repo);
    git(base, repo, 'add', 'dist/app.js');
    git(base, repo, 'commit', '-qm', 'ship dist');
    const d = await discoverGit(crewOf({ a: { cwd: repo } }), { excludes: DEFAULT_EXCLUDES });
    expect(d.blockers).toEqual([{
      code: 'path_unsupported',
      message: `${repo}: 1 tracked file lies under an excluded path and would arrive deleted: dist/app.js`,
      entity: { kind: 'git', id: graphId(path.join(repo, '.git')) },
    }]);
    expect((await discoverGit(crewOf({ a: { cwd: repo } }), { excludes: [] })).blockers).toEqual([]);
  });

  it('describes a bare repository by its common directory, with no main checkout', async () => {
    const base = scratch();
    const repo = path.join(base, 'app');
    git(base, base, 'init', '-q', repo);
    git(base, repo, 'commit', '-q', '--allow-empty', '-m', 'init');
    const bare = path.join(base, 'app.git');
    git(base, base, 'clone', '-q', '--bare', repo, bare);
    const wt = path.join(base, 'wt');
    git(base, bare, 'worktree', 'add', '-q', wt, '-b', 'feature');
    const d = await discoverGit(crewOf({ a: { cwd: wt } }), { excludes: DEFAULT_EXCLUDES });
    expect(d.blockers).toEqual([]);
    expect(d.graphs).toEqual([{
      id: graphId(bare), commonDir: bare, worktrees: [expect.objectContaining({ path: wt, gitDir: path.join(bare, 'worktrees/wt'), branch: 'refs/heads/feature', characters: ['a'] })],
      unused: [], stash: [], tips: [git(base, bare, 'rev-parse', 'refs/heads/main')],
    }]);
  });
});

real('gitIndexDigest', { timeout: 60_000 }, () => {
  const index = (repo: string): Buffer => fs.readFileSync(path.join(repo, '.git/index'));

  function repo(...init: string[]): { base: string; repo: string } {
    const base = scratch();
    const at = path.join(base, 'r');
    git(base, base, 'init', '-q', ...init, at);
    for (const f of ['a.txt', 'b/c.txt']) {
      fs.mkdirSync(path.dirname(path.join(at, f)), { recursive: true });
      fs.writeFileSync(path.join(at, f), f);
    }
    git(base, at, 'add', '.');
    git(base, at, 'commit', '-qm', 'init');
    return { base, repo: at };
  }

  it('names an index by what it stages, whatever stat data or index version it holds', () => {
    const { base, repo: r } = repo();
    const before = index(r);
    const digest = gitIndexDigest(before);
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
    // what a status refresh writes: new stat data for the same entries
    const later = new Date(Date.now() + 60_000);
    fs.utimesSync(path.join(r, 'a.txt'), later, later);
    git(base, r, 'update-index', '--really-refresh');
    expect(index(r).equals(before)).toBe(false);
    expect(gitIndexDigest(index(r))).toBe(digest);
    git(base, r, 'update-index', '--index-version', '4');
    expect(gitIndexDigest(index(r))).toBe(digest);
  });

  it('tells apart a staged change, an intent to add and a skipped worktree entry', () => {
    const { base, repo: r } = repo();
    const digest = gitIndexDigest(index(r));
    fs.writeFileSync(path.join(r, 'a.txt'), 'changed');
    git(base, r, 'add', 'a.txt');
    const staged = gitIndexDigest(index(r));
    expect(staged).not.toBe(digest);
    fs.writeFileSync(path.join(r, 'new.txt'), 'new');
    git(base, r, 'add', '-N', 'new.txt');
    const intent = gitIndexDigest(index(r));
    expect(intent).not.toBe(staged);
    git(base, r, 'update-index', '--skip-worktree', 'b/c.txt');
    expect(gitIndexDigest(index(r))).not.toBe(intent);
    git(base, r, 'update-index', '--index-version', '4');
    expect(gitIndexDigest(index(r))).not.toBe(intent);
  });

  it('reads a SHA-256 repository index, and nothing that is not a whole index', () => {
    const { repo: r } = repo('--object-format=sha256');
    expect(gitIndexDigest(index(r))).toMatch(/^[0-9a-f]{64}$/);
    expect(gitIndexDigest(Buffer.from('DIRC'))).toBeUndefined();
    expect(gitIndexDigest(index(r).subarray(0, 40))).toBeUndefined();
    expect(gitIndexDigest(Buffer.from('a'.repeat(41)))).toBeUndefined();
  });

  it('reads an index git wrote without its trailing hash, as feature.manyFiles has it', () => {
    const { base, repo: r } = repo();
    const digest = gitIndexDigest(index(r));
    const later = new Date(Date.now() + 60_000);
    fs.utimesSync(path.join(r, 'a.txt'), later, later);
    git(base, r, '-c', 'index.skipHash=true', 'update-index', '--really-refresh');
    expect(index(r).subarray(-20).equals(Buffer.alloc(20))).toBe(true);
    expect(gitIndexDigest(index(r))).toBe(digest);
  });

  it('declines a split index, whose entries live in a shared file beside it', () => {
    const { base, repo: r } = repo();
    git(base, r, 'update-index', '--split-index');
    expect(gitIndexDigest(index(r))).toBeUndefined();
  });
});
