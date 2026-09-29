import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ContextItem } from '@svall/protocol';
import { Config } from '../src/config.js';
import { resolveRepo, webUrl } from '../src/links/git.js';
import { lookupPr, prState } from '../src/links/gh.js';
import { linearLink } from '../src/links/linear.js';
import { CONCURRENCY, refreshLinks, refreshMany, SLICES, slice } from '../src/links/refresh.js';
import { Store } from '../src/store.js';
import { cleanHomes, makeHome } from './helpers.js';

afterEach(cleanHomes);

function makeRepo(): { main: string; wt: string } {
  const home = makeHome();
  const main = path.join(home, 'main');
  const wt = path.join(home, 'wt');
  const git = (...a: string[]) => execFileSync('git', a, { cwd: main, stdio: 'ignore' });
  execFileSync('git', ['init', '-q', '-b', 'main', main]);
  git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '--allow-empty', '-qm', 'init');
  git('worktree', 'add', '-q', '-b', 'linus/eng-1907-thing', wt);
  return { main, wt };
}

describe('resolveRepo', () => {
  it('resolves main checkout and worktree', async () => {
    const { main, wt } = makeRepo();
    const m = await resolveRepo(main);
    expect(m).toMatchObject({ branch: 'main', isWorktree: false });
    expect(m?.root).toBe(m?.mainRoot);
    const w = await resolveRepo(wt);
    expect(w).toMatchObject({ branch: 'linus/eng-1907-thing', isWorktree: true });
    expect(w?.mainRoot).toBe(m?.root);
  });
  it('reads a submodule as its own checkout, not a worktree of the .git it lives in', async () => {
    const home = makeHome();
    const inner = path.join(home, 'inner');
    const outer = path.join(home, 'outer');
    const commit = (cwd: string) => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '--allow-empty', '-qm', 'init'], { cwd, stdio: 'ignore' });
    for (const d of [inner, outer]) { execFileSync('git', ['init', '-q', '-b', 'main', d]); commit(d); }
    execFileSync('git', ['-c', 'protocol.file.allow=always', 'submodule', '-q', 'add', inner, 'sub'], { cwd: outer, stdio: 'ignore' });

    const s = await resolveRepo(path.join(outer, 'sub'));
    expect(s).toMatchObject({ isWorktree: false });
    expect(s?.mainRoot).toBe(s?.root);
    expect(s?.mainRoot).not.toContain('.git');
  });

  it('returns undefined outside a repo', async () => {
    expect(await resolveRepo('/')).toBeUndefined();
  });
  it('reads a repo with no commits yet, on the branch it will make', async () => {
    const dir = path.join(makeHome(), 'fresh');
    execFileSync('git', ['init', '-q', '-b', 'trunk', dir]);
    expect(await resolveRepo(dir)).toMatchObject({ branch: 'trunk', isWorktree: false });
  });
});

describe('webUrl', () => {
  it('reads the shapes git prints for a remote', () => {
    expect(webUrl('git@github.com:o/r.git')).toBe('https://github.com/o/r');
    expect(webUrl('https://github.com/o/r.git')).toBe('https://github.com/o/r');
    expect(webUrl('ssh://git@github.com/o/r')).toBe('https://github.com/o/r');
    expect(webUrl('ssh://git@gitlab.com:2222/o/r')).toBe('https://gitlab.com/o/r');
    expect(webUrl('git@host:o/r.git/')).toBe('https://host/o/r');
    expect(webUrl('/srv/git/bare.git')).toBeUndefined();
    expect(webUrl('file:///srv/git/bare')).toBeUndefined();
  });

  it('keeps a credential out of the url it hands on', () => {
    expect(webUrl('https://user:TOKEN@github.com/o/r.git')).toBe('https://github.com/o/r');
    expect(webUrl('https://user:p@ss@github.com/o/r')).toBe('https://github.com/o/r');
    expect(webUrl('https://x-access-token:ghp_a/b@github.com/o/r.git')).toBeUndefined();
  });
});

describe('prState and lookupPr', () => {
  it('maps gh fields', () => {
    expect(prState({ state: 'MERGED', isDraft: false, reviewDecision: '' })).toBe('merged');
    expect(prState({ state: 'CLOSED', isDraft: false, reviewDecision: '' })).toBe('closed');
    expect(prState({ state: 'OPEN', isDraft: true, reviewDecision: '' })).toBe('draft');
    expect(prState({ state: 'OPEN', isDraft: false, reviewDecision: 'APPROVED' })).toBe('approved');
    expect(prState({ state: 'OPEN', isDraft: false, reviewDecision: 'CHANGES_REQUESTED' })).toBe('changes');
    expect(prState({ state: 'OPEN', isDraft: false, reviewDecision: '' })).toBe('open');
  });
  it('caches per cwd and branch', async () => {
    let calls = 0;
    const exec = async () => { calls++; return JSON.stringify({ url: 'https://x/pr/1', number: 1, state: 'OPEN', isDraft: false, reviewDecision: '' }); };
    const a = await lookupPr('/r', 'b', { exec, now: () => 0, rand: () => 0.5 });
    const b = await lookupPr('/r', 'b', { exec, now: () => 1000 });
    expect(a).toEqual({ kind: 'pr', ref: 'https://x/pr/1', label: '#1', source: 'auto', prState: 'open' });
    expect(b).toEqual(a);
    expect(calls).toBe(1);
    await lookupPr('/r', 'b', { exec, now: () => 400_000 });
    expect(calls).toBe(2);
  });
  // what execFile rejects with when gh exits non-zero
  const ghFailed = (stderr: string) => async () => { throw Object.assign(new Error('Command failed: gh pr view'), { code: 1, stderr }); };
  it('holds gh saying there is no PR, for a branch, a repository with no remote or none on GitHub, as none', async () => {
    let calls = 0;
    const none = ['no pull requests found for branch "b"', 'no git remotes found', 'none of the git remotes configured for this repository point to a known GitHub host'];
    for (const [i, stderr] of none.entries()) {
      const exec = async () => { calls++; return ghFailed(stderr)(); };
      expect(await lookupPr(`/none-${i}`, 'b', { exec, now: () => 0, rand: () => 0 })).toBeUndefined();
      expect(await lookupPr(`/none-${i}`, 'b', { exec, now: () => 1000 })).toBeUndefined();
    }
    expect(calls).toBe(3);
  });
  it('says a lookup failed, rather than that there is no PR, and asks again a minute later', async () => {
    let calls = 0;
    const exec = async () => { calls++; return ghFailed('error connecting to api.github.com')(); };
    await expect(lookupPr('/offline', 'b', { exec, now: () => 0 })).rejects.toThrow(/gh pr view/);
    await expect(lookupPr('/offline', 'b', { exec, now: () => 59_999 })).rejects.toThrow(/gh pr view/);
    expect(calls).toBe(1);
    await expect(lookupPr('/offline', 'b', { exec, now: () => 60_000 })).rejects.toThrow();
    expect(calls).toBe(2);
  });
  it('asks a missing gh again only once the cache expires', async () => {
    let calls = 0;
    const exec = async () => { calls++; throw Object.assign(new Error('spawn gh ENOENT'), { code: 'ENOENT' }); };
    for (const now of [0, 30_000, 239_999]) await lookupPr('/missing', 'b', { exec, now: () => now, rand: () => 0 });
    expect(calls).toBe(1);
  });

  it('drops a reading that has run out rather than holding it for the life of the daemon', async () => {
    let calls = 0;
    const exec = async () => { calls++; return JSON.stringify({ url: 'https://x/pr/1', number: 1, state: 'OPEN', isDraft: false, reviewDecision: '' }); };
    await lookupPr('/gone', 'b', { exec, now: () => 0, rand: () => 0 });          // stands until 240_000
    await lookupPr('/kept', 'b', { exec, now: () => 300_000, rand: () => 0 });    // the miss sweeps /gone out
    expect(calls).toBe(2);
    // the clock is wound back inside the old deadline: a reading still in the cache would answer from it
    await lookupPr('/gone', 'b', { exec, now: () => 100_000, rand: () => 0 });
    expect(calls).toBe(3);
    await lookupPr('/kept', 'b', { exec, now: () => 400_000, rand: () => 0 });
    expect(calls).toBe(3);
  });

  it('gives each entry its own deadline, so a fleet filled in one sweep does not expire in one sweep', async () => {
    let calls = 0;
    const exec = async () => { calls++; return JSON.stringify({ url: 'https://x/pr/1', number: 1, state: 'OPEN', isDraft: false, reviewDecision: '' }); };
    // two characters ask in the same moment; the earliest and latest deadlines the jitter allows
    await lookupPr('/early', 'b', { exec, now: () => 0, rand: () => 0 });
    await lookupPr('/late', 'b', { exec, now: () => 0, rand: () => 1 });
    expect(calls).toBe(2);
    await lookupPr('/early', 'b', { exec, now: () => 250_000 });
    expect(calls).toBe(3);
    await lookupPr('/late', 'b', { exec, now: () => 250_000 });
    expect(calls).toBe(3);
  });
});

describe('linearLink', () => {
  it('finds a team key in the branch', () => {
    expect(linearLink('linus/eng-1907-thing', { workspace: 'acme', teamKeys: ['ENG'] }))
      .toEqual({ kind: 'linear', ref: 'https://linear.app/acme/issue/ENG-1907', label: 'ENG-1907', source: 'auto' });
    expect(linearLink('main', { workspace: 'acme', teamKeys: ['ENG'] })).toBeUndefined();
    expect(linearLink('eng-1', undefined)).toBeUndefined();
  });
});

describe('refreshLinks', () => {
  it('sets repo and replaces auto links while keeping manual ones', async () => {
    const { wt } = makeRepo();
    const store = Store.load(path.join(makeHome(), 'state.json'), () => {});
    store.update((d) => {
      d.characters.c_a = {
        id: 'c_a', islandId: 'i', cell: { x: 0, y: 1 }, name: 'a', portrait: 'fox', note: '', instructions: '', cwd: wt,
        context: [{ kind: 'other', ref: 'https://keep', label: 'keep', source: 'manual' }, { kind: 'pr', ref: 'https://old', label: 'old', source: 'auto' }],
        shell: { lastOutputAt: 0 }, unread: false,
      };
    });
    await refreshLinks(store, Config.parse({ linear: { workspace: 'acme', teamKeys: ['ENG'] } }), 'c_a', { lookupPr: async () => undefined });
    const c = store.state.characters.c_a;
    expect(c.repo?.branch).toBe('linus/eng-1907-thing');
    expect(c.context.map((l) => l.label)).toEqual(['keep', 'ENG-1907']);
  });

  it('keeps the links the scribe found in the transcript', async () => {
    const { wt } = makeRepo();
    const store = Store.load(path.join(makeHome(), 'state.json'), () => {});
    store.update((d) => {
      d.characters.c_a = {
        id: 'c_a', islandId: 'i', cell: { x: 0, y: 1 }, name: 'a', portrait: 'fox', note: '', instructions: '', cwd: wt,
        context: [{ kind: 'other', ref: 'https://doc', label: 'doc', source: 'scribe' }, { kind: 'pr', ref: 'https://old', label: 'old', source: 'auto' }],
        shell: { lastOutputAt: 0 }, unread: false,
      };
    });
    await refreshLinks(store, Config.parse({ linear: { workspace: 'acme', teamKeys: ['ENG'] } }), 'c_a', { lookupPr: async () => undefined });
    expect(store.state.characters.c_a.context.map((l) => `${l.source} ${l.label}`)).toEqual(['scribe doc', 'auto ENG-1907']);
  });

  it('puts the branch PR in front of the links already there', async () => {
    const { wt } = makeRepo();
    const store = Store.load(path.join(makeHome(), 'state.json'), () => {});
    store.update((d) => {
      d.characters.c_a = {
        id: 'c_a', islandId: 'i', cell: { x: 0, y: 1 }, name: 'a', portrait: 'fox', note: '', instructions: '', cwd: wt,
        context: [{ kind: 'other', ref: 'https://keep', label: 'keep', source: 'manual' }, { kind: 'other', ref: 'https://doc', label: 'doc', source: 'scribe' }],
        shell: { lastOutputAt: 0 }, unread: false,
      };
    });
    const pr: ContextItem = { kind: 'pr', ref: 'https://github.com/o/r/pull/7', label: '#7', source: 'auto' };
    await refreshLinks(store, Config.parse({ linear: { workspace: 'acme', teamKeys: ['ENG'] } }), 'c_a', { lookupPr: async () => pr });
    expect(store.state.characters.c_a.context.map((l) => l.label)).toEqual(['#7', 'keep', 'doc', 'ENG-1907']);
  });

  it('keeps a pin on an auto item that survives the refresh under the same ref', async () => {
    const { wt } = makeRepo();
    const store = Store.load(path.join(makeHome(), 'state.json'), () => {});
    store.update((d) => {
      d.characters.c_a = {
        id: 'c_a', islandId: 'i', cell: { x: 0, y: 1 }, name: 'a', portrait: 'fox', note: '', instructions: '', cwd: wt,
        context: [{ kind: 'linear', ref: 'https://linear.app/acme/issue/ENG-1907', label: 'ENG-1907', source: 'auto', pinned: true }],
        shell: { lastOutputAt: 0 }, unread: false,
      };
    });
    await refreshLinks(store, Config.parse({ linear: { workspace: 'acme', teamKeys: ['ENG'] } }), 'c_a', { lookupPr: async () => undefined });
    const c = store.state.characters.c_a;
    expect(c.context).toEqual([{ kind: 'linear', ref: 'https://linear.app/acme/issue/ENG-1907', label: 'ENG-1907', source: 'auto', pinned: true }]);
  });

  it('leaves a manual item naming the same link as it is, pin and all, and adds no chip beside it', async () => {
    const { wt } = makeRepo();
    const store = Store.load(path.join(makeHome(), 'state.json'), () => {});
    const mine = { kind: 'github' as const, ref: 'https://github.com/o/r', label: 'the repo', source: 'manual' as const, pinned: true as const };
    store.update((d) => {
      d.characters.c_a = {
        id: 'c_a', islandId: 'i', cell: { x: 0, y: 1 }, name: 'a', portrait: 'fox', note: '', instructions: '', cwd: wt,
        context: [mine], shell: { lastOutputAt: 0 }, unread: false,
      };
    });
    const originUrl = async () => 'https://github.com/o/r';
    await refreshLinks(store, Config.parse({}), 'c_a', { lookupPr: async () => undefined, originUrl });
    expect(store.state.characters.c_a.context).toEqual([mine]);
    // the PR opens and the repository is no longer worth an auto chip: the link the user made stays
    const pr = { kind: 'pr' as const, ref: 'https://github.com/o/r/pull/7', label: '#7', source: 'auto' as const, prState: 'open' as const };
    await refreshLinks(store, Config.parse({}), 'c_a', { lookupPr: async () => pr, originUrl });
    expect(store.state.characters.c_a.context).toEqual([pr, mine]);
  });

  it('reads a manual item written without the scheme as the same link', async () => {
    const { wt } = makeRepo();
    const store = Store.load(path.join(makeHome(), 'state.json'), () => {});
    store.update((d) => {
      d.characters.c_a = {
        id: 'c_a', islandId: 'i', cell: { x: 0, y: 1 }, name: 'a', portrait: 'fox', note: '', instructions: '', cwd: wt,
        context: [{ kind: 'github', ref: 'github.com/o/r/', label: 'the repo', source: 'manual' }],
        shell: { lastOutputAt: 0 }, unread: false,
      };
    });
    await refreshLinks(store, Config.parse({}), 'c_a', { lookupPr: async () => undefined, originUrl: async () => 'https://github.com/o/r' });
    expect(store.state.characters.c_a.context).toEqual([{ kind: 'github', ref: 'github.com/o/r/', label: 'the repo', source: 'manual' }]);
  });

  it('puts the state of a PR on the scribe or manual link to it, for as long as the lookup reads it', async () => {
    const { wt } = makeRepo();
    const store = Store.load(path.join(makeHome(), 'state.json'), () => {});
    const review = { kind: 'pr' as const, ref: 'https://github.com/o/r/pull/5', label: 'my review', source: 'scribe' as const };
    store.update((d) => {
      d.characters.c_a = {
        id: 'c_a', islandId: 'i', cell: { x: 0, y: 1 }, name: 'a', portrait: 'fox', note: '', instructions: '', cwd: wt,
        context: [review], shell: { lastOutputAt: 0 }, unread: false,
      };
    });
    const pr = (n: number) => ({ kind: 'pr' as const, ref: `https://github.com/o/r/pull/${n}`, label: `#${n}`, source: 'auto' as const, prState: 'approved' as const });
    await refreshLinks(store, Config.parse({}), 'c_a', { lookupPr: async () => pr(5) });
    expect(store.state.characters.c_a.context).toEqual([{ ...review, prState: 'approved' }]);
    await refreshLinks(store, Config.parse({}), 'c_a', { lookupPr: async () => pr(9) });
    expect(store.state.characters.c_a.context).toEqual([pr(9), review]);
  });

  it('keeps the PR state on the manual link to it through a failed lookup', async () => {
    const { wt } = makeRepo();
    const store = Store.load(path.join(makeHome(), 'state.json'), () => {});
    const mine = { kind: 'pr' as const, ref: 'https://github.com/o/r/pull/5', label: 'mine', source: 'manual' as const };
    store.update((d) => {
      d.characters.c_a = {
        id: 'c_a', islandId: 'i', cell: { x: 0, y: 1 }, name: 'a', portrait: 'fox', note: '', instructions: '', cwd: wt,
        context: [mine], shell: { lastOutputAt: 0 }, unread: false,
      };
    });
    const pr = { kind: 'pr' as const, ref: 'https://github.com/o/r/pull/5', label: '#5', source: 'auto' as const, prState: 'approved' as const };
    await refreshLinks(store, Config.parse({}), 'c_a', { lookupPr: async () => pr });
    await refreshLinks(store, Config.parse({}), 'c_a', { lookupPr: async () => { throw new Error('gh: offline'); } });
    expect(store.state.characters.c_a.context).toEqual([{ ...mine, prState: 'approved' }]);
  });

  it('keeps the PR it has, pin and all, through a failed lookup, and still reads the ticket and the repository', async () => {
    const { wt } = makeRepo();
    const repo = await resolveRepo(wt);
    const store = Store.load(path.join(makeHome(), 'state.json'), () => {});
    const pr = { kind: 'pr' as const, ref: 'https://github.com/o/r/pull/7', label: '#7', source: 'auto' as const, prState: 'open' as const, pinned: true as const };
    const character = (id: string, context: ContextItem[]) => ({
      id, islandId: 'i', cell: { x: 0, y: 1 }, name: id, portrait: 'fox' as const, note: '', instructions: '', cwd: wt, repo, context, shell: { lastOutputAt: 0 }, unread: false,
    });
    store.update((d) => { d.characters.c_a = character('c_a', [pr]); d.characters.c_b = character('c_b', []); });
    const deps = { lookupPr: async () => { throw new Error('gh: offline'); }, originUrl: async () => 'https://github.com/o/r' };
    const config = Config.parse({ linear: { workspace: 'acme', teamKeys: ['ENG'] } });
    await refreshMany(store, config, ['c_a', 'c_b'], deps);
    const ticket = { kind: 'linear', ref: 'https://linear.app/acme/issue/ENG-1907', label: 'ENG-1907', source: 'auto' };
    expect(store.state.characters.c_a.context).toEqual([pr, ticket]);
    expect(store.state.characters.c_b.context).toEqual([ticket, { kind: 'github', ref: 'https://github.com/o/r', label: 'o/r', source: 'auto' }]);
  });

  it('lets the PR of a checkout the character has left go, even when the lookup fails', async () => {
    const { main, wt } = makeRepo();
    const store = Store.load(path.join(makeHome(), 'state.json'), () => {});
    const pr = { kind: 'pr' as const, ref: 'https://github.com/o/r/pull/7', label: '#7', source: 'auto' as const, prState: 'open' as const };
    store.update((d) => {
      d.characters.c_a = {
        id: 'c_a', islandId: 'i', cell: { x: 0, y: 1 }, name: 'a', portrait: 'fox', note: '', instructions: '', cwd: wt, repo: { root: main, mainRoot: main, branch: 'main', isWorktree: false },
        context: [pr], shell: { lastOutputAt: 0 }, unread: false,
      };
    });
    await refreshLinks(store, Config.parse({ linear: { workspace: 'acme', teamKeys: ['ENG'] } }), 'c_a', { lookupPr: async () => { throw new Error('gh: offline'); }, originUrl: async () => undefined });
    expect(store.state.characters.c_a.context.map((l) => l.label)).toEqual(['ENG-1907']);
  });

  it('lets the PR of a branch the character has left go, even when the lookup fails', async () => {
    const { wt } = makeRepo();
    const repo = await resolveRepo(wt);
    const store = Store.load(path.join(makeHome(), 'state.json'), () => {});
    const pr = { kind: 'pr' as const, ref: 'https://github.com/o/r/pull/7', label: '#7', source: 'auto' as const, prState: 'open' as const, pinned: true as const };
    store.update((d) => {
      d.characters.c_a = {
        id: 'c_a', islandId: 'i', cell: { x: 0, y: 1 }, name: 'a', portrait: 'fox', note: '', instructions: '', cwd: wt, repo,
        context: [pr], shell: { lastOutputAt: 0 }, unread: false,
      };
    });
    execFileSync('git', ['-C', wt, 'checkout', '-q', '-b', 'linus/eng-2000-other']);
    await refreshLinks(store, Config.parse({ linear: { workspace: 'acme', teamKeys: ['ENG'] } }), 'c_a', { lookupPr: async () => { throw new Error('gh: offline'); }, originUrl: async () => undefined });
    expect(store.state.characters.c_a.context.map((l) => l.label)).toEqual(['ENG-2000']);
  });

  it('leaves the links as they are without asking gh while HEAD is detached, as it is mid-rebase', async () => {
    const { wt } = makeRepo();
    const store = Store.load(path.join(makeHome(), 'state.json'), () => {});
    const context: ContextItem[] = [
      { kind: 'pr', ref: 'https://github.com/o/r/pull/7', label: '#7', source: 'auto', prState: 'open', pinned: true },
      { kind: 'linear', ref: 'https://linear.app/acme/issue/ENG-1907', label: 'ENG-1907', source: 'auto' },
    ];
    const repo = await resolveRepo(wt);
    store.update((d) => {
      d.characters.c_a = {
        id: 'c_a', islandId: 'i', cell: { x: 0, y: 1 }, name: 'a', portrait: 'fox', note: '', instructions: '', cwd: wt, repo,
        context, shell: { lastOutputAt: 0 }, unread: false,
      };
    });
    execFileSync('git', ['-C', wt, 'checkout', '-q', '--detach']);
    let asked = 0;
    const config = Config.parse({ linear: { workspace: 'acme', teamKeys: ['ENG'] } });
    await refreshLinks(store, config, 'c_a', { lookupPr: async () => { asked++; return undefined; }, originUrl: async () => 'https://github.com/o/r' });
    expect(asked).toBe(0);
    expect(store.state.characters.c_a.context).toEqual(context);
    expect(store.state.characters.c_a.repo?.branch).toBe('HEAD');
    // the rebase done, a lookup that fails keeps the PR of the branch it came back to
    execFileSync('git', ['-C', wt, 'checkout', '-q', 'linus/eng-1907-thing']);
    await refreshLinks(store, config, 'c_a', { lookupPr: async () => { throw new Error('gh: offline'); }, originUrl: async () => 'https://github.com/o/r' });
    expect(store.state.characters.c_a.context).toEqual(context);
  });

  it('lets the links of a checkout the character has left go when the one it is in has HEAD detached', async () => {
    const { main, wt } = makeRepo();
    const store = Store.load(path.join(makeHome(), 'state.json'), () => {});
    const repo = await resolveRepo(wt);
    store.update((d) => {
      d.characters.c_a = {
        id: 'c_a', islandId: 'i', cell: { x: 0, y: 1 }, name: 'a', portrait: 'fox', note: '', instructions: '', cwd: main, repo,
        context: [
          { kind: 'pr', ref: 'https://github.com/o/r/pull/7', label: '#7', source: 'auto', prState: 'open' },
          { kind: 'linear', ref: 'https://linear.app/acme/issue/ENG-1907', label: 'ENG-1907', source: 'auto' },
        ],
        shell: { lastOutputAt: 0 }, unread: false,
      };
    });
    execFileSync('git', ['-C', main, 'checkout', '-q', '--detach']);
    let asked = 0;
    await refreshLinks(store, Config.parse({ linear: { workspace: 'acme', teamKeys: ['ENG'] } }), 'c_a', { lookupPr: async () => { asked++; return undefined; }, originUrl: async () => 'https://github.com/o/s' });
    expect(asked).toBe(0);
    expect(store.state.characters.c_a.context).toEqual([{ kind: 'github', ref: 'https://github.com/o/s', label: 'o/s', source: 'auto' }]);
    expect(store.state.characters.c_a.repo).toMatchObject({ root: (await resolveRepo(main))?.root, branch: 'HEAD' });
  });

  it('labels a repository by its path, however many segments it has', async () => {
    const { wt } = makeRepo();
    const store = Store.load(path.join(makeHome(), 'state.json'), () => {});
    store.update((d) => {
      d.characters.c_a = {
        id: 'c_a', islandId: 'i', cell: { x: 0, y: 1 }, name: 'a', portrait: 'fox', note: '', instructions: '', cwd: wt,
        context: [], shell: { lastOutputAt: 0 }, unread: false,
      };
    });
    await refreshLinks(store, Config.parse({}), 'c_a', { lookupPr: async () => undefined, originUrl: async () => 'https://gitlab.com/g/sub/r' });
    expect(store.state.characters.c_a.context[0].label).toBe('g/sub/r');
  });

  it('adds the origin only while there is no PR to point at', async () => {
    const { wt } = makeRepo();
    const store = Store.load(path.join(makeHome(), 'state.json'), () => {});
    store.update((d) => {
      d.characters.c_a = {
        id: 'c_a', islandId: 'i', cell: { x: 0, y: 1 }, name: 'a', portrait: 'fox', note: '', instructions: '', cwd: wt,
        context: [], shell: { lastOutputAt: 0 }, unread: false,
      };
    });
    const originUrl = async () => 'https://github.com/o/r';
    const repo = { kind: 'github', ref: 'https://github.com/o/r', label: 'o/r', source: 'auto' };
    await refreshLinks(store, Config.parse({}), 'c_a', { lookupPr: async () => undefined, originUrl });
    expect(store.state.characters.c_a.context).toEqual([repo]);

    const pr = { kind: 'pr' as const, ref: 'https://github.com/o/r/pull/7', label: '#7', source: 'auto' as const, prState: 'open' as const };
    await refreshLinks(store, Config.parse({}), 'c_a', { lookupPr: async () => pr, originUrl });
    expect(store.state.characters.c_a.context).toEqual([pr]);
  });

  it('does not restore the repo fallback when the scribe linked a PR for that repo', async () => {
    const { wt } = makeRepo();
    const store = Store.load(path.join(makeHome(), 'state.json'), () => {});
    const pr = { kind: 'pr' as const, ref: 'https://github.com/o/r/pull/42', label: '#42', source: 'scribe' as const };
    store.update((d) => {
      d.characters.c_a = {
        id: 'c_a', islandId: 'i', cell: { x: 0, y: 1 }, name: 'a', portrait: 'fox', note: '', instructions: '', cwd: wt,
        context: [pr], shell: { lastOutputAt: 0 }, unread: false,
      };
    });
    await refreshLinks(store, Config.parse({}), 'c_a', { lookupPr: async () => undefined, originUrl: async () => 'https://github.com/o/r' });
    expect(store.state.characters.c_a.context).toEqual([pr]);
  });

  it('leaves a character alone that moved while its links were being read', async () => {
    const { main, wt } = makeRepo();
    const store = Store.load(path.join(makeHome(), 'state.json'), () => {});
    store.update((d) => {
      d.characters.c_a = {
        id: 'c_a', islandId: 'i', cell: { x: 0, y: 1 }, name: 'a', portrait: 'fox', note: '', instructions: '', cwd: wt,
        context: [], shell: { lastOutputAt: 0 }, unread: false,
      };
    });
    const moved = { kind: 'pr' as const, ref: 'https://github.com/o/r/pull/9', label: '#9', source: 'auto' as const, prState: 'open' as const };
    const lookupPr = async () => {
      store.update((d) => { d.characters.c_a.cwd = main; d.characters.c_a.context = [moved]; });
      return { ...moved, ref: 'https://github.com/o/r/pull/7', label: '#7' };
    };
    await refreshLinks(store, Config.parse({}), 'c_a', { lookupPr, originUrl: async () => undefined });
    expect(store.state.characters.c_a.repo).toBeUndefined();
    expect(store.state.characters.c_a.context).toEqual([moved]);
  });
});

describe('refreshMany', () => {
  const character = (id: string, cwd: string) => ({
    id, islandId: 'i', cell: { x: 0, y: 1 }, name: id, portrait: 'fox' as const, note: '', instructions: '', cwd,
    context: [], shell: { lastOutputAt: 0 }, unread: false,
  });

  it('asks about at most CONCURRENCY characters at a time', async () => {
    const { wt } = makeRepo();
    const store = Store.load(path.join(makeHome(), 'state.json'), () => {});
    const ids = Array.from({ length: 12 }, (_, i) => `c_${i}`);
    store.update((d) => { for (const id of ids) d.characters[id] = character(id, wt); });

    let inFlight = 0, peak = 0;
    const lookupPr = async () => {
      peak = Math.max(peak, ++inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      return undefined;
    };
    await refreshMany(store, Config.parse({}), ids, { lookupPr, originUrl: async () => undefined });
    expect(peak).toBeLessThanOrEqual(CONCURRENCY);
    expect(peak).toBeGreaterThan(1);
  });

  it('lands the whole sweep as one state change', async () => {
    const { wt } = makeRepo();
    const store = Store.load(path.join(makeHome(), 'state.json'), () => {});
    const ids = ['c_a', 'c_b', 'c_c'];
    store.update((d) => { for (const id of ids) d.characters[id] = character(id, wt); });

    let updates = 0;
    store.subscribe(() => { updates++; });
    await refreshMany(store, Config.parse({ linear: { workspace: 'acme', teamKeys: ['ENG'] } }), ids, { lookupPr: async () => undefined });
    expect(updates).toBe(1);
    for (const id of ids) expect(store.state.characters[id].context.map((l) => l.label)).toEqual(['ENG-1907']);
  });

  it('writes nothing when the sweep changes nothing', async () => {
    const store = Store.load(path.join(makeHome(), 'state.json'), () => {});
    let updates = 0;
    store.subscribe(() => { updates++; });
    await refreshMany(store, Config.parse({}), ['c_gone'], { lookupPr: async () => undefined });
    expect(updates).toBe(0);
  });
});

describe('slice', () => {
  it('covers every character across SLICES ticks, and none of them twice', () => {
    const ids = Array.from({ length: 23 }, (_, i) => `c_${i}`);
    const seen = Array.from({ length: SLICES }, (_, tick) => slice(ids, tick)).flat();
    expect([...seen].sort()).toEqual([...ids].sort());
  });

  it('hands each tick an even share of a large fleet', () => {
    const ids = Array.from({ length: 200 }, (_, i) => `c_${i}`);
    for (let tick = 0; tick < SLICES; tick++) expect(slice(ids, tick).length).toBe(20);
  });

  it('gives a fleet smaller than SLICES one character per tick at most', () => {
    const ids = ['c_a', 'c_b', 'c_c'];
    for (let tick = 0; tick < SLICES; tick++) expect(slice(ids, tick).length).toBeLessThanOrEqual(1);
  });
});
