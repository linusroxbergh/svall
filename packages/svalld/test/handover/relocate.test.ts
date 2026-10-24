import { describe, expect, it } from 'vitest';
import { emptyState, FleetConfig, TRANSFER_SCHEMA_VERSION, TransferManifestV1, type Character, type GitCheckout, type MachineId } from '@svall/protocol';
import { repoSlug } from '../../src/docs.js';
import { destinationView, docsBlockers, docsRenames, relocate, relocationProblem } from '../../src/handover/relocate.js';

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

  it('reads a path and the homes as the inventory does, with no .., // or trailing slash', () => {
    expect(relocate('/Users//ada/x/', TO_LINUX)).toBe('/home/ada/x');
    expect(relocate('/Users/ada/../shared/repo', TO_LINUX)).toBe('/Users/shared/repo');
    const slashed = { from: '/Users/ada/', to: '/home/ada/' };
    expect(relocate('/Users/ada/x', slashed)).toBe('/home/ada/x');
    expect(relocate('/home/ada/x', { from: slashed.to, to: slashed.from })).toBe('/Users/ada/x');
  });
});

describe('relocationProblem', () => {
  it('refuses a path in the destination\'s home outside the source\'s, which would land where one of the source\'s lands', () => {
    expect(relocationProblem('/home/ada/x', TO_LINUX)).toContain('/home/ada/x lies in the destination\'s home /home/ada but not in the source\'s home /Users/ada');
    expect(relocationProblem('/home/ada', TO_LINUX)).toBeDefined();
    expect(relocationProblem('/Users/ada/../../home/ada/x', TO_LINUX)).toBeDefined();
    expect(relocationProblem('/home/ada/x', { from: '/Users/ada', to: '/home/ada/' })).toBeDefined();
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
    browser: { tabs: [{ id: 't1', url: 'file:///Users/ada/app/a%20b.html?x=1#top', title: '' }, { id: 't2', url: 'https://x.test/Users/ada', title: '' }, { id: 't3', url: 'file:///Users/ada/50%25off.html', title: '' }] },
    agent: { kind: 'claude', sessionId: '11111111-1111-4111-8111-111111111111', transcriptPath: '/Users/ada/.claude/projects/-Users-ada-app-feature/s.jsonl', status: 'idle', lastActivityAt: 0 },
    second: { cwd: '/Users/ada/scratch', unread: false },
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
    expect([c.cwd, c.repo!.root, c.repo!.mainRoot, c.second!.cwd]).toEqual(['/home/ada/app-feature', '/home/ada/app-feature', '/home/ada/app', '/home/ada/scratch']);
    expect(c.context.map((x) => x.ref)).toEqual(['/home/ada/notes/plan.md', 'https://github.com/ada/app/pull/1', '/Volumes/work/spec.md']);
    expect(c.browser!.tabs.map((t) => t.url)).toEqual(['file:///home/ada/app/a%20b.html?x=1#top', 'https://x.test/Users/ada', 'file:///home/ada/50%25off.html']);
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

  it('leaves a root or Git place not spelled plainly as sent, where moving it would have tidied it into a plain path', () => {
    const m = manifest('/home/ada');
    const odd = ['/Users/ada/x/../app', '/Users/ada/app/', '/Users/ada//app', '/Users/ada/./app', '/Users/ada/../../etc/x'];
    m.roots = odd.map((p, i) => ({ ...m.roots[0], id: `r_${i}`, path: p }));
    m.git![0].commonDir = '/Users/ada/app/../app/.git';
    const v = destinationView(m);
    expect(v.roots.map((r) => r.path)).toEqual(odd);
    expect(v.git![0].commonDir).toBe('/Users/ada/app/../app/.git');
  });

  it('reads back as the manifest it came from when the way back swaps the homes', () => {
    const m = manifest('/home/ada');
    const v = destinationView(m);
    const back = destinationView({ ...v, home: '/home/ada', destinationHome: '/Users/ada' });
    expect({ ...back, home: m.home, destinationHome: m.destinationHome }).toEqual(m);
  });
});

describe('docsRenames and docsBlockers', () => {
  const slug = (p: string): string => `repos/${repoSlug(p)}`;
  const [from, to] = [slug('/Users/ada/app'), slug('/home/ada/app')];
  /** The manifest with a docs root holding `dirs`, and a character standing in each of `cwds` beside c1. */
  const withDocs = (dirs: string[], cwds: string[] = [], m = manifest('/home/ada')): TransferManifestV1 => {
    const snapshot = structuredClone(m.snapshot);
    cwds.forEach((cwd, i) => { snapshot.characters[`c${i + 2}`] = char(`c${i + 2}`, { cwd }); });
    const files = dirs.map((d) => ({ type: 'file' as const, path: `${d}/n.md`, mode: 0o644, size: 1, mtimeMs: 0, sha256: SHA }));
    return { ...m, snapshot, roots: [...m.roots, { id: 'r_d', kind: 'docs', entry: 'dir', path: `${m.home}/.svall/docs`, files }] };
  };

  it('renames the folder of each repository or folder that moves, both ways, and none outside the home', () => {
    expect(docsRenames(withDocs([], ['~', '/Volumes/work/repo']))).toEqual([{ from, to }, { from: slug('/Users/ada'), to: slug('/home/ada') }]);
    expect(docsRenames({ ...destinationView(manifest('/home/ada')), destinationHome: '/Users/ada' })).toEqual([{ from: to, to: from }]);
  });

  it('refuses docs that hold both names, two folders that take one name, or a name another rename leaves', () => {
    expect(docsBlockers(withDocs([from]))).toEqual([]);
    expect(docsBlockers(withDocs([to]))).toEqual([]);
    expect(docsBlockers(withDocs([from, to]))).toEqual([expect.objectContaining({ code: 'path_unsupported', entity: { kind: 'root', id: 'r_d' } })]);
    const spellings = ['/Users/ada/tool', '/Users/ada/x/../tool'];
    expect(docsBlockers(withDocs(spellings.map(slug), spellings))).toHaveLength(2);
    expect(docsBlockers(withDocs([slug('/Users/ada/x')], ['/Users/ada/x', '/Users/ada/linux/x'], manifest('/Users/ada/linux')))).toEqual([
      expect.objectContaining({ message: expect.stringContaining('a name another of its folders takes or leaves') }),
    ]);
  });

  it('refuses docs whose repos folder is a link only when a folder in it would be renamed', () => {
    const linked = (m: TransferManifestV1): TransferManifestV1 => {
      const docs = withDocs([], [], m);
      docs.roots.at(-1)!.files.push({ type: 'symlink', path: 'repos', target: '/Volumes/notes' });
      return docs;
    };
    expect(docsBlockers(linked(manifest('/home/ada')))).toEqual([expect.objectContaining({ message: expect.stringContaining('/Users/ada/.svall/docs/repos is a link') })]);
    expect(docsBlockers(linked(manifest('/Users/ada')))).toEqual([]);
  });
});
