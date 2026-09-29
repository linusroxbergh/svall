import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { emptyState, FleetConfig, type GitCheckout, type MachineId, type TransferManifestV1 } from '@svall/protocol';
import { discoverGit, graphId, readWorktrees } from '../../src/handover/git-graph.js';
import { graphsHere, importGraphs, keptWorktrees, unreached, validateGraph } from '../../src/handover/git-import.js';
import { buildInventory, DEFAULT_EXCLUDES } from '../../src/handover/inventory.js';
import { buildManifest } from '../../src/handover/manifest.js';
import { runGit, type GitRunner } from '../../src/links/git.js';
import { char, crew, git, hasGit, park, parkedAt, seedHere, unpark, type Layout } from './git-fixture.js';

const made: string[] = [];
afterEach(() => { for (const d of made.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });

const MAC = '9b4d0b1c-2d3e-4f50-8617-9a0b1c2d3e4f' as MachineId;
const TRIFT = '42aa0b1c-2d3e-4f50-8617-9a0b1c2d3e4f' as MachineId;
const FLEET = FleetConfig.parse({ id: '5e1f0b1c-2d3e-4f50-8617-9a0b1c2d3e4f' });
const read = (file: string): string => fs.readFileSync(file, 'utf8');

const checkout = (p: string, gitDir: string): GitCheckout =>
  ({ path: p, gitDir, head: 'a'.repeat(40), branch: 'refs/heads/main', status: [], index: 'b'.repeat(64), characters: [] });

describe('importGraphs', () => {
  it('blocks every Git root of the manifest that no graph describes', async () => {
    const root = (id: string, kind: 'repo' | 'worktree' | 'gitdir' | 'cwd', p: string) => ({ id, kind, entry: 'dir' as const, path: p, files: [] });
    const manifest: Pick<TransferManifestV1, 'roots' | 'git'> = {
      roots: [root('r_app', 'repo', '/Users/me/app'), root('r_wt', 'worktree', '/Users/me/wt'), root('r_x', 'cwd', '/Users/me/x')],
      git: [{ id: 'g_app', commonDir: '/Users/me/app/.git', main: checkout('/Users/me/app', '/Users/me/app/.git'), worktrees: [], unused: [], stash: [] }],
    };
    const blockers = await importGraphs(manifest, { git: async () => ({ code: 1, stdout: '', stderr: '' }) });
    expect(blockers).toContainEqual({ code: 'worktree_unresolved', message: '/Users/me/wt: no Git graph in the manifest describes it', entity: { kind: 'root', id: 'r_wt' } });
    expect(blockers.filter((b) => b.entity?.kind === 'root')).toHaveLength(1);
  });
});

// what a handover moves: every carried root of the manifest, from the source machine's tree parked at `from`, to the same path here
function transfer(l: Layout, manifest: TransferManifestV1, from: string): void {
  for (const r of manifest.roots.filter((x) => !x.foldedInto)) fs.cpSync(parkedAt(l, from, r.path), r.path, { recursive: true, verbatimSymlinks: true });
}

/** What rsync --delete leaves of each carried root: the parked source's copy, and each kept registration as it was. */
function mirror(l: Layout, manifest: TransferManifestV1, from: string, kept: { registration: string }[]): void {
  const aside = fs.mkdtempSync('/tmp/svall-kept-');
  made.push(aside);
  const held = kept.map((k, i) => ({ at: k.registration, to: path.join(aside, String(i)) }));
  for (const h of held) fs.renameSync(h.at, h.to);
  for (const r of manifest.roots.filter((x) => !x.foldedInto)) {
    fs.rmSync(r.path, { recursive: true, force: true });
    fs.cpSync(parkedAt(l, from, r.path), r.path, { recursive: true, verbatimSymlinks: true });
  }
  for (const h of held) { fs.rmSync(h.at, { recursive: true, force: true }); fs.renameSync(h.to, h.at); }
}

async function manifestOf(l: Layout, state = crew(l)): Promise<TransferManifestV1> {
  const at = { home: l.home, fleetHome: path.join(l.home, '.svall') };
  const discovery = await discoverGit(state, { excludes: DEFAULT_EXCLUDES });
  expect(discovery.blockers).toEqual([]);
  const inventory = buildInventory(state, { fleet: FLEET }, { source: { machineId: MAC, ...at }, destination: { machineId: TRIFT, ...at } }, discovery);
  const built = await buildManifest(inventory, { generation: 1 });
  expect(built.blockers).toEqual([]);
  return built.manifest;
}

/** The fixture handed from the Mac, whose tree is parked, to trift, which receives each carried root at the same path. */
async function handed(l: Layout, state = crew(l)): Promise<{ manifest: TransferManifestV1; mac: string }> {
  const manifest = await manifestOf(l, state);
  const mac = park(l, 'mac');
  transfer(l, manifest, mac);
  return { manifest, mac };
}

// real git, with every command it was asked to run
function asking(): { git: GitRunner; asked: string[][] } {
  const asked: string[][] = [];
  return { asked, git: (args, cwd) => { asked.push([...args]); return runGit(args, cwd); } };
}
const rebuilds = (asked: string[][]): string[][] => asked.filter((a) => a.includes('worktree') && (a.includes('repair') || a.includes('prune')));

const real = hasGit ? describe : describe.skip;

// each seeds a real fixture with dozens of git commands, which a loaded machine takes its time over
real(`a real repository graph moved to another machine with the same home${hasGit ? '' : ' (skipped: git is not on PATH)'}`, { timeout: 180_000 }, () => {
  it('reads as the source left it at the same paths, with no gitfile written and no repair or prune', async () => {
    const l = seedHere(made);
    const { manifest, mac } = await handed(l);
    const d = l.source;
    const links = [d.nested, d.sibling, d.detached, d.locked].flatMap((w) => [path.join(w, '.git'), path.join(d.main, '.git/worktrees', path.basename(w), 'gitdir')]);
    const { git: g, asked } = asking();
    expect(await importGraphs(manifest, { git: g })).toEqual([]);
    expect(rebuilds(asked)).toEqual([]);
    for (const f of [...links, path.join(d.sub, '.git')]) expect(read(f), f).toBe(read(parkedAt(l, mac, f)));
    const byPath = (a: unknown[], b: unknown[]): number => String(a[0]).localeCompare(String(b[0]));
    const list = (await readWorktrees(d.main, runGit)).map((e) => [e.path, e.branch, e.locked, e.prunable]);
    expect(list.sort(byPath)).toEqual([
      [d.main, 'refs/heads/main', undefined, false],
      [d.nested, 'refs/heads/nested-branch', undefined, false],
      [d.sibling, 'refs/heads/sibling-branch', undefined, false],
      [d.detached, null, undefined, false],
      [d.locked, 'refs/heads/locked-branch', 'on the desk', false],
    ].sort(byPath));
  });

  it('removes each registration the manifest leaves out, and keeps its branch', async () => {
    const l = seedHere(made);
    const d = l.source;
    const branches = ['unused-branch', 'gone-branch'].map((b) => git(l.base, d.main, 'rev-parse', `refs/heads/${b}`));
    const { manifest } = await handed(l);
    const { git: g, asked } = asking();
    expect(await importGraphs(manifest, { git: g })).toEqual([]);
    expect(fs.readdirSync(path.join(d.main, '.git/worktrees')).sort()).toEqual(['detached', 'locked', 'nested', 'sibling']);
    expect(['unused-branch', 'gone-branch'].map((b) => git(l.base, d.main, 'rev-parse', `refs/heads/${b}`))).toEqual(branches);
    expect(rebuilds(asked)).toEqual([]);
  });

  it('finds the same graph the second time', async () => {
    const l = seedHere(made);
    const { manifest } = await handed(l);
    expect(await importGraphs(manifest)).toEqual([]);
    expect(await importGraphs(manifest)).toEqual([]);
  });

  it('names each real change the destination copy holds that the source did not', async () => {
    const l = seedHere(made);
    const { manifest } = await handed(l);
    expect(await importGraphs(manifest)).toEqual([]);
    const d = l.source;
    git(l.base, d.nested, 'add', 'untracked.txt');
    git(l.base, d.detached, 'switch', '-q', '-c', 'moved');
    git(l.base, d.main, 'worktree', 'unlock', d.locked);
    git(l.base, d.main, 'stash', 'drop', '-q');
    fs.appendFileSync(path.join(d.sibling, 'staged.txt'), 'more\n');
    const demo = manifest.git![0];
    const blockers = await validateGraph(demo);
    expect(blockers.every((b) => b.code === 'git_mismatch' && b.entity?.id === demo.id)).toBe(true);
    const said = blockers.map((b) => b.message).join('\n');
    expect(said).toContain(`${d.nested}: the staged entries differ from the source's`);
    expect(said).toContain(`${d.nested}: git status differs from the source's`);
    expect(said).toContain(`${d.detached}: git lists it on refs/heads/moved`);
    expect(said).toContain(`${d.locked}: git lists it on refs/heads/locked-branch at`);
    expect(said).toContain(`${path.join(d.main, '.git')}: the stash is not the one the source left (0 entries here, 1 there)`);
    expect(said).toContain(`${d.sibling}: git status differs from the source's`);
    expect(said).not.toContain(`${d.main}:`);
  });

  it('sets the case and Unicode rules git reads to the destination filesystem\'s, and leaves the rest of the config byte for byte', async () => {
    const l = seedHere(made);
    const s = l.source;
    for (const key of ['core.ignorecase', 'core.precomposeunicode']) git(l.base, s.main, 'config', key, 'true');
    const { manifest } = await handed(l);
    const configs = [path.join(s.main, '.git/config'), path.join(s.main, '.git/modules/sub/config')];
    const before = configs.map(read);
    // a case-sensitive filesystem where git probes no Unicode composition, as on Linux
    expect(await importGraphs(manifest, { probe: () => ({ ignoreCase: false }) })).toEqual([]);
    const main = read(configs[0]);
    expect(main).toBe(before[0].replace('\tignorecase = true', '\tignorecase = false').replace('\tprecomposeunicode = true', '\tprecomposeunicode = false'));
    expect(main).not.toBe(before[0]);

    // a Mac's own filesystem, as git init probes it there
    await importGraphs(manifest, { probe: () => ({ ignoreCase: true, precomposeUnicode: true }) });
    expect(configs.map(read)).toEqual(before);
  });

  it('leaves a config carried as a link, and what it leads to, as they came', async () => {
    const l = seedHere(made);
    const s = l.source;
    git(l.base, s.main, 'config', 'core.ignorecase', 'true');
    const { manifest } = await handed(l);
    const config = path.join(s.main, '.git/config');
    const outside = path.join(l.base, 'outside-config');
    fs.renameSync(config, outside);
    fs.symlinkSync(outside, config);
    const before = read(outside);
    await importGraphs(manifest, { probe: () => ({ ignoreCase: false }) });
    expect(fs.lstatSync(config).isSymbolicLink()).toBe(true);
    expect(read(outside)).toBe(before);
  });

  it('refuses a worktrees folder carried as a link, and leaves what it leads to as it was', async () => {
    const l = seedHere(made);
    const solo = path.join(l.source.work, 'solo');
    git(l.base, l.source.work, 'init', '-q', 'solo');
    fs.writeFileSync(path.join(solo, 'a.txt'), 'a\n');
    git(l.base, solo, 'add', 'a.txt');
    git(l.base, solo, 'commit', '-qm', 'a');
    const state = emptyState();
    state.characters.solo = char('solo', { cwd: solo });
    const { manifest } = await handed(l, state);
    const worktrees = path.join(solo, '.git/worktrees');
    const outside = path.join(l.base, 'outside-worktrees');
    fs.mkdirSync(path.join(outside, 'victim'), { recursive: true });
    fs.writeFileSync(path.join(outside, 'victim/data'), 'not the import\'s to remove\n');
    fs.symlinkSync(outside, worktrees);
    expect(await importGraphs(manifest)).toEqual([
      { code: 'worktree_unresolved', message: expect.stringContaining(worktrees), entity: { kind: 'git', id: manifest.git![0].id } },
    ]);
    expect(read(path.join(outside, 'victim/data'))).toBe('not the import\'s to remove\n');
  });

  it('turns a git that refuses into a blocker for its graph, and removes no registration', async () => {
    const l = seedHere(made);
    const { manifest } = await handed(l);
    const registrations = path.join(l.source.main, '.git/worktrees');
    const before = fs.readdirSync(registrations).sort();
    const refusing: GitRunner = async (args, cwd) => (args[0] === 'config' && args.includes('--get')
      ? { code: 128, stdout: '', stderr: 'fatal: bad config line 1\n' } : runGit(args, cwd));
    const blockers = await importGraphs(manifest, { git: refusing, probe: () => ({ ignoreCase: false }) });
    expect(blockers).toEqual(manifest.git!.map((g) => ({
      code: 'worktree_unresolved', message: `${path.join(g.commonDir, 'config')}: git config --get core.ignorecase failed: fatal: bad config line 1`, entity: { kind: 'git', id: g.id },
    })));
    expect(fs.readdirSync(registrations).sort()).toEqual(before);
  });

  it.skipIf(process.getuid?.() === 0)('turns a registrations folder it cannot read into a blocker for its graph', async () => {
    const l = seedHere(made);
    const { manifest } = await handed(l);
    const registrations = path.join(l.source.main, '.git/worktrees');
    fs.chmodSync(registrations, 0o000);
    try {
      expect(await importGraphs(manifest, { probe: () => ({ ignoreCase: false }) })).toContainEqual(
        { code: 'worktree_unresolved', message: expect.stringContaining('EACCES'), entity: { kind: 'git', id: manifest.git![0].id } },
      );
    } finally { fs.chmodSync(registrations, 0o755); }
  });

  it('keeps a worktree no character uses registered on the machine it stays on, through a handover away and back', async () => {
    const l = seedHere(made);
    const s = l.source;
    const before = { status: git(l.base, s.unused, 'status', '--porcelain=v2', '--branch'), head: git(l.base, s.unused, 'rev-parse', 'HEAD') };
    const { manifest: there } = await handed(l);
    expect(await importGraphs(there)).toEqual([]);

    // back again: the copy that returns never held the registration of the worktree that stayed on the Mac
    const back = await manifestOf(l);
    const trift = park(l, 'trift');
    unpark(l, 'mac');
    const [here] = graphsHere(back);
    const { kept, unproven } = await keptWorktrees(here);
    expect(unproven).toEqual([]);
    expect(kept).toEqual([{ name: 'unused', registration: path.join(s.main, '.git/worktrees/unused'), path: s.unused }]);
    mirror(l, back, trift, kept);
    expect(await importGraphs(back, { kept: { [here.id]: kept.map((k) => k.name) } })).toEqual([]);
    expect({ status: git(l.base, s.unused, 'status', '--porcelain=v2', '--branch'), head: git(l.base, s.unused, 'rev-parse', 'HEAD') }).toEqual(before);
    expect(git(l.base, s.main, 'worktree', 'list', '--porcelain')).toContain(`worktree ${s.unused}\n`);
  });

  /** The fixture with a commit only `unused-branch` reaches, handed over once; `there` runs on the other machine after, and the Mac takes its tree back. */
  async function withOwnCommit(there: (l: Layout) => void) {
    const l = seedHere(made);
    const s = l.source;
    fs.writeFileSync(path.join(s.unused, 'only-here.txt'), 'only here\n');
    git(l.base, s.unused, 'add', 'only-here.txt');
    git(l.base, s.unused, 'commit', '-qm', 'only on unused-branch');
    const { manifest: away } = await handed(l);
    expect(await importGraphs(away)).toEqual([]);
    there(l);
    const back = await manifestOf(l);
    const trift = park(l, 'trift');
    unpark(l, 'mac');
    return { l, back, trift, commit: git(l.base, s.unused, 'rev-parse', 'HEAD'), sourceCommon: parkedAt(l, trift, path.join(s.main, '.git')) };
  }

  it('leaves to the source a kept commit this machine cannot prove comes back, which the source reaches through the branch that moved on there', async () => {
    const { l, back, trift, commit, sourceCommon } = await withOwnCommit((x) => {
      // the branch the worktree stands on moved on where the fleet went, to a commit this machine has never seen
      const d = x.source.main;
      const child = git(x.base, d, 'commit-tree', '-p', 'unused-branch', '-m', 'moved on there', 'unused-branch^{tree}');
      git(x.base, d, 'update-ref', 'refs/heads/unused-branch', child);
    });
    const [here] = graphsHere(back);
    const { kept, unproven } = await keptWorktrees(here);
    expect(unproven).toEqual([{ graph: here.id, path: l.source.unused, commit }]);
    expect(await unreached(sourceCommon, [commit])).toEqual([]);
    mirror(l, back, trift, kept);
    expect(await importGraphs(back, { kept: { [here.id]: kept.map((k) => k.name) } })).toEqual([]);
    expect(git(l.base, l.source.unused, 'status', '--porcelain=v2', '--untracked-files=no')).toBe('');
  });

  it('names what the source truly cannot reach: a commit whose only branch it dropped, and one it never had', async () => {
    const { back, commit, sourceCommon } = await withOwnCommit((x) => { git(x.base, x.source.main, 'branch', '-D', 'unused-branch'); });
    const [here] = graphsHere(back);
    expect((await keptWorktrees(here)).unproven.map((u) => u.commit)).toEqual([commit]);
    const never = 'a'.repeat(40);
    expect(await unreached(sourceCommon, [commit, never])).toEqual([commit, never]);
  });

  it('takes a bare repository and the worktree beside it as they came', async () => {
    const l = seedHere(made);
    const s = l.source;
    const bare = path.join(s.work, 'tool.git');
    git(l.base, s.work, 'clone', '-q', '--bare', s.lib, bare);
    git(l.base, bare, 'worktree', 'add', '-q', path.join(s.work, 'tool'), '-b', 'feature');
    const state = crew(l);
    state.characters.tool = char('tool', { cwd: path.join(s.work, 'tool') });
    const { manifest } = await handed(l, state);
    expect(manifest.roots.find((r) => r.path === bare)).toMatchObject({ kind: 'gitdir' });
    expect(await importGraphs(manifest)).toEqual([]);
    expect(manifest.git!.map((g) => g.id)).toContain(graphId(bare));
    expect(read(path.join(s.work, 'tool/.git'))).toBe(`gitdir: ${path.join(bare, 'worktrees/tool')}\n`);
  });
});
