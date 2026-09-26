import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { FleetConfig, type GitCheckout, type GitGraph, type MachineId, type TransferManifestV1 } from '@archipelago/protocol';
import { discoverGit, graphId, readWorktrees } from '../../src/handover/git-graph.js';
import { graphsHere, keptWorktrees, repairGraph, repairGraphs, unreached, validateGraph, type RepairFs } from '../../src/handover/git-repair.js';
import { buildInventory, DEFAULT_EXCLUDES } from '../../src/handover/inventory.js';
import { buildManifest } from '../../src/handover/manifest.js';
import { runGit, type GitResult, type GitRunner } from '../../src/links/git.js';
import { char, crew, git, hasGit, layout, park, parkedAt, SEED, seedHere, unpark, type Layout } from './git-fixture.js';

const made: string[] = [];
afterEach(() => { for (const d of made.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });

const MAC = '9b4d0b1c-2d3e-4f50-8617-9a0b1c2d3e4f' as MachineId;
const TRIFT = '42aa0b1c-2d3e-4f50-8617-9a0b1c2d3e4f' as MachineId;
const FLEET = FleetConfig.parse({ id: '5e1f0b1c-2d3e-4f50-8617-9a0b1c2d3e4f' });
const read = (file: string): string => fs.readFileSync(file, 'utf8');

type Repairable = Pick<TransferManifestV1, 'roots' | 'git'>;

const checkout = (p: string, gitDir: string): GitCheckout =>
  ({ path: p, gitDir, head: 'a'.repeat(40), branch: 'refs/heads/main', status: [], index: 'b'.repeat(64), characters: [] });

// the destination copy of a repository from /Users/me: two registrations, of which the manifest carries one
function copied() {
  const base = fs.realpathSync(fs.mkdtempSync('/tmp/archi-git-'));
  made.push(base);
  const common = path.join(base, 'app/.git');
  const wt = path.join(base, 'wt');
  for (const id of ['wt', 'old']) {
    fs.mkdirSync(path.join(common, 'worktrees', id), { recursive: true });
    fs.writeFileSync(path.join(common, 'worktrees', id, 'gitdir'), `/Users/me/${id}/.git\n`);
  }
  fs.mkdirSync(wt);
  fs.writeFileSync(path.join(wt, '.git'), 'gitdir: /Users/me/app/.git/worktrees/wt\n');
  const graph: GitGraph = {
    id: 'g_app', commonDir: '/Users/me/app/.git', main: checkout('/Users/me/app', '/Users/me/app/.git'),
    worktrees: [checkout('/Users/me/wt', '/Users/me/app/.git/worktrees/wt')],
    unused: [{ path: '/Users/me/old', head: null, branch: 'refs/heads/old', prunable: false }], stash: [],
  };
  const map = (p: string): string => path.join(base, path.relative('/Users/me', p));
  return { base, common, wt, graph, map };
}

// a git that answers from a table keyed by cwd and argv, and remembers what it was asked
function fakeGit(answers: Record<string, Partial<GitResult>>, seen: string[] = []): GitRunner {
  return async (args, cwd) => {
    const key = `${cwd}: ${args.join(' ')}`;
    seen.push(key);
    const hit = answers[key];
    return hit ? { code: 0, stdout: '', stderr: '', ...hit } : { code: 1, stdout: '', stderr: '' };
  };
}

describe('repairGraph, step by step', () => {
  const opens = (common: string): Record<string, Partial<GitResult>> => ({ [`${common}: rev-parse --path-format=absolute --git-common-dir`]: { stdout: `${common}\n` } });

  it('touches nothing in a copy the destination git cannot open', async () => {
    const c = copied();
    const git = fakeGit({ [`${c.common}: rev-parse --path-format=absolute --git-common-dir`]: { code: 128, stderr: 'fatal: unknown repository extension found:\n\trelativeworktrees\n' } });
    const r = await repairGraph(c.graph, c.map, { git });
    expect(r).toEqual({ blockers: [{
      code: 'worktree_unresolved',
      message: `${c.common}: git rev-parse --path-format=absolute --git-common-dir failed: fatal: unknown repository extension found: relativeworktrees`,
      entity: { kind: 'git', id: 'g_app' },
    }] });
    expect(fs.readdirSync(path.join(c.common, 'worktrees')).sort()).toEqual(['old', 'wt']);
  });

  it('touches nothing when a carried worktree or its registration did not arrive', async () => {
    const c = copied();
    fs.rmSync(path.join(c.common, 'worktrees/wt'), { recursive: true });
    const r = await repairGraph(c.graph, c.map, { git: fakeGit(opens(c.common)) });
    expect(r.blockers).toEqual([{ code: 'worktree_unresolved', message: expect.stringContaining(path.join(c.common, 'worktrees/wt')), entity: { kind: 'git', id: 'g_app' } }]);
    expect(fs.readdirSync(path.join(c.common, 'worktrees'))).toEqual(['old']);
    expect(read(path.join(c.wt, '.git'))).toBe('gitdir: /Users/me/app/.git/worktrees/wt\n');
  });

  it('touches nothing when a carried gitfile or registration is a link, which a write would follow out of the copy', async () => {
    for (const which of ['gitfile', 'gitdir'] as const) {
      const c = copied();
      const outside = path.join(c.base, 'outside.txt');
      fs.writeFileSync(outside, 'not the repair\'s to write\n');
      const at = which === 'gitfile' ? path.join(c.wt, '.git') : path.join(c.common, 'worktrees/wt/gitdir');
      fs.rmSync(at);
      fs.symlinkSync(outside, at);
      const r = await repairGraph(c.graph, c.map, { git: fakeGit({ ...opens(c.common), [`${path.join(c.base, 'app')}: config --type=bool --get worktree.useRelativePaths`]: {} }) });
      expect(r.blockers, which).toEqual([{ code: 'worktree_unresolved', message: expect.stringContaining(at), entity: { kind: 'git', id: 'g_app' } }]);
      expect(read(outside)).toBe('not the repair\'s to write\n');
      expect(fs.readdirSync(path.join(c.common, 'worktrees')).sort()).toEqual(['old', 'wt']);
    }
  });

  it('drops every registration the manifest leaves out before repair runs, then links each carried worktree both ways', async () => {
    const c = copied();
    const main = path.dirname(c.common);
    let registered: string[] = [];
    const answers = opens(c.common);
    const git: GitRunner = async (args, cwd) => {
      if (args[1] === 'repair') registered = fs.readdirSync(path.join(c.common, 'worktrees'));
      return fakeGit(answers)(args, cwd);
    };
    answers[`${main}: worktree repair ${c.wt}`] = {};
    const r = await repairGraph(c.graph, c.map, { git });
    expect(r).toEqual({ repair: { id: 'g_app', pruned: ['old'], rewritten: [c.wt], repairReport: '' }, blockers: [] });
    expect(registered).toEqual(['wt']);
    expect(read(path.join(c.wt, '.git'))).toBe(`gitdir: ${path.join(c.common, 'worktrees/wt')}\n`);
    expect(read(path.join(c.common, 'worktrees/wt/gitdir'))).toBe(`${path.join(c.wt, '.git')}\n`);
  });

  it('links them by relative paths where the destination git keeps worktree paths relative', async () => {
    const c = copied();
    const main = path.dirname(c.common);
    const git = fakeGit({ ...opens(c.common), [`${main}: config --type=bool --get worktree.useRelativePaths`]: { stdout: 'true\n' }, [`${main}: worktree repair ${c.wt}`]: {} });
    expect((await repairGraph(c.graph, c.map, { git })).blockers).toEqual([]);
    expect(read(path.join(c.wt, '.git'))).toBe('gitdir: ../app/.git/worktrees/wt\n');
    expect(read(path.join(c.common, 'worktrees/wt/gitdir'))).toBe('../../../../wt/.git\n');
  });

  it('blocks when repair still finds something to fix, and when git refuses to repair', async () => {
    const c = copied();
    const main = path.dirname(c.common);
    const said = 'repair: gitdir incorrect: /x/.git/worktrees/wt/gitdir';
    const unfixed = fakeGit({ ...opens(c.common), [`${main}: worktree repair ${c.wt}`]: { stderr: `${said}\n` } });
    expect((await repairGraph(c.graph, c.map, { git: unfixed })).blockers).toEqual([
      { code: 'git_mismatch', message: `${c.common}: git worktree repair still found links to fix after they were rewritten: ${said}`, entity: { kind: 'git', id: 'g_app' } },
    ]);
    const refused = fakeGit({ ...opens(c.common), [`${main}: worktree repair ${c.wt}`]: { code: 128, stderr: 'fatal: not a git repository\n' } });
    expect((await repairGraph(c.graph, c.map, { git: refused })).blockers).toEqual([
      { code: 'worktree_unresolved', message: `${main}: git worktree repair ${c.wt} failed: fatal: not a git repository`, entity: { kind: 'git', id: 'g_app' } },
    ]);
  });
});

describe('repairGraphs', () => {
  it('blocks every Git root of the manifest that no graph describes', async () => {
    const root = (id: string, kind: 'repo' | 'worktree' | 'gitdir' | 'cwd', p: string) => ({ id, kind, entry: 'dir' as const, path: p, files: [] });
    const manifest: Repairable = {
      roots: [root('r_app', 'repo', '/Users/me/app'), root('r_wt', 'worktree', '/Users/me/wt'), root('r_x', 'cwd', '/Users/me/x')],
      git: [{ id: 'g_app', commonDir: '/Users/me/app/.git', main: checkout('/Users/me/app', '/Users/me/app/.git'), worktrees: [], unused: [], stash: [] }],
    };
    const r = await repairGraphs(manifest, { git: fakeGit({}) });
    expect(r.blockers).toContainEqual({ code: 'worktree_unresolved', message: '/Users/me/wt: no Git graph in the manifest describes it', entity: { kind: 'root', id: 'r_wt' } });
    expect(r.blockers.filter((b) => b.entity?.kind === 'root')).toHaveLength(1);
  });
});

// what a handover moves: every carried root of the manifest, from the source machine's tree parked at `from`, to the same path here
function transfer(l: Layout, manifest: TransferManifestV1, from: string): void {
  for (const r of manifest.roots.filter((x) => !x.foldedInto)) fs.cpSync(parkedAt(l, from, r.path), r.path, { recursive: true, verbatimSymlinks: true });
}

/** What rsync --delete leaves of each carried root: the parked source's copy, and each kept registration as it was. */
function mirror(l: Layout, manifest: TransferManifestV1, from: string, kept: { registration: string }[]): void {
  const aside = fs.mkdtempSync('/tmp/archi-kept-');
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
  const at = { home: l.home, fleetHome: path.join(l.home, '.archipelago') };
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

const real = hasGit ? describe : describe.skip;

// each seeds a real fixture with dozens of git commands, which a loaded machine takes its time over
real(`a real repository graph moved to another machine with the same home${hasGit ? '' : ' (skipped: git is not on PATH)'}`, { timeout: 180_000 }, () => {
  it('arrives with every used worktree, its HEAD, branch, lock, status, staged entries and stash, and nothing unused registered', async () => {
    const l = seedHere(made);
    const { manifest } = await handed(l);
    const d = l.source;
    const r = await repairGraphs(manifest);
    expect(r.blockers).toEqual([]);
    expect(r.repairs).toEqual([
      { id: graphId(path.join(d.main, '.git')), pruned: ['gone', 'unused'], rewritten: [d.nested, d.detached, d.locked, d.sibling], repairReport: '' },
      { id: graphId(path.join(d.main, '.git/modules/sub')), pruned: [], rewritten: [d.sub], repairReport: '' },
    ]);
    const byPath = (a: unknown[], b: unknown[]): number => String(a[0]).localeCompare(String(b[0]));
    const list = (await readWorktrees(d.main, runGit)).map((e) => [e.path, e.branch, e.locked, e.prunable]);
    expect(list.sort(byPath)).toEqual([
      [d.main, 'refs/heads/main', undefined, false],
      [d.nested, 'refs/heads/nested-branch', undefined, false],
      [d.sibling, 'refs/heads/sibling-branch', undefined, false],
      [d.detached, null, undefined, false],
      [d.locked, 'refs/heads/locked-branch', 'on the desk', false],
    ].sort(byPath));
    // the branch of a registration left behind still resolves, and the submodule kept its relative link
    expect(git(l.base, d.main, 'rev-parse', 'refs/heads/unused-branch')).toBe(manifest.git![0].unused[1].head);
    expect(read(path.join(d.sub, '.git')).trim()).toBe('gitdir: ../.git/modules/sub');
  });

  it('finds nothing left to do the second time', async () => {
    const l = seedHere(made);
    const { manifest } = await handed(l);
    await repairGraphs(manifest);
    const again = await repairGraphs(manifest);
    expect(again.blockers).toEqual([]);
    expect(again.repairs.map((x) => [x.pruned, x.repairReport])).toEqual([[[], ''], [[], '']]);
  });

  it('names each real change the destination copy holds that the source did not', async () => {
    const l = seedHere(made);
    const { manifest } = await handed(l);
    expect((await repairGraphs(manifest)).blockers).toEqual([]);
    const d = l.source;
    git(l.base, d.nested, 'add', 'untracked.txt');
    git(l.base, d.detached, 'switch', '-q', '-c', 'moved');
    git(l.base, d.main, 'worktree', 'unlock', d.locked);
    git(l.base, d.main, 'stash', 'drop', '-q');
    fs.appendFileSync(path.join(d.sibling, 'staged.txt'), 'more\n');
    const demo = manifest.git![0];
    const blockers = await validateGraph(demo, (p) => p);
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
    expect((await repairGraphs(manifest, { probe: () => ({ ignoreCase: false }) })).blockers).toEqual([]);
    const main = read(configs[0]);
    expect(main).toBe(before[0].replace('\tignorecase = true', '\tignorecase = false').replace('\tprecomposeunicode = true', '\tprecomposeunicode = false'));
    expect(main).not.toBe(before[0]);

    // a Mac's own filesystem, as git init probes it there
    await repairGraphs(manifest, { probe: () => ({ ignoreCase: true, precomposeUnicode: true }) });
    expect(configs.map(read)).toEqual(before);
  });

  it('keeps a worktree no character uses registered on the machine it stays on, through a handover away and back', async () => {
    const l = seedHere(made);
    const s = l.source;
    const before = { status: git(l.base, s.unused, 'status', '--porcelain=v2', '--branch'), head: git(l.base, s.unused, 'rev-parse', 'HEAD') };
    const { manifest: there } = await handed(l);
    expect((await repairGraphs(there)).blockers).toEqual([]);

    // back again: the copy that returns never held the registration of the worktree that stayed on the Mac
    const back = await manifestOf(l);
    const trift = park(l, 'trift');
    unpark(l, 'mac');
    const [here] = graphsHere(back);
    const { kept, unproven } = await keptWorktrees(here);
    expect(unproven).toEqual([]);
    expect(kept).toEqual([{ name: 'unused', registration: path.join(s.main, '.git/worktrees/unused'), path: s.unused }]);
    mirror(l, back, trift, kept);
    expect((await repairGraphs(back, { kept: { [here.id]: kept.map((k) => k.name) } })).blockers).toEqual([]);
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
    expect((await repairGraphs(away)).blockers).toEqual([]);
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
    expect((await repairGraphs(back, { kept: { [here.id]: kept.map((k) => k.name) } })).blockers).toEqual([]);
    expect(git(l.base, l.source.unused, 'status', '--porcelain=v2', '--untracked-files=no')).toBe('');
  });

  it('names what the source truly cannot reach: a commit whose only branch it dropped, and one it never had', async () => {
    const { back, commit, sourceCommon } = await withOwnCommit((x) => { git(x.base, x.source.main, 'branch', '-D', 'unused-branch'); });
    const [here] = graphsHere(back);
    expect((await keptWorktrees(here)).unproven.map((u) => u.commit)).toEqual([commit]);
    const never = 'a'.repeat(40);
    expect(await unreached(sourceCommon, [commit, never])).toEqual([commit, never]);
  });

  it('rebuilds a bare repository and the worktree beside it', async () => {
    const l = seedHere(made);
    const s = l.source;
    const bare = path.join(s.work, 'tool.git');
    git(l.base, s.work, 'clone', '-q', '--bare', s.lib, bare);
    git(l.base, bare, 'worktree', 'add', '-q', path.join(s.work, 'tool'), '-b', 'feature');
    const state = crew(l);
    state.characters.tool = char('tool', { cwd: path.join(s.work, 'tool') });
    const { manifest } = await handed(l, state);
    expect(manifest.roots.find((r) => r.path === bare)).toMatchObject({ kind: 'gitdir' });
    const r = await repairGraphs(manifest);
    expect(r.blockers).toEqual([]);
    expect(r.repairs.find((x) => x.id === graphId(bare))).toEqual({ id: graphId(bare), pruned: [], rewritten: [path.join(s.work, 'tool')], repairReport: '' });
    expect(read(path.join(s.work, 'tool/.git'))).toBe(`gitdir: ${path.join(bare, 'worktrees/tool')}\n`);
  });
});

// The same fixture and the same code on another machine's git, reached over ssh: set ARCHI_TEST_SSH=<destination>.
// It works in a fresh `mktemp -d` under /tmp there, removed afterwards, and reads nothing of that machine's own setup.
const REMOTE = process.env.ARCHI_TEST_SSH;
const CONTROL = `/tmp/archi-cm-${process.pid}`;
const SSH = ['-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', '-o', 'UpdateHostKeys=no', '-o', 'ControlMaster=auto', '-o', `ControlPath=${CONTROL}`, '-o', 'ControlPersist=120'];
const q = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`;

function remote(argv: string[], input?: string): { code: number; stdout: string; stderr: string } {
  const r = spawnSync('ssh', [...SSH, REMOTE!, argv.map(q).join(' ')], { input: input ?? '', encoding: 'utf8' });
  return { code: r.status ?? -1, stdout: r.stdout, stderr: r.stderr };
}

function remoteSide(base: string) {
  const env = ['env', 'LC_ALL=C', 'GIT_OPTIONAL_LOCKS=0', `GIT_CONFIG_GLOBAL=${base}/gitconfig`, 'GIT_CONFIG_NOSYSTEM=1'];
  const git: GitRunner = (args, cwd) => new Promise((resolve) => {
    const child = spawn('ssh', [...SSH, REMOTE!, [...env, 'git', '-C', cwd, ...args].map(q).join(' ')], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c: Buffer) => { stdout += c.toString(); });
    child.stderr.on('data', (c: Buffer) => { stderr += c.toString(); });
    child.on('close', (code) => resolve({ code: code ?? -1, stdout, stderr }));
  });
  const must = (argv: string[], input?: string): string => {
    const r = remote(argv, input);
    if (r.code !== 0) throw Object.assign(new Error(`${argv.join(' ')}: ${r.stderr.trim()}`), { code: 'ENOENT' });
    return r.stdout;
  };
  const fs: RepairFs = {
    realpath: (p) => must(['realpath', '-e', p]).replace(/\n$/, ''),
    readFile: (p) => must(['cat', p]),
    writeFile: (p, text) => { must(['sh', '-c', 'cat > "$1"', 'sh', p], text); },
    readdir: (p) => must(['ls', '-A', p]).split('\n').filter(Boolean),
    rm: (p) => { must(['rm', '-rf', p]); },
    isFile: (p) => remote(['sh', '-c', 'test -f "$1" && test ! -L "$1"', 'sh', p]).code === 0,
  };
  return { git, fs, exists: (p: string) => remote(['test', '-e', p]).code === 0 };
}

describe.skipIf(!REMOTE)(`the same graph on ${REMOTE ?? 'a remote machine'}'s git${REMOTE ? '' : ' (set ARCHI_TEST_SSH=<destination> to run)'}`, { timeout: 600_000 }, () => {
  let base: string | undefined;
  afterAll(() => {
    if (base) remote(['rm', '-rf', base]);
    spawnSync('ssh', ['-o', `ControlPath=${CONTROL}`, '-O', 'exit', REMOTE!], { stdio: 'ignore' });
  });

  it('discovers it, and rebuilds it at the same paths after the source is gone', async () => {
    console.log(`remote git: ${remote(['git', '--version']).stdout.trim()}`);
    base = remote(['sh', '-c', 'cd "$(mktemp -d /tmp/archi-git-XXXXXX)" && pwd -P']).stdout.trim();
    expect(base).toMatch(/^\/tmp\/archi-git-/);
    const seeded = remote(['sh', '-s', '--', base], SEED);
    expect(seeded.code, seeded.stderr).toBe(0);
    const l = layout(base);
    const side = remoteSide(base);
    const discovery = await discoverGit(crew(l), { excludes: DEFAULT_EXCLUDES, git: side.git, exists: side.exists });
    expect(discovery.blockers).toEqual([]);
    expect(discovery.graphs.map((g) => [g.commonDir, g.main?.path, g.worktrees.map((w) => [w.path, w.branch, w.locked]), g.unused.map((u) => [u.path, u.prunable]), g.stash.length])).toEqual([
      [path.join(l.source.main, '.git'), l.source.main, [
        [l.source.nested, 'refs/heads/nested-branch', undefined],
        [l.source.detached, null, undefined],
        [l.source.locked, 'refs/heads/locked-branch', 'on the desk'],
        [l.source.sibling, 'refs/heads/sibling-branch', undefined],
      ], [[l.source.gone, true], [l.source.unused, false]], 1],
      [path.join(l.source.main, '.git/modules/sub'), l.source.sub, [], [], 0],
    ]);
    const parked = path.join(base, 'parked-source');
    expect(remote(['mv', l.home, parked]).code).toBe(0);
    for (const at of ['main', 'sibling', 'detached', 'locked'] as const) {
      expect(remote(['mkdir', '-p', path.dirname(l.source[at])]).code).toBe(0);
      expect(remote(['cp', '-a', parkedAt(l, parked, l.source[at]), l.source[at]]).code).toBe(0);
    }
    expect(remote(['rm', '-rf', parked]).code).toBe(0);
    const r = await repairGraphs({ roots: [], git: discovery.graphs }, { git: side.git, fs: side.fs });
    expect(r.blockers).toEqual([]);
    expect(r.repairs.map((x) => [x.pruned, x.repairReport])).toEqual([[['gone', 'unused'], ''], [[], '']]);
  });
});
