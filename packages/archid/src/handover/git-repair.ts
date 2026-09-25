import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { Blocker, GitGraph, HandoverEntity, KeptCommit, ReceivedGraph, TransferManifestV1 } from '@archipelago/protocol';
import { DIRS_ARGS, parseDirs, runGit, type GitRunner } from '../links/git.js';
import { GitFailure, listedMain, must, readCheckout, readStash, readWorktrees, said, type WorktreeEntry } from './git-graph.js';
import { byCodeUnit, sha256Hex } from './hash.js';
import { holdingRoot, mapPortablePath, PathRootError } from './portable-path.js';

/** The filesystem calls a repair makes, so a test can make any of them fail, or run them on another machine. */
export type RepairFs = {
  realpath(p: string): string;
  readFile(p: string): string;
  writeFile(p: string, text: string): void;
  readdir(p: string): string[];
  rm(p: string): void;
  isFile(p: string): boolean;
};

export const realRepairFs: RepairFs = {
  realpath: (p) => fs.realpathSync.native(p),
  readFile: (p) => fs.readFileSync(p, 'utf8'),
  writeFile: (p, text) => fs.writeFileSync(p, text),
  readdir: (p) => fs.readdirSync(p),
  rm: (p) => fs.rmSync(p, { recursive: true, force: true }),
  isFile: (p) => { try { return fs.lstatSync(p).isFile(); } catch { return false; } },
};

/** What `git init` probes of the filesystem a Git directory sits on; `precomposeUnicode` only where git probes it, on macOS. */
export type FsRules = { ignoreCase: boolean; precomposeUnicode?: boolean };

/** Reads the rules as `git init` would in `dir`: a config found by another case, and on macOS a name found in its other Unicode form. */
export function probeFsRules(dir: string, platform: NodeJS.Platform = process.platform): FsRules {
  const ignoreCase = fs.existsSync(path.join(dir, 'CoNfIg'));
  if (platform !== 'darwin') return { ignoreCase };
  const mark = `.archi-probe-${process.pid}-${crypto.randomBytes(4).toString('hex')}-`;
  const composed = path.join(dir, `${mark}\u00e4`);
  fs.writeFileSync(composed, '', { flag: 'wx', mode: 0o600 });
  try {
    return { ignoreCase, precomposeUnicode: fs.existsSync(path.join(dir, `${mark}a\u0308`)) };
  } finally {
    fs.rmSync(composed, { force: true });
  }
}

export type RepairDeps = { git?: GitRunner; fs?: Partial<RepairFs>; probe?: (dir: string) => FsRules };

/** A registration under a carried common directory that stays with this machine: one the manifest does not carry, whose worktree is here. */
export type KeptWorktree = { name: string; registration: string; path: string };

/** Each graph a manifest carries, as the machine it goes to reads it. */
export function graphsHere(m: Pick<TransferManifestV1, 'sourceRoots' | 'destinationRoots' | 'git'>): ReceivedGraph[] {
  const map = mapThroughRoots(m);
  return (m.git ?? []).flatMap((g): ReceivedGraph[] => {
    let commonDir: string;
    try { commonDir = map(g.commonDir); } catch { return []; }
    const checkouts = [...(g.main ? [g.main] : []), ...g.worktrees];
    const heads = checkouts.flatMap((c) => (c.head ? [c.head] : []));
    return [{ id: g.id, commonDir, carried: g.worktrees.map((w) => path.basename(w.gitDir)), tips: [...new Set([...(g.tips ?? []), ...heads, ...g.stash])] }];
  });
}

// the command line holds this many commits at once, well under any system's limit
const TIPS_AT_ONCE = 500;

/** Whether one of `tips` reaches `commit`, as far as this machine's own copy of the objects can tell. */
async function reaches(tips: readonly string[], commit: string, at: string, git: GitRunner): Promise<boolean> {
  if (tips.includes(commit)) return true;
  for (let i = 0; i < tips.length; i += TIPS_AT_ONCE) {
    const r = await git(['rev-list', '--ignore-missing', '-n', '1', commit, '--not', ...tips.slice(i, i + TIPS_AT_ONCE), '--'], at);
    if (r.code === 0 && !r.stdout.trim()) return true;
  }
  return false;
}

/**
 * The registrations of a graph this machine keeps through a handover: each one the manifest does not carry whose
 * worktree is here. A kept HEAD commit that none of the source's tips reaches, as far as this machine's own objects
 * can tell, is unproven: the tips it does not know may reach it, and only the source can say.
 */
export async function keptWorktrees(g: ReceivedGraph, deps: RepairDeps & { exists?: (p: string) => boolean } = {}): Promise<{ kept: KeptWorktree[]; unproven: KeptCommit[] }> {
  const git = deps.git ?? runGit;
  const rfs = { ...realRepairFs, ...deps.fs };
  const exists = deps.exists ?? fs.existsSync;
  const registrations = path.join(g.commonDir, 'worktrees');
  let ids: string[] = [];
  try { ids = rfs.readdir(registrations); } catch { return { kept: [], unproven: [] }; }
  const kept: KeptWorktree[] = [];
  const unproven: KeptCommit[] = [];
  for (const name of ids.filter((id) => !g.carried.includes(id)).sort(byCodeUnit)) {
    const registration = path.join(registrations, name);
    let gitfile: string;
    try { gitfile = rfs.readFile(path.join(registration, 'gitdir')).trim(); } catch { continue; }
    const at = path.dirname(path.resolve(registration, gitfile));
    if (!gitfile || !exists(at)) continue;
    kept.push({ name, registration, path: at });
    const head = await git(['rev-parse', '--verify', '-q', 'HEAD^{commit}'], at);
    const commit = head.stdout.trim();
    if (head.code !== 0 || !commit || await reaches(g.tips, commit, at, git)) continue;
    unproven.push({ graph: g.id, path: at, commit });
  }
  return { kept, unproven };
}

/**
 * On the source: which of `commits` no ref of the repository at `commonDir` reaches, one it does not hold at all
 * included. What a ref reaches is what the copy it sends holds.
 */
export async function unreached(commonDir: string, commits: readonly string[], git: GitRunner = runGit): Promise<string[]> {
  const out: string[] = [];
  for (const commit of commits) {
    const r = await git(['rev-list', '-n', '1', commit, '--not', '--all', '--'], commonDir);
    if (r.code !== 0 || r.stdout.trim()) out.push(commit);
  }
  return out;
}

/**
 * Sets the config keys `git init` probes to what it would probe here, as a clone made here would hold them, and
 * leaves every other byte of the config as it came. A key init would not write is left out where it is absent.
 */
async function adaptRules(common: string, rules: FsRules, git: GitRunner): Promise<void> {
  const config = path.join(common, 'config');
  const keys: [string, boolean, boolean][] = [
    ['core.ignorecase', rules.ignoreCase, rules.ignoreCase],
    ['core.precomposeunicode', rules.precomposeUnicode ?? false, rules.precomposeUnicode !== undefined],
  ];
  for (const [key, value, written] of keys) {
    const r = await git(['config', '--file', config, '--type=bool', '--get', key], common);
    if (r.code !== 0 && r.code !== 1) throw new GitFailure(`${config}: git config --get ${key} failed: ${said(r.stderr) || `exit ${r.code}`}`);
    const held = r.code === 0 ? r.stdout.trim() === 'true' : undefined;
    if (held === value || (held === undefined && !written)) continue;
    await must(git, ['config', '--file', config, key, String(value)], common);
  }
}

/** What rebuilding one graph did: the registrations it dropped, the checkouts it relinked, and what repair still fixed. */
export type GraphRepair = { id: string; pruned: string[]; rewritten: string[]; repairReport: string };

/** Where a source path lands on the destination, through the manifest's named path roots. */
export function mapThroughRoots(m: Pick<TransferManifestV1, 'sourceRoots' | 'destinationRoots'>): (p: string) => string {
  return (p) => {
    const portable = holdingRoot(p, m.sourceRoots);
    if (!portable) throw new PathRootError(`no path root holds ${p}`);
    return mapPortablePath(portable, m.destinationRoots);
  };
}

// a refusal that leaves a graph unrepaired, as against a bug
const refusal = (e: unknown): e is Error => e instanceof GitFailure || e instanceof PathRootError || typeof (e as NodeJS.ErrnoException).code === 'string';

const unresolved = (e: Error, entity: HandoverEntity): Blocker => ({ code: 'worktree_unresolved', message: e.message, entity });

// a link as git writes it: relative to the folder the link sits in, or absolute
const link = (from: string, to: string, relative: boolean): string => (relative ? path.relative(from, to) : to);

/**
 * Rebuilds one copied graph on the destination in the order that leaves a still-reachable source alone:
 * every registration the manifest does not carry goes before git can follow it back; each carried worktree
 * and its registration are pointed at each other; then `git worktree repair` with the mapped paths must
 * find nothing left to fix. Nothing is changed until every carried piece is found where it belongs.
 */
export async function repairGraph(graph: GitGraph, map: (p: string) => string, deps: RepairDeps & { kept?: readonly string[] } = {}): Promise<{ repair?: GraphRepair; blockers: Blocker[] }> {
  const git = deps.git ?? runGit;
  const rfs = { ...realRepairFs, ...deps.fs };
  const entity: HandoverEntity = { kind: 'git', id: graph.id };
  try {
    const common = rfs.realpath(map(graph.commonDir));
    const main = graph.main && rfs.realpath(map(graph.main.path));
    const anchor = main ?? common;
    const found = (await must(git, ['rev-parse', '--path-format=absolute', '--git-common-dir'], common)).replace(/\n$/, '');
    if (found !== common) throw new GitFailure(`${common}: git reads its common directory as ${found}`);
    const registrations = path.join(common, 'worktrees');
    const carried = graph.worktrees.map((w) => {
      const registration = path.join(registrations, path.basename(w.gitDir));
      return { at: rfs.realpath(map(w.path)), registration: rfs.realpath(registration) };
    });

    // a gitfile or registration carried as a link would be written through to wherever it leads
    for (const f of carried.flatMap((c) => [path.join(c.at, '.git'), path.join(c.registration, 'gitdir')])) {
      if (!rfs.isFile(f)) throw new GitFailure(`${f} is not a regular file, so the repair will not write it`);
    }

    if (rfs.isFile(path.join(common, 'config'))) await adaptRules(common, (deps.probe ?? probeFsRules)(common), git);

    // a registration this machine keeps belongs to a worktree that stays here
    const keep = new Set([...carried.map((c) => path.basename(c.registration)), ...(deps.kept ?? [])]);
    let ids: string[] = [];
    try { ids = rfs.readdir(registrations); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
    const pruned = ids.filter((id) => !keep.has(id)).sort(byCodeUnit);
    for (const id of pruned) rfs.rm(path.join(registrations, id));

    const relative = (await git(['config', '--type=bool', '--get', 'worktree.useRelativePaths'], anchor)).stdout.trim() === 'true';
    for (const { at, registration } of carried) {
      rfs.writeFile(path.join(at, '.git'), `gitdir: ${link(at, registration, relative)}\n`);
      rfs.writeFile(path.join(registration, 'gitdir'), `${link(registration, path.join(at, '.git'), relative)}\n`);
    }
    const rewritten = carried.map((c) => c.at);
    // a main checkout whose git dir lives elsewhere, as a submodule's does, keeps the form its link had
    if (main && rfs.isFile(path.join(main, '.git'))) {
      const wasRelative = !/^gitdir: \//.test(rfs.readFile(path.join(main, '.git')));
      rfs.writeFile(path.join(main, '.git'), `gitdir: ${link(main, common, wasRelative)}\n`);
      rewritten.push(main);
    }

    let repairReport = '';
    if (carried.length) {
      const args = ['worktree', 'repair', ...carried.map((c) => c.at)];
      const r = await git(args, anchor);
      if (r.code !== 0) throw new GitFailure(`${anchor}: git ${args.join(' ')} failed: ${said(r.stderr) || `exit ${r.code}`}`);
      repairReport = said(`${r.stdout}\n${r.stderr}`);
    }
    const repair = { id: graph.id, pruned, rewritten, repairReport };
    if (!repairReport) return { repair, blockers: [] };
    return { repair, blockers: [{ code: 'git_mismatch', message: `${common}: git worktree repair still found links to fix after they were rewritten: ${repairReport}`, entity }] };
  } catch (e) {
    if (!refusal(e)) throw e;
    return { blockers: [unresolved(e, entity)] };
  }
}

const short = (head: string | null): string => head?.slice(0, 12) ?? 'no commit';

// the registration a worktree's own gitfile names, as git reads it
function registrationOf(rfs: RepairFs, worktree: string): string {
  try {
    const link = /^gitdir: (.*)$/m.exec(rfs.readFile(path.join(worktree, '.git')))?.[1];
    return link ? path.resolve(worktree, link) : '';
  } catch { return ''; }
}

function described(e: WorktreeEntry): string {
  const at = e.bare ? 'bare' : e.branch ? `on ${e.branch} at ${short(e.head)}` : `detached at ${short(e.head)}`;
  return `${at}${e.locked === undefined ? '' : e.locked ? `, locked: ${e.locked}` : ', locked'}${e.prunable ? ', missing' : ''}`;
}

/**
 * Proves a rebuilt graph is the one the source left: each checkout resolves to its own git dirs and reads
 * the same status and staged entries, git lists exactly the carried worktrees with their HEAD, branch and
 * lock, and the stash holds the same entries.
 */
export async function validateGraph(graph: GitGraph, map: (p: string) => string, deps: RepairDeps & { kept?: readonly string[] } = {}): Promise<Blocker[]> {
  const git = deps.git ?? runGit;
  const rfs = { ...realRepairFs, ...deps.fs };
  const entity: HandoverEntity = { kind: 'git', id: graph.id };
  const differs: string[] = [];
  try {
    const common = rfs.realpath(map(graph.commonDir));
    const checkouts = [...(graph.main ? [graph.main] : []), ...graph.worktrees]
      .map((c) => ({ c, at: rfs.realpath(map(c.path)), gitDir: rfs.realpath(map(c.gitDir)) }));
    for (const { c, at, gitDir } of checkouts) {
      const dirs = parseDirs(await must(git, DIRS_ARGS, at));
      if (dirs.root !== at || dirs.commonDir !== common || dirs.gitDir !== gitDir) {
        differs.push(`${at}: git reads it as the checkout ${dirs.root} of ${dirs.commonDir} through ${dirs.gitDir}`);
      }
      const { status, staged } = await readCheckout(at, git);
      if (sha256Hex(staged) !== c.index) differs.push(`${at}: the staged entries differ from the source's`);
      const odd = status.find((s) => !c.status.includes(s)) ?? c.status.find((s) => !status.includes(s));
      if (odd !== undefined || status.length !== c.status.length) differs.push(`${at}: git status differs from the source's${odd === undefined ? '' : ` at ${odd}`}`);
    }

    const expected = new Map<string, WorktreeEntry>();
    const main = listedMain(common);
    expected.set(main, { path: main, head: graph.main?.head ?? null, branch: graph.main?.branch ?? null, bare: !graph.main, prunable: false });
    for (const { c, at } of checkouts.filter((x) => x.c !== graph.main)) {
      expected.set(at, { path: at, head: c.head, branch: c.branch, bare: false, ...(c.locked !== undefined && { locked: c.locked }), prunable: false });
    }
    const kept = new Set((deps.kept ?? []).map((name) => path.join(common, 'worktrees', name)));
    for (const e of await readWorktrees(checkouts[0]?.at ?? common, git)) {
      const want = expected.get(e.path);
      if (!want && kept.has(registrationOf(rfs, e.path))) continue;
      if (!want) differs.push(`${e.path}: git lists it as a worktree, and the manifest carries no such worktree`);
      else if (described(e) !== described(want)) differs.push(`${e.path}: git lists it ${described(e)}, the source left it ${described(want)}`);
      expected.delete(e.path);
    }
    for (const p of expected.keys()) differs.push(`${p}: git does not list it as a worktree`);

    const stash = checkouts.length ? await readStash(checkouts[0].at, git) : [];
    if (stash.join('\n') !== graph.stash.join('\n')) {
      differs.push(`${common}: the stash is not the one the source left (${stash.length} entries here, ${graph.stash.length} there)`);
    }
  } catch (e) {
    if (!refusal(e)) throw e;
    return [unresolved(e, entity)];
  }
  return differs.map((message) => ({ code: 'git_mismatch', message, entity }));
}

/**
 * Rebuilds and proves every graph a manifest carries on this, its destination machine. A Git root no graph
 * describes blocks: it would arrive without the graph its worktrees need.
 */
export async function repairGraphs(
  manifest: Pick<TransferManifestV1, 'sourceRoots' | 'destinationRoots' | 'roots' | 'git'>, deps: RepairDeps & { kept?: Record<string, readonly string[]> } = {},
): Promise<{ repairs: GraphRepair[]; blockers: Blocker[] }> {
  const graphs = manifest.git ?? [];
  const described = new Set(graphs.flatMap((g) => [g.commonDir, ...(g.main ? [g.main.path] : []), ...g.worktrees.map((w) => w.path)]));
  const blockers: Blocker[] = manifest.roots
    .filter((r) => (r.kind === 'repo' || r.kind === 'worktree' || r.kind === 'gitdir') && !described.has(r.sourcePath))
    .map((r) => ({ code: 'worktree_unresolved', message: `${r.sourcePath}: no Git graph in the manifest describes it`, entity: { kind: 'root', id: r.id } }));
  const map = mapThroughRoots(manifest);
  const repairs: GraphRepair[] = [];
  for (const g of graphs) {
    const graphDeps = { ...deps, kept: deps.kept?.[g.id] ?? [] };
    const r = await repairGraph(g, map, graphDeps);
    if (r.repair) repairs.push(r.repair);
    blockers.push(...(r.blockers.length ? r.blockers : await validateGraph(g, map, graphDeps)));
  }
  return { repairs, blockers };
}
