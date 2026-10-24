import { describe, expect, it } from 'vitest';
import { emptyState, FleetConfig, TRANSFER_SCHEMA_VERSION, TransferManifestV1, type Character, type GitCheckout, type MachineId } from '@svall/protocol';
import { destinationView, relocate, relocationProblem } from '../../src/handover/relocate.js';

const MAC = '9b4d0b1c-2d3e-4f50-8617-9a0b1c2d3e4f' as MachineId;
const TRIFT = '42aa0b1c-2d3e-4f50-8617-9a0b1c2d3e4f' as MachineId;
const SHA = 'a'.repeat(64);
const COMMIT = 'b'.repeat(40);
const TO_LINUX = { from: '/Users/ada', to: '/home/ada' };

describe('relocate', () => {
  it('moves the home and each path under it, on a component boundary, and leaves any other path where it is', () => {
    expect(relocate('/Users/ada', TO_LINUX)).toBe('/home/ada');
    expect(relocate('/Users/ada/code/app', TO_LINUX)).toBe('/home/ada/code/app');
    expect(relocate('/Users/adam/code', TO_LINUX)).toBe('/Users/adam/code');
    expect(relocate('/Volumes/work/repo', TO_LINUX)).toBe('/Volumes/work/repo');
    expect(relocate('~/code', TO_LINUX)).toBe('~/code');
  });

  it('comes back to the path it left from', () => {
    const back = { from: TO_LINUX.to, to: TO_LINUX.from };
    for (const p of ['/Users/ada', '/Users/ada/a b/ü', '/Volumes/work/repo', '/srv/x']) expect(relocate(relocate(p, TO_LINUX), back)).toBe(p);
  });
});

describe('relocationProblem', () => {
  it('refuses a path in the destination\'s home outside this machine\'s, which would land where one of this home lands', () => {
    expect(relocationProblem('/home/ada/x', TO_LINUX)).toContain('/home/ada/x lies in the destination\'s home /home/ada but not in this machine\'s home /Users/ada');
    expect(relocationProblem('/home/ada', TO_LINUX)).toBeDefined();
  });

  it('takes a path under this machine\'s home, one outside both homes, and any path between accounts with the same home', () => {
    expect(relocationProblem('/Users/ada/x', TO_LINUX)).toBeUndefined();
    expect(relocationProblem('/home/adam/x', TO_LINUX)).toBeUndefined();
    expect(relocationProblem('/srv/x', TO_LINUX)).toBeUndefined();
    expect(relocationProblem('/Users/ada/x', { from: '/Users/ada', to: '/Users/ada' })).toBeUndefined();
  });

  it('takes a path in a destination home nested in this machine\'s, which moves with the rest of it', () => {
    expect(relocationProblem('/Users/ada/linux/x', { from: '/Users/ada', to: '/Users/ada/linux' })).toBeUndefined();
  });
});

function checkout(p: string, gitDir: string): GitCheckout {
  return { path: p, gitDir, head: COMMIT, branch: 'main', status: [], index: SHA, characters: ['c1'] };
}

function char(id: string, o: Partial<Character>): Character {
  return {
    id, islandId: 'i1', cell: { x: 0, y: 0 }, name: id, note: '', portrait: 'fox', instructions: '', cwd: '/',
    context: [], shell: { lastOutputAt: 0 }, unread: false, ...o,
  };
}

function manifest(destinationHome: string): TransferManifestV1 {
  const snapshot = emptyState();
  snapshot.home.cwd = '/Users/ada/.svall/home';
  snapshot.defaultCwd = '~/code';
  snapshot.islands.i1 = {
    id: 'i1', name: 'i1', description: '', instructions: '', position: { x: 0, y: 0 }, size: { w: 4, h: 3 }, seed: 1,
    context: [{ kind: 'folder', ref: '/Users/ada/notes', label: '', source: 'manual' }],
  };
  snapshot.characters.c1 = char('c1', {
    cwd: '/Users/ada/app-feature',
    repo: { root: '/Users/ada/app-feature', mainRoot: '/Users/ada/app', branch: 'feature', isWorktree: true },
    context: [
      { kind: 'file', ref: '/Users/ada/notes/plan.md', label: '', source: 'manual' },
      { kind: 'github', ref: 'https://github.com/ada/app/pull/1', label: '', source: 'auto' },
      { kind: 'file', ref: '/Volumes/work/spec.md', label: '', source: 'manual' },
    ],
    browser: { tabs: [{ id: 't1', url: 'file:///Users/ada/app/a%20b.html?x=1#top', title: '' }, { id: 't2', url: 'https://x.test/Users/ada', title: '' }] },
    agent: { kind: 'claude', sessionId: '11111111-1111-4111-8111-111111111111', transcriptPath: '/Users/ada/.claude/projects/-Users-ada-app-feature/s.jsonl', status: 'idle', lastActivityAt: 0 },
    second: { cwd: '~/scratch', unread: false },
  });
  const fleet = FleetConfig.parse({ id: '5e1f0b1c-2d3e-4f50-8617-9a0b1c2d3e4f', home: { cwd: '/Users/ada/.svall/home' }, defaultCwd: '/Users/ada/code' });
  return TransferManifestV1.parse({
    version: TRANSFER_SCHEMA_VERSION, transactionId: 't1', generation: 4, fromMachineId: MAC, toMachineId: TRIFT,
    home: '/Users/ada', destinationHome, fleet, snapshot, excludes: [],
    roots: [
      { id: 'r_1', kind: 'repo', entry: 'dir', path: '/Users/ada/app', files: [{ type: 'symlink', path: 'cfg', target: '/Users/ada/cfg' }] },
      { id: 'r_2', kind: 'worktree', entry: 'dir', path: '/Users/ada/app-feature', files: [] },
      { id: 'r_3', kind: 'context', entry: 'file', path: '/Volumes/work/spec.md', files: [] },
    ],
    sessions: [{
      characterId: 'c1', agent: 'claude', sessionId: '11111111-1111-4111-8111-111111111111', sourcePath: '/Users/ada/.claude/projects/-Users-ada-app-feature/s.jsonl',
      sourceHome: '/Users/ada/.claude', destinationHome: `${destinationHome}/.claude`, destinationPath: `${destinationHome}/.claude/projects/-Users-ada-app-feature/s.jsonl`, files: [],
    }],
    git: [{
      id: 'g1', commonDir: '/Users/ada/app/.git',
      main: checkout('/Users/ada/app', '/Users/ada/app/.git'),
      worktrees: [checkout('/Users/ada/app-feature', '/Users/ada/app/.git/worktrees/app-feature')],
      unused: [{ path: '/Users/ada/app-old', head: COMMIT, branch: 'old', prunable: false }],
      stash: [], tips: [COMMIT],
      commands: [{ at: '/Users/ada/app/.git/config', key: 'core.fsmonitor', value: 'watchman' }],
    }],
  });
}

describe('destinationView', () => {
  it('is the manifest itself between accounts with the same home', () => {
    const m = manifest('/Users/ada');
    expect(destinationView(m)).toBe(m);
  });

  it('names every root, Git place and portable path where it lies on the destination, and the destination\'s home', () => {
    const m = manifest('/home/ada');
    const v = destinationView(m);
    expect(v.home).toBe('/home/ada');
    expect(v.roots.map((r) => r.path)).toEqual(['/home/ada/app', '/home/ada/app-feature', '/Volumes/work/spec.md']);
    const [g] = v.git!;
    expect([g.commonDir, g.main!.path, g.main!.gitDir, g.worktrees[0].path, g.worktrees[0].gitDir, g.unused[0].path, g.commands![0].at]).toEqual([
      '/home/ada/app/.git', '/home/ada/app', '/home/ada/app/.git', '/home/ada/app-feature', '/home/ada/app/.git/worktrees/app-feature', '/home/ada/app-old', '/home/ada/app/.git/config',
    ]);
    const c = v.snapshot.characters.c1;
    expect([c.cwd, c.repo!.root, c.repo!.mainRoot, c.second!.cwd]).toEqual(['/home/ada/app-feature', '/home/ada/app-feature', '/home/ada/app', '~/scratch']);
    expect(c.context.map((x) => x.ref)).toEqual(['/home/ada/notes/plan.md', 'https://github.com/ada/app/pull/1', '/Volumes/work/spec.md']);
    expect(c.browser!.tabs.map((t) => t.url)).toEqual(['file:///home/ada/app/a%20b.html?x=1#top', 'https://x.test/Users/ada']);
    expect(v.snapshot.islands.i1.context[0].ref).toBe('/home/ada/notes');
    expect([v.snapshot.home.cwd, v.snapshot.defaultCwd, v.fleet.home.cwd, v.fleet.defaultCwd]).toEqual(['/home/ada/.svall/home', '~/code', '/home/ada/.svall/home', '/home/ada/code']);
  });

  it('leaves the links as their text, the sessions to place their transcripts, and the manifest it reads untouched', () => {
    const m = manifest('/home/ada');
    const before = structuredClone(m);
    const v = destinationView(m);
    expect(v.roots[0].files).toEqual([{ type: 'symlink', path: 'cfg', target: '/Users/ada/cfg' }]);
    expect(v.sessions).toEqual(m.sessions);
    expect(v.snapshot.characters.c1.agent!.transcriptPath).toBe('/Users/ada/.claude/projects/-Users-ada-app-feature/s.jsonl');
    expect(v.destinationHome).toBe('/home/ada');
    expect(TransferManifestV1.parse(v)).toEqual(v);
    expect(m).toEqual(before);
  });

  it('reads back as the manifest it came from when the way back swaps the homes', () => {
    const m = manifest('/home/ada');
    const v = destinationView(m);
    const back = destinationView({ ...v, home: '/home/ada', destinationHome: '/Users/ada' });
    expect({ ...back, home: m.home, destinationHome: m.destinationHome }).toEqual(m);
  });
});
