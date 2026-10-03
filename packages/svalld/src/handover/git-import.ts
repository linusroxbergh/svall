import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { Blocker, GitGraph, HandoverEntity, KeptCommit, ReceivedGraph, TransferManifestV1 } from '@svall/protocol';
import { DIRS_ARGS, parseDirs, runGit, type GitRunner } from '../links/git.js';
import { GitFailure, listedMain, must, readCheckout, readStash, readWorktrees, said, type WorktreeEntry } from './git-graph.js';
import { byCodeUnit, sha256Hex } from './hash.js';

/** What `git init` probes of the filesystem a Git directory sits on; `precomposeUnicode` only where git probes it, on macOS. */
export type FsRules = { ignoreCase: boolean; precomposeUnicode?: boolean };

/** Reads the rules as `git init` would in `dir`: a config found by another case, and on macOS a name found in its other Unicode form. */
export function probeFsRules(dir: string, platform: NodeJS.Platform = process.platform): FsRules {
  const ignoreCase = fs.existsSync(path.join(dir, 'CoNfIg'));
  if (platform !== 'darwin') return { ignoreCase };
  const mark = `.svall-probe-${process.pid}-${crypto.randomBytes(4).toString('hex')}-`;
  const composed = path.join(dir, `${mark}\u00e4`);
  fs.writeFileSync(composed, '', { flag: 'wx', mode: 0o600 });
  try {
    return { ignoreCase, precomposeUnicode: fs.existsSync(path.join(dir, `${mark}a\u0308`)) };
  } finally {
    fs.rmSync(composed, { force: true });
  }
}

export type ImportDeps = { git?: GitRunner; probe?: (dir: string) => FsRules };

/** A registration under a carried common directory that stays with this machine: one the manifest does not carry, whose worktree is here. */
export type KeptWorktree = { name: string; registration: string; path: string };

/** Each graph a manifest carries, as the machine it goes to reads it. */
export function graphsHere(m: Pick<TransferManifestV1, 'git'>): ReceivedGraph[] {
  return (m.git ?? []).map((g): ReceivedGraph => {
    const checkouts = [...(g.main ? [g.main] : []), ...g.worktrees];
    const heads = checkouts.flatMap((c) => (c.head ? [c.head] : []));
    return { id: g.id, commonDir: g.commonDir, carried: g.worktrees.map((w) => path.basename(w.gitDir)), tips: [...new Set([...(g.tips ?? []), ...heads, ...g.stash])] };
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
export async function keptWorktrees(g: ReceivedGraph, deps: Pick<ImportDeps, 'git'> = {}): Promise<{ kept: KeptWorktree[]; unproven: KeptCommit[] }> {
  const git = deps.git ?? runGit;
  const registrations = path.join(g.commonDir, 'worktrees');
  let ids: string[] = [];
  try { ids = fs.readdirSync(registrations); } catch { return { kept: [], unproven: [] }; }
  const kept: KeptWorktree[] = [];
  const unproven: KeptCommit[] = [];
  for (const name of ids.filter((id) => !g.carried.includes(id)).sort(byCodeUnit)) {
    const registration = path.join(registrations, name);
    let gitfile: string;
    try { gitfile = fs.readFileSync(path.join(registration, 'gitdir'), 'utf8').trim(); } catch { continue; }
    const at = path.dirname(path.resolve(registration, gitfile));
    if (!gitfile || !fs.existsSync(at)) continue;
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

// a refusal that leaves a graph unimported, as against a bug
const refusal = (e: unknown): e is Error => e instanceof GitFailure || typeof (e as NodeJS.ErrnoException).code === 'string';

const unresolved = (e: Error, entity: HandoverEntity): Blocker => ({ code: 'worktree_unresolved', message: e.message, entity });

/**
 * Takes one copied graph as it came: the keys `git init` probes follow this filesystem, and each registration neither
 * carried nor kept here goes while its branch stays. Then git has to read the graph as the source left it.
 */
async function importGraph(graph: GitGraph, deps: ImportDeps & { kept?: readonly string[] } = {}): Promise<Blocker[]> {
  const git = deps.git ?? runGit;
  const common = graph.commonDir;
  try {
    // a config carried as a link would be written through to wherever it leads
    if (fs.lstatSync(path.join(common, 'config'), { throwIfNoEntry: false })?.isFile()) await adaptRules(common, (deps.probe ?? probeFsRules)(common), git);
    const registrations = path.join(common, 'worktrees');
    // a registrations folder carried as a link would have its removals made wherever it leads
    const held = fs.lstatSync(registrations, { throwIfNoEntry: false });
    if (held && !held.isDirectory()) throw new GitFailure(`${registrations} is not a folder of its own, so the import removes nothing through it`);
    const keep = new Set([...graph.worktrees.map((w) => path.basename(w.gitDir)), ...(deps.kept ?? [])]);
    const ids = held ? fs.readdirSync(registrations) : [];
    for (const id of ids.filter((x) => !keep.has(x))) fs.rmSync(path.join(registrations, id), { recursive: true, force: true });
  } catch (e) {
    if (!refusal(e)) throw e;
    return [unresolved(e, { kind: 'git', id: graph.id })];
  }
  return validateGraph(graph, deps);
}

const short = (head: string | null): string => head?.slice(0, 12) ?? 'no commit';

// the registration a worktree's own gitfile names, as git reads it
function registrationOf(worktree: string): string {
  try {
    const link = /^gitdir: (.*)$/m.exec(fs.readFileSync(path.join(worktree, '.git'), 'utf8'))?.[1];
    return link ? path.resolve(worktree, link) : '';
  } catch { return ''; }
}

function described(e: WorktreeEntry): string {
  const at = e.bare ? 'bare' : e.branch ? `on ${e.branch} at ${short(e.head)}` : `detached at ${short(e.head)}`;
  return `${at}${e.locked === undefined ? '' : e.locked ? `, locked: ${e.locked}` : ', locked'}${e.prunable ? ', missing' : ''}`;
}

/**
 * Proves a copied graph is the one the source left: each checkout resolves to its own git dirs and reads the
 * same status and staged entries, git lists exactly the carried worktrees with their HEAD, branch and lock,
 * and the stash holds the same entries.
 */
export async function validateGraph(graph: GitGraph, deps: Pick<ImportDeps, 'git'> & { kept?: readonly string[] } = {}): Promise<Blocker[]> {
  const git = deps.git ?? runGit;
  const entity: HandoverEntity = { kind: 'git', id: graph.id };
  const common = graph.commonDir;
  const differs: string[] = [];
  try {
    const checkouts = [...(graph.main ? [graph.main] : []), ...graph.worktrees];
    for (const c of checkouts) {
      const dirs = parseDirs(await must(git, DIRS_ARGS, c.path));
      if (dirs.root !== c.path || dirs.commonDir !== common || dirs.gitDir !== c.gitDir) {
        differs.push(`${c.path}: git reads it as the checkout ${dirs.root} of ${dirs.commonDir} through ${dirs.gitDir}`);
      }
      const { status, staged } = await readCheckout(c.path, git);
      if (sha256Hex(staged) !== c.index) differs.push(`${c.path}: the staged entries differ from the source's`);
      const odd = status.find((s) => !c.status.includes(s)) ?? c.status.find((s) => !status.includes(s));
      if (odd !== undefined || status.length !== c.status.length) differs.push(`${c.path}: git status differs from the source's${odd === undefined ? '' : ` at ${odd}`}`);
    }

    const expected = new Map<string, WorktreeEntry>();
    const main = listedMain(common);
    expected.set(main, { path: main, head: graph.main?.head ?? null, branch: graph.main?.branch ?? null, bare: !graph.main, prunable: false });
    for (const c of graph.worktrees) {
      expected.set(c.path, { path: c.path, head: c.head, branch: c.branch, bare: false, ...(c.locked !== undefined && { locked: c.locked }), prunable: false });
    }
    const kept = new Set((deps.kept ?? []).map((name) => path.join(common, 'worktrees', name)));
    for (const e of await readWorktrees(checkouts[0]?.path ?? common, git)) {
      const want = expected.get(e.path);
      if (!want && kept.has(registrationOf(e.path))) continue;
      if (!want) differs.push(`${e.path}: git lists it as a worktree, and the manifest carries no such worktree`);
      else if (described(e) !== described(want)) differs.push(`${e.path}: git lists it ${described(e)}, the source left it ${described(want)}`);
      expected.delete(e.path);
    }
    for (const p of expected.keys()) differs.push(`${p}: git does not list it as a worktree`);

    const stash = checkouts.length ? await readStash(checkouts[0].path, git) : [];
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
 * Imports and proves every graph a manifest carries on this, its destination machine. A Git root no graph
 * describes blocks: it would arrive without the graph its worktrees need.
 */
export async function importGraphs(
  manifest: Pick<TransferManifestV1, 'roots' | 'git'>, deps: ImportDeps & { kept?: Record<string, readonly string[]> } = {},
): Promise<Blocker[]> {
  const graphs = manifest.git ?? [];
  const described = new Set(graphs.flatMap((g) => [g.commonDir, ...(g.main ? [g.main.path] : []), ...g.worktrees.map((w) => w.path)]));
  const blockers: Blocker[] = manifest.roots
    .filter((r) => (r.kind === 'repo' || r.kind === 'worktree' || r.kind === 'gitdir') && !described.has(r.path))
    .map((r) => ({ code: 'worktree_unresolved', message: `${r.path}: no Git graph in the manifest describes it`, entity: { kind: 'root', id: r.id } }));
  for (const g of graphs) blockers.push(...await importGraph(g, { ...deps, kept: deps.kept?.[g.id] ?? [] }));
  return blockers;
}
