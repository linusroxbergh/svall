import fs from 'node:fs';
import path from 'node:path';
import type { AgentKind, Blocker, FleetConfig, FleetState, GitCheckout, GitGraph, HandoverEntity, MachineId, PathRootMap, TransferRoot, TransferSession, Warning } from '@archipelago/protocol';
import { resolvePaths } from '../paths.js';
import type { GitDiscovery } from './git-graph.js';
import { byCodeUnit, canonicalJson, sha256Hex } from './hash.js';
import { exportSnapshot, holds, locatePath, mapPortablePath, portablePathValues, realHoldingRoot, realPath, realRoots, rewrite, type PathValue } from './portable-path.js';

/** Where one machine keeps what a handover moves: its path roots, this fleet's own home, and where each agent CLI keeps its sessions. */
export type MachineMap = { machineId: MachineId; pathRoots: PathRootMap; fleetHome: string; agentHomes?: Partial<Record<AgentKind, string>> };
export type MachineMaps = { source: MachineMap; destination: MachineMap };
export type InventoryConfigs = { fleet: FleetConfig };

export type InventoryRoot = Pick<TransferRoot, 'id' | 'kind' | 'entry' | 'sourcePath' | 'destinationPath' | 'foldedInto'>;
// the cwd the agent resumes in on the destination, which a Claude Code project folder is named for
export type InventorySession = Pick<TransferSession, 'characterId' | 'term' | 'agent' | 'sessionId' | 'sourcePath' | 'destinationHome'> & { destinationCwd?: string };

/** What a handover would carry and from where to where, before a byte of it is read. */
export type Inventory = {
  fromMachineId: MachineId;
  toMachineId: MachineId;
  sourceRoots: PathRootMap;
  /** the real path of each source root declared through a link */
  sourceRealRoots?: PathRootMap;
  destinationRoots: PathRootMap;
  fleet: FleetConfig;
  snapshot: FleetState;
  excludes: string[];
  roots: InventoryRoot[];
  sessions: InventorySession[];
  git: GitGraph[];
  blockers: Blocker[];
  warnings: Warning[];
};

// caches each machine builds for itself
export const DEFAULT_EXCLUDES = ['node_modules/', '.venv/', '__pycache__/', 'dist/', 'build/', 'target/', '.next/', '*.tsbuildinfo'] as const;

// v1 carries no path holding one: rsync's file lists and itemized output are read a line at a time
export const CONTROL = /[\x00-\x1f\x7f]/;

// Git's own records are never a cache: no exclude reaches a `.git` entry or anything under one
const inGit = (relative: string): boolean => relative.split('/').includes('.git');

/** The same promise as rsync filter rules, to go ahead of the excludes. */
export const GIT_KEEP_RULES = ['+ .git', '+ .git/**'] as const;

// Git's own entries at the top of a Git directory; branches, worktrees and submodules name what lies under them
const GIT_DIR_ENTRIES = [
  'HEAD', 'FETCH_HEAD', 'ORIG_HEAD', 'MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'AUTO_MERGE', 'BISECT_LOG', 'COMMIT_EDITMSG',
  'config', 'config.worktree', 'description', 'packed-refs', 'index', 'shallow', 'objects', 'refs', 'logs', 'worktrees', 'modules',
  'info', 'hooks', 'branches', 'rr-cache', 'sequencer', 'rebase-merge', 'rebase-apply', 'lfs',
] as const;

/** For a root that is itself a Git directory, the same promise as rsync filter rules, to go ahead of the excludes with GIT_KEEP_RULES. */
export const GIT_DIR_KEEP_RULES: readonly string[] = GIT_DIR_ENTRIES.flatMap((e) => [`+ /${e}`, `+ /${e}/**`]);

/**
 * How a root's copy reads the fleet's excludes. In a Git directory carried on its own, Git's own entries are
 * never excluded, and a checkout kept inside it leaves out its caches as any other does.
 */
export const rootMatcher = (kind: TransferRoot['kind'] | undefined, excludes: readonly string[]): ((relative: string, dir: boolean) => boolean) =>
  excludeMatcher(excludes, kind === 'gitdir' ? new Set(GIT_DIR_ENTRIES) : undefined);

/** The fleet's excludes: the defaults unless fleet.json turns them off, then its own, each once and in that order. */
export function expandExcludes(handover: FleetConfig['handover']): { excludes: string[]; blockers: Blocker[] } {
  const blockers: Blocker[] = [];
  const own = handover.exclude.filter((pattern) => {
    // an exclude file reads a leading `+ `, `- ` or `!` as a rule and `#` or `;` as a comment
    if (pattern !== '' && !CONTROL.test(pattern) && !/^([+-] |!|#|;)/.test(pattern)) return true;
    blockers.push({ code: 'path_unsupported', message: `fleet.json handover.exclude holds ${JSON.stringify(pattern)}, which rsync would not read as a pattern` });
    return false;
  });
  return { excludes: [...new Set([...(handover.excludeDefaults ? DEFAULT_EXCLUDES : []), ...own])], blockers };
}

function globSource(glob: string): string {
  let out = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*' && glob[i + 1] === '*') { out += '.*'; i++; }
    else if (c === '*') out += '[^/]*';
    else if (c === '?') out += '[^/]';
    else if (c === '[' && glob.indexOf(']', i + 2) > 0) {
      const end = glob.indexOf(']', i + 2);
      out += `[${glob.slice(i + 1, end).replace(/^!/, '^').replace(/\\/g, '\\\\')}]`;
      i = end;
    } else out += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return out;
}

/** rsync's reading of exclude patterns, for a path relative to its transfer root. Nothing under a name in `kept` at the top is excluded. */
export function excludeMatcher(patterns: readonly string[], kept?: ReadonlySet<string>): (relative: string, dir: boolean) => boolean {
  const rules = patterns.map((pattern) => {
    const dirOnly = pattern.endsWith('/');
    const body = dirOnly ? pattern.slice(0, -1) : pattern;
    const anchored = body.startsWith('/');
    const glob = anchored ? body.slice(1) : body;
    // with a slash or `**` in it a pattern is matched against the path's end, else against its last name
    const whole = anchored || glob.includes('/') || glob.includes('**');
    return { dirOnly, whole, re: new RegExp(`${anchored || !whole ? '^' : '(?:^|/)'}${globSource(glob)}$`) };
  });
  return (relative, dir) => !inGit(relative) && !kept?.has(relative.split('/')[0]) && rules.some((r) =>
    (dir || !r.dirOnly) && r.re.test(r.whole ? relative : relative.slice(relative.lastIndexOf('/') + 1)));
}

type Kind = TransferRoot['kind'];
// the kind a path takes when fields of more than one kind name it
const RANK: Kind[] = ['repo', 'worktree', 'gitdir', 'home', 'cwd', 'context'];

// what each field makes of the path it names; `repo.root` is a root of its own only in a linked worktree
const ROOT_OF: Record<string, Kind> = {
  'FleetState.characters.*.repo.mainRoot': 'repo',
  'FleetState.characters.*.repo.root': 'worktree',
  'FleetState.characters.*.cwd': 'cwd',
  'FleetState.characters.*.second.cwd': 'cwd',
  'FleetState.characters.*.context[].ref': 'context',
  'FleetState.characters.*.browser.tabs[].url': 'context',
  'FleetState.islands.*.context[].ref': 'context',
  'FleetConfig.home.cwd': 'home',
};

const rootId = (sourcePath: string): string => `r_${sha256Hex(sourcePath).slice(0, 16)}`;
const isGit = (kind: Kind): boolean => kind === 'repo' || kind === 'worktree' || kind === 'gitdir';

// a root and the real path its copy reads from on this machine
type Candidate = { root: InventoryRoot; real: string };
type FleetHomes = { source: string; sourceReal: string; destination: string };

/**
 * The fleet home a root would carry or overwrite, if any: a fleet home holds its machine's token, keys,
 * journal and node.json. Mission control's cwd lies inside it by design, and so may anything inside that.
 */
function fleetHomeClash(c: Candidate, mission: Candidate | undefined, homes: FleetHomes): string | undefined {
  const { root, real } = c;
  const places: [at: string, home: string, named: string][] = [
    [root.sourcePath, homes.source, homes.source],
    [real, homes.sourceReal, homes.source],
    [root.destinationPath, homes.destination, homes.destination],
  ];
  const held = places.find(([at, home]) => holds(at, home));
  if (held) return held[2];
  const inMission = mission !== undefined && holds(mission.root.sourcePath, root.sourcePath) && holds(mission.real, real)
    && holds(mission.root.destinationPath, root.destinationPath);
  return inMission ? undefined : places.find(([at, home]) => holds(home, at))?.[2];
}

// what is on disk decides how a root folds; a path that is not there folds as a folder
function entryOf(real: string): InventoryRoot['entry'] {
  try { return fs.statSync(real).isDirectory() ? 'dir' : 'file'; } catch { return 'dir'; }
}

const characterOf = (v: PathValue): HandoverEntity | undefined =>
  (v.field.startsWith('FleetState.characters.') ? { kind: 'character', id: String(v.pointer[1]) } : undefined);

/**
 * Everything a handover carries from `source` to `destination`: each working root once, mapped through
 * the destination's path roots, the transcript each agent recorded, and what stops the move. With the
 * discovered Git graphs, those graphs name every Git root; without them, the recorded repo fields do.
 */
export function buildInventory(state: FleetState, configs: InventoryConfigs, machineMaps: MachineMaps, git?: GitDiscovery): Inventory {
  const { source, destination } = machineMaps;
  const sourceReal = realRoots(source.pathRoots);
  // what leaves this machine names each path as a declared root spells it, whatever spelling this machine recorded it by
  const snapshot = exportSnapshot(state);
  const fleet = structuredClone(configs.fleet);
  const spell = declared(source.pathRoots);
  for (const v of portablePathValues({ FleetState: snapshot, FleetConfig: fleet }, source.pathRoots.home)) {
    const spelled = v.form === 'transcript' ? v.path : spell(v.path);
    if (spelled !== v.path) rewrite({ FleetState: snapshot, FleetConfig: fleet }, v, spelled, source.pathRoots.home);
  }
  const { excludes, blockers } = expandExcludes(fleet.handover);
  blockers.push(...(git?.blockers ?? []));

  const locate = (p: string, entity: HandoverEntity | undefined): ReturnType<typeof locatePath> | undefined => {
    if (CONTROL.test(p) || !p.startsWith('/')) {
      blockers.push({ code: 'path_unsupported', message: `${JSON.stringify(p)} ${p.startsWith('/') ? 'holds a control character' : 'is not absolute'}`, entity });
      return undefined;
    }
    let located;
    try { located = locatePath(p, source.pathRoots); } catch (e) {
      blockers.push({ code: 'path_root_missing', message: (e as Error).message, entity });
      return undefined;
    }
    if (Object.hasOwn(destination.pathRoots, located.portable.root)) return located;
    blockers.push({ code: 'path_root_missing', message: `the destination has no path root ${located.portable.root}`, entity });
    return undefined;
  };
  const graphs = (git?.graphs ?? []).map((g) => declaredGraph(g, spell));
  const candidates = new Map<string, Candidate>();
  const offer = (p: string, kind: Kind, { portable, real }: NonNullable<ReturnType<typeof locate>>): void => {
    // a declared root is on both machines already: standing in it, as a shell at ~ does, copies nothing
    if (portable.relative === '' && !isGit(kind)) return;
    const had = candidates.get(p);
    if (had && RANK.indexOf(had.root.kind) <= RANK.indexOf(kind)) return;
    const root = { id: rootId(p), kind, entry: entryOf(real), sourcePath: p, destinationPath: mapPortablePath(portable, destination.pathRoots) };
    candidates.set(p, { root, real });
  };

  // every portable path has to land somewhere on the destination, whether or not anything is copied from it
  for (const v of portablePathValues({ FleetState: snapshot, FleetConfig: fleet }, source.pathRoots.home)) {
    if (v.form === 'transcript') continue;
    const located = locate(v.path, characterOf(v));
    if (!located) continue;
    let kind: Kind | undefined = ROOT_OF[v.field];
    if (kind === 'worktree' && !snapshot.characters[String(v.pointer[1])].repo?.isWorktree) kind = undefined;
    if (git && (kind === 'repo' || kind === 'worktree')) kind = undefined;
    if (kind) offer(v.path, kind, located);
  }
  for (const g of graphs) {
    const entity: HandoverEntity = { kind: 'git', id: g.id };
    const roots = g.worktrees.map((w): [string, Kind] => [w.path, 'worktree']);
    if (g.main) roots.push([g.main.path, 'repo']);
    if (!g.main || !holds(g.main.path, g.commonDir)) roots.push([g.commonDir, 'gitdir']);
    for (const [p, kind] of roots) {
      const located = locate(p, entity);
      if (located) offer(p, kind, located);
    }
  }

  // the fleet .env is the one file of a fleet home that may move, and it is added below only when asked for
  const homes: FleetHomes = { source: path.posix.resolve(source.fleetHome), sourceReal: realPath(path.posix.resolve(source.fleetHome)), destination: path.posix.resolve(destination.fleetHome) };
  const placed = [...candidates.values()];
  const mission = placed.find((c) => c.root.kind === 'home' && !fleetHomeClash(c, c, homes));
  const allowed = placed.filter((c) => {
    const fleetHome = fleetHomeClash(c, mission, homes);
    if (fleetHome) blockers.push({ code: 'path_unsupported', message: `${c.root.sourcePath} overlaps the fleet home ${fleetHome}, whose token, keys and node.json stay on their machine`, entity: { kind: 'root', id: c.root.id } });
    return !fleetHome;
  }).map((c) => c.root);

  const roots = fold(allowed, excludes);
  if (fleet.handover.transferFleetEnv) {
    const env = resolvePaths(source.fleetHome).env;
    roots.push({ id: rootId(env), kind: 'env', entry: 'file', sourcePath: env, destinationPath: resolvePaths(destination.fleetHome).env });
  }

  const sessions: InventorySession[] = [];
  for (const c of Object.values(snapshot.characters)) {
    for (const [term, slot] of [[undefined, c], [2, c.second]] as const) {
      if (!slot?.agent) continue;
      const entity: HandoverEntity = { kind: 'character', id: c.id };
      const { kind: agent, sessionId, transcriptPath } = slot.agent;
      if (!transcriptPath) {
        blockers.push({ code: 'transcript_missing', message: `${c.name}'s ${term ? 'second ' : ''}${agent} session has recorded no transcript`, entity });
      } else if (CONTROL.test(transcriptPath) || !transcriptPath.startsWith('/')) {
        blockers.push({ code: 'path_unsupported', message: `the transcript ${JSON.stringify(transcriptPath)} cannot be carried`, entity });
      } else {
        const destinationHome = destination.agentHomes?.[agent];
        const destinationCwd = mapped(term ? c.second?.cwd ?? c.cwd : c.cwd, source.pathRoots, destination.pathRoots);
        sessions.push({ characterId: c.id, ...(term && { term }), agent, sessionId, sourcePath: transcriptPath, ...(destinationHome && { destinationHome }), ...(destinationCwd && { destinationCwd }) });
      }
    }
  }

  return {
    fromMachineId: source.machineId,
    toMachineId: destination.machineId,
    sourceRoots: source.pathRoots,
    ...(Object.keys(sourceReal).length && { sourceRealRoots: sourceReal }),
    destinationRoots: destination.pathRoots,
    fleet,
    snapshot,
    excludes,
    roots: roots.sort((a, b) => byCodeUnit(a.sourcePath, b.sourcePath)),
    sessions: sessions.sort((a, b) => byCodeUnit(a.characterId, b.characterId) || (a.term ?? 1) - (b.term ?? 1)),
    git: graphs,
    blockers: settle(blockers),
    warnings: settle(git?.warnings ?? []),
  };
}

/** A path spelled under the declared root whose real path holds it, the longest there is; a path no root holds that way keeps its spelling. */
const declared = (roots: PathRootMap) => (p: string): string => {
  try {
    const placed = realHoldingRoot(p, roots);
    return placed ? mapPortablePath(placed, roots) : p;
  } catch { return p; }
};

/** A graph named as the manifest keeps it: git names each place by its real path, spelled under a declared root. */
function declaredGraph(g: GitGraph, spell: (p: string) => string): GitGraph {
  const checkout = (c: GitCheckout): GitCheckout => ({ ...c, path: spell(c.path), gitDir: spell(c.gitDir) });
  return {
    ...g, commonDir: spell(g.commonDir), ...(g.main && { main: checkout(g.main) }),
    worktrees: g.worktrees.map(checkout), unused: g.unused.map((u) => ({ ...u, path: spell(u.path) })),
  };
}

// the cwd's own blocker already says why one does not map
function mapped(cwd: string, from: PathRootMap, to: PathRootMap): string | undefined {
  try { return mapPortablePath(locatePath(cwd, from).portable, to); } catch { return undefined; }
}

/**
 * Folds each root into the outermost carried root that copies its files to the same place, so a file is
 * sent once. A folded Git root stays listed for its own repair; any other folded root has nothing left to do.
 */
function fold(candidates: InventoryRoot[], excludes: readonly string[]): InventoryRoot[] {
  const carried: InventoryRoot[] = [];
  const out: InventoryRoot[] = [];
  const outerFirst = candidates.sort((a, b) => a.sourcePath.length - b.sourcePath.length || byCodeUnit(a.sourcePath, b.sourcePath));
  for (const root of outerFirst) {
    const outer = carried.find((o) => {
      if (!holds(o.sourcePath, root.sourcePath)) return false;
      const relative = path.posix.relative(o.sourcePath, root.sourcePath);
      const parts = relative.split('/');
      const excluded = rootMatcher(o.kind, excludes);
      if (parts.some((_, i) => excluded(parts.slice(0, i + 1).join('/'), i < parts.length - 1 || root.entry === 'dir'))) return false;
      return root.destinationPath === path.posix.join(o.destinationPath, relative);
    });
    if (!outer) { carried.push(root); out.push(root); }
    else if (isGit(root.kind)) out.push({ ...root, foldedInto: outer.id });
  }
  return out;
}

/** Blockers or warnings once each, in an order that does not depend on how they were found. */
export function settle<T extends Blocker>(issues: T[]): T[] {
  const once = new Map(issues.map((i) => [canonicalJson(i), i]));
  return [...once.entries()].sort(([a], [b]) => byCodeUnit(a, b)).map(([, i]) => i);
}
