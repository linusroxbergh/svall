import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { GitGraph } from '@svall/protocol';
import { discoverGit } from '../../src/handover/git-graph.js';
import { relocationBlockers, staleBlockers } from '../../src/handover/git-relocate.js';
import { DEFAULT_EXCLUDES } from '../../src/handover/inventory.js';
import { runGit } from '../../src/links/git.js';
import { crew, git, hasGit, seedHere, type Layout } from './git-fixture.js';

const made: string[] = [];
afterEach(() => { for (const d of made.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });

const LINUX = '/home/source';

async function graphOf(l: Layout): Promise<GitGraph> {
  const { graphs, blockers } = await discoverGit(crew(l), { excludes: DEFAULT_EXCLUDES });
  expect(blockers).toEqual([]);
  return graphs.find((g) => g.commonDir === path.join(l.source.main, '.git'))!;
}

describe('staleBlockers', () => {
  const sent = {
    home: '/Users/ada', destinationHome: '/home/ada',
    git: [{ id: 'g1', commonDir: '/Users/ada/app/.git', worktrees: [{ path: '/Users/ada/wt' }, { path: '/srv/wt' }] }] as GitGraph[],
  };

  it('refuses each place a graph moves from that the destination holds too, naming where its copy lands', () => {
    expect(staleBlockers(sent, 'trift', (p) => p === '/Users/ada/wt')).toEqual([{
      code: 'path_unsupported', entity: { kind: 'git', id: 'g1' },
      message: '/Users/ada/wt is on trift as well, and git worktree repair would tie the copy that lands at /home/ada/wt to it; move /Users/ada/wt aside on trift first',
    }]);
  });

  it('asks nothing of a place that keeps its path, or of any between accounts with the same home', () => {
    expect(staleBlockers(sent, 'trift', (p) => p === '/srv/wt')).toEqual([]);
    expect(staleBlockers({ ...sent, destinationHome: '/Users/ada' }, 'trift', () => true)).toEqual([]);
  });
});

const real = hasGit ? describe : describe.skip;

real(`relocationBlockers${hasGit ? '' : ' (skipped: git is not on PATH)'}`, { timeout: 180_000 }, () => {
  it('takes a graph whose checkouts and submodules all move into the other home, and anything between accounts with the same home', async () => {
    const l = seedHere(made);
    const g = await graphOf(l);
    expect(await relocationBlockers([g], { from: l.home, to: LINUX }, runGit)).toEqual([]);
    expect(await relocationBlockers([g], { from: l.home, to: l.home }, runGit)).toEqual([]);
  });

  it('refuses a moving graph with linked worktrees when the destination\'s git cannot repair them', async () => {
    const l = seedHere(made);
    const g = await graphOf(l);
    expect(await relocationBlockers([g], { from: l.home, to: LINUX }, runGit, '2.31.0')).toEqual([]);
    expect(await relocationBlockers([g], { from: l.home, to: LINUX }, runGit, '2.30.2')).toEqual([{
      code: 'git_extension', entity: { kind: 'git', id: g.id },
      message: `${g.commonDir}: its linked worktrees land at other paths, which git worktree repair mends from git 2.31.0 on, and the destination runs git 2.30.2`,
    }]);
  });

  it('refuses a graph with submodules whose checkouts would not all move, which breaks the paths they find each other by, and takes one without', async () => {
    const l = seedHere(made);
    const g = await graphOf(l);
    // the main checkout moves, and its worktrees beside it keep their paths
    const [b] = await relocationBlockers([g], { from: l.source.main, to: path.join(LINUX, 'demo') }, runGit);
    expect(b).toMatchObject({ code: 'path_unsupported', entity: { kind: 'git', id: g.id } });
    expect(b.message).toContain('its submodules find their Git directories by paths relative to each checkout');
    expect(b.message).toContain(`${l.source.sibling}`);
    // repair mends every linked worktree wherever it lands
    fs.rmSync(path.join(l.source.main, '.gitmodules'));
    expect(await relocationBlockers([g], { from: l.source.main, to: path.join(LINUX, 'demo') }, runGit)).toEqual([]);
  });

  it('refuses a hooks folder, a worktree, an include condition and objects borrowed from outside or by a full path, named by a path the move leaves behind, and takes relative ones', async () => {
    const l = seedHere(made);
    const g = await graphOf(l);
    const m = l.source.main;
    const sub = path.join(m, '.git/modules/sub');
    git(l.base, m, 'config', 'core.hooksPath', path.join(l.home, 'hooks'));
    git(l.base, m, 'config', `includeIf.gitdir:${l.source.work}/.path`, path.join(l.home, 'extra.gitconfig'));
    git(l.base, m, 'config', '--file', path.join(sub, 'config'), 'core.worktree', l.source.sub);
    fs.writeFileSync(path.join(m, '.git/objects/info/alternates'), `${path.join(l.source.lib, '.git/objects')}\n`);
    fs.mkdirSync(path.join(sub, 'objects/info'), { recursive: true });
    fs.writeFileSync(path.join(sub, 'objects/info/alternates'), `${path.join(m, '.git/objects')}\n`);
    const messages = (await relocationBlockers([g], { from: l.home, to: LINUX }, runGit)).map((b) => b.message);
    expect(messages).toEqual([
      expect.stringContaining(`core.hookspath names ${path.join(l.home, 'hooks')}, a path in ${l.home}`),
      expect.stringContaining(`its config includes ${path.join(l.home, 'extra.gitconfig')} when the Git directory lies in ${l.source.work}/`),
      expect.stringContaining(`${sub}: core.worktree names ${l.source.sub}, a path in ${l.home}`),
      `${path.join(m, '.git')} borrows objects from ${path.join(l.source.lib, '.git/objects')}, outside the repository, which the handover does not carry to ${LINUX}; run git repack -a -d there, then delete objects/info/alternates`,
      expect.stringContaining(`${sub} borrows objects from ${path.join(m, '.git/objects')} by its full path`),
    ]);
    git(l.base, m, 'config', 'core.hooksPath', '.githooks');
    git(l.base, m, 'config', '--unset', `includeIf.gitdir:${l.source.work}/.path`);
    git(l.base, m, 'config', 'includeIf.gitdir:~/work/.path', '~/extra.gitconfig');
    git(l.base, m, 'config', '--file', path.join(sub, 'config'), 'core.worktree', '../../../sub');
    fs.rmSync(path.join(m, '.git/objects/info/alternates'));
    fs.writeFileSync(path.join(sub, 'objects/info/alternates'), '../../../objects\n');
    expect(await relocationBlockers([g], { from: l.home, to: LINUX }, runGit)).toEqual([]);
  });

  it('refuses a main checkout whose .git file names its Git directory by a full path the move leaves behind', async () => {
    const l = seedHere(made);
    const app = path.join(l.home, 'app');
    const gitDir = path.join(l.home, 'app.git');
    git(l.base, l.home, 'init', '-q', '--separate-git-dir', gitDir, app);
    const g: GitGraph = {
      id: 'g_app', commonDir: gitDir, main: { path: app, gitDir, head: null, branch: 'refs/heads/main', status: [], index: 'a'.repeat(64), characters: [] },
      worktrees: [], unused: [], stash: [],
    };
    expect((await relocationBlockers([g], { from: l.home, to: LINUX }, runGit)).map((b) => b.message)).toEqual([
      `${app}/.git names its Git directory ${gitDir} by its full path, which git worktree repair leaves as it is in a main checkout; make it relative, or keep the repository outside ${l.home}`,
    ]);
  });
});
