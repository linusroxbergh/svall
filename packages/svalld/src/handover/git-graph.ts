import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { Blocker, FleetState, GitCheckout, GitGraph, GitRegistration, HandoverEntity, Warning } from '@svall/protocol';
import { DIRS_ARGS, parseDirs, runGit, type GitDirs, type GitRunner } from '../links/git.js';
import { byCodeUnit, sha256Hex } from './hash.js';
import { excludeMatcher, excludedPath, settle } from './inventory.js';

/** One entry of `git worktree list --porcelain -z`. `head` is null on an unborn branch, `branch` on a detached HEAD. */
export type WorktreeEntry = { path: string; head: string | null; branch: string | null; bare: boolean; locked?: string; prunable: boolean };

export function parseWorktreeList(stdout: string): WorktreeEntry[] {
  const out: WorktreeEntry[] = [];
  let at: WorktreeEntry | undefined;
  // each attribute ends in a NUL and each worktree in an empty attribute
  for (const field of stdout.split('\0')) {
    const space = field.indexOf(' ');
    const key = space < 0 ? field : field.slice(0, space);
    const value = space < 0 ? '' : field.slice(space + 1);
    if (key === 'worktree') at = { path: value, head: null, branch: null, bare: false, prunable: false };
    else if (!at) continue;
    else if (key === '') { out.push(at); at = undefined; }
    else if (key === 'HEAD') at.head = /^0+$/.test(value) ? null : value;
    else if (key === 'branch') at.branch = value;
    else if (key === 'bare') at.bare = true;
    else if (key === 'locked') at.locked = value;
    else if (key === 'prunable') at.prunable = true;
  }
  if (at) out.push(at);
  return out;
}

/** Where git lists a main worktree: its common directory, less a trailing `/.git`. */
export const listedMain = (commonDir: string): string => (commonDir.endsWith('/.git') ? commonDir.slice(0, -5) : commonDir);

export const graphId = (commonDir: string): string => `g_${sha256Hex(commonDir).slice(0, 16)}`;

export class GitFailure extends Error {}

/** What git said on stderr, on one line. */
export const said = (text: string): string => text.trim().replace(/\s+/g, ' ');

/** Runs git and answers its output, or throws what it said. */
export async function must(git: GitRunner, args: readonly string[], cwd: string, subject = cwd): Promise<string> {
  const r = await git(args, cwd);
  if (r.code !== 0) throw new GitFailure(`${subject}: git ${args.join(' ')} failed: ${said(r.stderr) || `exit ${r.code}`}`);
  return r.stdout;
}

// tracked paths only, the same on every machine whatever its own git configuration says
const STATUS_ARGS = ['status', '--porcelain=v2', '-z', '--untracked-files=no', '--ignore-submodules=untracked', '--no-renames'];

function parseStatus(stdout: string): string[] {
  const fields = stdout.split('\0');
  const out: string[] = [];
  for (let i = 0; i < fields.length; i++) {
    const f = fields[i];
    if (f.startsWith('2 ')) out.push(`${f}\t${fields[++i]}`);
    else if (f && !f.startsWith('#')) out.push(f);
  }
  return out;
}

/** What git reads in one checkout besides its HEAD: the status of tracked paths, and every staged entry. */
export async function readCheckout(dir: string, git: GitRunner): Promise<{ status: string[]; staged: string }> {
  const status = parseStatus(await must(git, STATUS_ARGS, dir));
  return { status, staged: await must(git, ['ls-files', '--stage', '-z'], dir) };
}

export async function readWorktrees(dir: string, git: GitRunner, subject?: string): Promise<WorktreeEntry[]> {
  try {
    return parseWorktreeList(await must(git, ['worktree', 'list', '--porcelain', '-z'], dir, subject));
  } catch (e) {
    // git before 2.36 has no -z here, and lists one attribute a line
    if (!(e instanceof GitFailure && /unknown switch `z'/.test(e.message))) throw e;
  }
  return parseWorktreeList(nulled(await must(git, ['worktree', 'list', '--porcelain'], dir, subject), subject ?? dir));
}

// one entry as git before 2.36 writes it, less its blank line, each attribute in its place and once
const ENTRY = /^worktree [^\n]*\n(?:bare|HEAD [0-9a-f]+(?:\n(?:detached|branch [^\n]+))?)(?:\nlocked(?: [^\n]*)?)?(?:\nprunable [^\n]*)?$/;
const ESCAPES: Record<string, number> = { a: 7, b: 8, t: 9, n: 10, v: 11, f: 12, r: 13, '"': 34, '\\': 92 };

// the -z form of a listing git wrote one attribute a line: a lock reason there is C-quoted, and a path never is,
// so a path with a line break in it makes an entry git would not write
function nulled(stdout: string, subject: string): string {
  const entries = stdout.replace(/\n\n$/, '').split('\n\n');
  if (!entries.every((e) => ENTRY.test(e))) {
    throw new GitFailure(`${subject}: git lists a worktree path with a line break in it, which git prints whole only with -z, in git 2.36 or later`);
  }
  return entries.map((e) => `${e.split('\n').map((line) => (line.startsWith('locked "') ? `locked ${unquoted(line.slice(7))}` : line)).join('\0')}\0\0`).join('');
}

function unquoted(quoted: string): string {
  const raw = Buffer.from(quoted.slice(1, -1));
  const out: number[] = [];
  for (let i = 0; i < raw.length; i++) {
    if (raw[i] !== 0x5c) { out.push(raw[i]); continue; }
    const escape = ESCAPES[String.fromCharCode(raw[++i])];
    if (escape !== undefined) out.push(escape);
    else { out.push(parseInt(raw.toString('latin1', i, i + 3), 8)); i += 2; }
  }
  return Buffer.from(out).toString();
}

export async function readStash(dir: string, git: GitRunner): Promise<string[]> {
  return (await must(git, ['stash', 'list', '--format=%H'], dir)).split('\n').filter(Boolean);
}

// a place on this machine: a path, or a file: url
const hostLocal = (url: string): boolean => /^(\/|\.\.?\/|~|file:)/.test(url);

export type GitDiscovery = { graphs: GitGraph[]; blockers: Blocker[]; warnings: Warning[] };
export type DiscoverOptions = { excludes: readonly string[]; git?: GitRunner; exists?: (p: string) => boolean };

type Slot = { characterId: string; dirs: GitDirs };

/**
 * The repository graph around every character terminal that stands in Git: each common directory once,
 * with its main checkout whether or not anyone stands in it, the linked worktrees the crew uses, and the
 * registrations it does not. What cannot be read faithfully blocks.
 */
export async function discoverGit(state: FleetState, opts: DiscoverOptions): Promise<GitDiscovery> {
  const git = opts.git ?? runGit;
  const exists = opts.exists ?? fs.existsSync;
  const blockers: Blocker[] = [];
  const warnings: Warning[] = [];
  const byCommon = new Map<string, Slot[]>();
  for (const c of Object.values(state.characters).sort((a, b) => byCodeUnit(a.id, b.id))) {
    const entity: HandoverEntity = { kind: 'character', id: c.id };
    for (const [cwd, recorded] of [[c.cwd, c.repo], [c.second?.cwd, undefined]] as const) {
      if (!cwd) continue;
      if (!exists(cwd)) {
        if (recorded) blockers.push({ code: 'worktree_unresolved', message: `${c.name} was working in the Git checkout ${recorded.root}, and ${cwd} no longer exists`, entity });
        continue;
      }
      const r = await git(DIRS_ARGS, cwd);
      if (r.code !== 0) {
        if (!/not a git repository/.test(r.stderr)) blockers.push({ code: 'worktree_unresolved', message: `${cwd}: ${said(r.stderr)}`, entity });
        continue;
      }
      const dirs = parseDirs(r.stdout);
      byCommon.set(dirs.commonDir, [...(byCommon.get(dirs.commonDir) ?? []), { characterId: c.id, dirs }]);
    }
  }
  const standing = new Set([...byCommon.values()].flat().map((s) => s.dirs.root));
  const excluded = excludeMatcher(opts.excludes);
  const graphs: GitGraph[] = [];
  for (const [commonDir, slots] of [...byCommon].sort(([a], [b]) => byCodeUnit(a, b))) {
    const entity: HandoverEntity = { kind: 'git', id: graphId(commonDir) };
    try {
      const read = await readGraph(commonDir, slots, git);
      graphs.push(read.graph);
      for (const checkout of [...(read.graph.main ? [read.graph.main] : []), ...read.graph.worktrees]) {
        const left = read.tracked.get(checkout.path)!.filter((p) => excludedPath(p, excluded));
        if (left.length) blockers.push({ code: 'path_unsupported', message: `${checkout.path}: ${trackedLeft(left)}`, entity });
      }
      for (const [at, url] of await origins(read, standing, git, exists)) {
        warnings.push({ code: 'remote_local', message: `${at}: origin ${url} names a place on this machine, and the destination keeps it as it is`, entity });
      }
      const held = await unusedWork(read.graph, git, exists);
      for (const [at, message] of held) blockers.push({ code: 'worktree_unused', message: `${at}: ${message}`, entity });
      const idle = read.graph.unused.filter((u) => !held.has(u.path));
      if (idle.length) warnings.push({ code: 'worktree_unused', message: unusedMessage(read.graph.commonDir, idle), entity });
    } catch (e) {
      if (!(e instanceof GitFailure)) throw e;
      blockers.push({ code: 'worktree_unresolved', message: e.message, entity });
    }
  }
  return { graphs, blockers: settle(blockers), warnings: settle(warnings) };
}

type ReadGraph = { graph: GitGraph; tracked: Map<string, string[]>; submodules: Map<string, string[]> };

async function readGraph(commonDir: string, slots: Slot[], git: GitRunner): Promise<ReadGraph> {
  const anchor = slots[0].dirs.root;
  const [listed, ...linked] = await readWorktrees(anchor, git, commonDir);
  if (listed?.path !== listedMain(commonDir)) throw new GitFailure(`${commonDir}: git lists its main worktree at ${listed?.path}`);
  const crewOf = (root: string): string[] => [...new Set(slots.filter((s) => s.dirs.root === root).map((s) => s.characterId))].sort(byCodeUnit);
  const tracked = new Map<string, string[]>();
  const submodules = new Map<string, string[]>();

  const checkout = async (at: string, gitDir: string, entry: WorktreeEntry): Promise<GitCheckout> => {
    const { status, staged } = await readCheckout(at, git);
    const entries = staged.split('\0').filter(Boolean);
    tracked.set(at, entries.map((e) => e.slice(e.indexOf('\t') + 1)));
    submodules.set(at, entries.filter((e) => e.startsWith('160000 ')).map((e) => e.slice(e.indexOf('\t') + 1)));
    return {
      path: at, gitDir, head: entry.head, branch: entry.branch, ...(entry.locked !== undefined && { locked: entry.locked }),
      status, index: sha256Hex(staged), characters: crewOf(at),
    };
  };

  let main: GitCheckout | undefined;
  if (!listed.bare) {
    const at = slots.find((s) => s.dirs.gitDir === commonDir)?.dirs.root ?? await mainOf(commonDir, git);
    main = await checkout(at, commonDir, listed);
  }
  const used = new Map(slots.filter((s) => s.dirs.gitDir !== commonDir).map((s) => [s.dirs.root, s.dirs.gitDir]));
  for (const root of used.keys()) {
    if (!linked.some((e) => e.path === root)) throw new GitFailure(`${commonDir}: ${root} is not among its registered worktrees`);
  }
  const worktrees: GitCheckout[] = [];
  const unused: GitRegistration[] = [];
  for (const e of [...linked].sort((a, b) => byCodeUnit(a.path, b.path))) {
    const gitDir = used.get(e.path);
    if (gitDir) worktrees.push(await checkout(e.path, gitDir, e));
    else unused.push({ path: e.path, head: e.head, branch: e.branch, ...(e.locked !== undefined && { locked: e.locked }), prunable: e.prunable });
  }
  const stash = await readStash(main?.path ?? worktrees[0].path, git);
  const tips = [...new Set((await must(git, ['for-each-ref', '--format=%(objectname)'], main?.path ?? worktrees[0].path)).split('\n').filter(Boolean))].sort(byCodeUnit);
  return { graph: { id: graphId(commonDir), commonDir, ...(main && { main }), worktrees, unused, stash, tips }, tracked, submodules };
}

// a common dir named .git sits in its main checkout; a submodule's names its checkout in core.worktree
async function mainOf(commonDir: string, git: GitRunner): Promise<string> {
  if (path.basename(commonDir) === '.git') return path.dirname(commonDir);
  const r = await git(['rev-parse', '--path-format=absolute', '--show-toplevel'], commonDir);
  if (r.code !== 0) throw new GitFailure(`${commonDir}: no character stands in its main checkout, and git cannot say where it is`);
  return r.stdout.replace(/\n$/, '');
}

function trackedLeft(paths: string[]): string {
  const shown = paths.slice(0, 5).join(', ') + (paths.length > 5 ? `, and ${paths.length - 5} more` : '');
  return paths.length === 1
    ? `1 tracked file lies under an excluded path and would arrive deleted: ${shown}`
    : `${paths.length} tracked files lie under excluded paths and would arrive deleted: ${shown}`;
}

// the graph's own origin, and each initialized submodule's that is not a graph of its own
async function origins(read: ReadGraph, standing: Set<string>, git: GitRunner, exists: (p: string) => boolean): Promise<[string, string][]> {
  const { graph, submodules } = read;
  const places: string[] = [graph.main?.path ?? graph.worktrees[0].path];
  for (const [at, subs] of submodules) {
    for (const sub of subs) {
      const inner = path.join(at, sub);
      if (!standing.has(inner) && exists(path.join(inner, '.git'))) places.push(inner);
    }
  }
  const out: [string, string][] = [];
  for (const place of places) {
    const r = await git(['config', '--get', 'remote.origin.url'], place);
    const url = r.stdout.trim();
    if (r.code === 0 && hostLocal(url)) out.push([place === places[0] ? graph.main?.path ?? graph.commonDir : place, url]);
  }
  return out;
}

/**
 * The unused registrations that alone keep some work, and why: changes git status reports in the folder,
 * a detached commit no ref reaches, or a locked folder that is not there to read. A handover back drops
 * the registration, and with it the only way to that work.
 */
async function unusedWork(graph: GitGraph, git: GitRunner, exists: (p: string) => boolean): Promise<Map<string, string>> {
  const at = graph.main?.path ?? graph.worktrees[0].path;
  const held = new Map<string, string>();
  for (const u of graph.unused) {
    const here = exists(u.path);
    if (!here && u.locked !== undefined) {
      held.set(u.path, 'a locked worktree no character uses is not there, so what it holds cannot be read; mount it, or unlock or remove the worktree');
    } else if (here && parseStatus(await must(git, ['status', '--porcelain=v2', '-z', '--untracked-files=normal'], u.path)).length) {
      held.set(u.path, 'a worktree no character uses holds changes git status reports, which a handover back would leave without their registration; commit or stash them there, or remove the worktree');
    } else if (!u.branch && u.head && !(await must(git, ['for-each-ref', '--contains', u.head, '--count=1', '--format=%(refname)'], at)).trim()) {
      const commit = u.head.slice(0, 12);
      held.set(u.path, `a worktree no character uses is detached at ${commit}, which no branch or tag reaches; name it with git branch <name> ${commit}, or remove the worktree`);
    }
  }
  return held;
}

function unusedMessage(commonDir: string, unused: GitRegistration[]): string {
  const items = unused.map((u) => {
    const at = u.branch ? `on ${u.branch.replace(/^refs\/heads\//, '')}` : u.head ? `detached at ${u.head.slice(0, 12)}` : 'unborn';
    const lock = u.locked === undefined ? [] : [u.locked ? `locked: ${u.locked}` : 'locked'];
    return `${u.path} (${[at, ...lock, ...(u.prunable ? ['missing'] : [])].join(', ')})`;
  });
  return `${commonDir}: worktrees no character uses are not registered on the destination, though their branches travel: ${items.join('; ')}`;
}

/**
 * The digest of what a Git index stages: each entry's mode, object, stage, flags and path, without the
 * stat data a `git status` refreshes or the caches beside the entries. Undefined for anything that is not
 * a whole index this reading knows, a split index included.
 */
export function gitIndexDigest(buf: Buffer): string | undefined {
  if (buf.length < 12 || buf.toString('latin1', 0, 4) !== 'DIRC') return undefined;
  const version = buf.readUInt32BE(4);
  if (version < 2 || version > 4) return undefined;
  // the trailer is the file's own hash, or zeros under index.skipHash: 20 bytes for SHA-1, 32 for SHA-256,
  // and so the width of every object id in it
  for (const oidLen of [20, 32]) {
    if (buf.length < 12 + oidLen) continue;
    const trailer = buf.subarray(buf.length - oidLen);
    const hashed = crypto.createHash(oidLen === 20 ? 'sha1' : 'sha256').update(buf.subarray(0, buf.length - oidLen)).digest();
    if (!trailer.equals(hashed) && trailer.some((b) => b !== 0)) continue;
    const digest = stagedEntries(buf, version, oidLen);
    if (digest) return digest;
  }
  return undefined;
}

function stagedEntries(buf: Buffer, version: number, oidLen: number): string | undefined {
  const end = buf.length - oidLen;
  const hash = crypto.createHash('sha256');
  let at = 12;
  let previous: Buffer = Buffer.alloc(0);
  for (let i = buf.readUInt32BE(8); i > 0; i--) {
    const start = at;
    if (at + 42 + oidLen > end) return undefined;
    const mode = buf.readUInt32BE(at + 24);
    const oid = buf.toString('hex', at + 40, at + 40 + oidLen);
    const flags = buf.readUInt16BE(at + 40 + oidLen);
    at += 42 + oidLen;
    let extended = 0;
    if (flags & 0x4000) {
      if (version < 3 || at + 2 > end) return undefined;
      extended = buf.readUInt16BE(at);
      at += 2;
    }
    let name: Buffer;
    if (version === 4) {
      // the name drops a varint count of bytes from the end of the previous one, then adds its own
      let c = buf[at++];
      let strip = c & 127;
      while (c & 128 && at < end) { c = buf[at++]; strip = ((strip + 1) << 7) + (c & 127); }
      const nul = buf.indexOf(0, at);
      if (strip > previous.length || nul < 0 || nul >= end) return undefined;
      name = Buffer.concat([previous.subarray(0, previous.length - strip), buf.subarray(at, nul)]);
      at = nul + 1;
    } else {
      const nul = buf.indexOf(0, at);
      if (nul < 0 || nul >= end) return undefined;
      name = buf.subarray(at, nul);
      at = start + ((at - start + name.length + 8) & ~7);
    }
    hash.update(`${mode.toString(8)} ${oid} ${flags & 0xb000} ${extended & 0x6000} `).update(name).update('\0');
    previous = name;
  }
  // a split index holds only its changes against a shared index kept in another file
  while (at + 8 <= end) {
    if (buf.toString('latin1', at, at + 4) === 'link') return undefined;
    at += 8 + buf.readUInt32BE(at + 4);
  }
  return at === end ? hash.digest('hex') : undefined;
}
