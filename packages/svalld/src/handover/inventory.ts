import fs from 'node:fs';
import path from 'node:path';
import { defaultHome, type AgentKind, type Blocker, type FleetConfig, type FleetState, type GitGraph, type HandoverEntity, type MachineId, type TransferRoot, type TransferSession, type Warning } from '@svall/protocol';
import { peekConfig, readFleetConfig } from '../config.js';
import { resolvePaths } from '../paths.js';
import { shq } from '../text.js';
import { fleetHomes } from '../uninstall.js';
import type { GitDiscovery } from './git-graph.js';
import { byCodeUnit, canonicalJson, sha256Hex } from './hash.js';
import { exportSnapshot, holds, portablePathValues, realPath, type PathValue } from './portable-path.js';

/** Where one machine keeps what a handover moves: its home, this fleet's own home, where each agent's carried sessions land, and
 *  OpenCode's own folders where its environment puts them. */
export type MachineMap = { machineId: MachineId; home: string; fleetHome: string; agentHomes?: Partial<Record<AgentKind, string>>; opencode?: string[] };
export type MachineMaps = { source: MachineMap; destination: MachineMap };
export type InventoryConfigs = { fleet: FleetConfig };

export type InventoryRoot = Pick<TransferRoot, 'id' | 'kind' | 'entry' | 'path' | 'foldedInto'>;
export type InventorySession = Pick<TransferSession, 'characterId' | 'term' | 'agent' | 'sessionId' | 'sourcePath' | 'destinationHome'>;

/** What a handover would carry and from where to where, before a byte of it is read. */
export type Inventory = {
  fromMachineId: MachineId;
  toMachineId: MachineId;
  /** the home path both machines share */
  home: string;
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

/** Whether `excluded` drops a relative path, itself or through a folder above it; `dir` says the path is itself a folder. */
export function excludedPath(relative: string, excluded: (relative: string, dir: boolean) => boolean, dir = false): boolean {
  const parts = relative.split('/');
  return parts.some((_, i) => excluded(parts.slice(0, i + 1).join('/'), i < parts.length - 1 || dir));
}

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
const RANK: Kind[] = ['repo', 'worktree', 'gitdir', 'docs', 'profiles', 'home', 'cwd', 'context'];

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

const rootId = (p: string): string => `r_${sha256Hex(p).slice(0, 16)}`;
const isGit = (kind: Kind): boolean => kind === 'repo' || kind === 'worktree' || kind === 'gitdir';

type FleetHomes = { source: string; sourceReal: string; destination: string };

/**
 * The fleet home a root would carry or overwrite, if any: a fleet home holds its machine's token, keys,
 * journal and node.json. What of it travels, `travels`, lies inside it by design, and so may anything inside that.
 */
function fleetHomeClash(root: InventoryRoot, travels: readonly InventoryRoot[], homes: FleetHomes): string | undefined {
  const places: [home: string, named: string][] = [[homes.source, homes.source], [homes.sourceReal, homes.source], [homes.destination, homes.destination]];
  const held = places.find(([home]) => holds(root.path, home));
  if (held) return held[1];
  const inside = travels.some((t) => holds(t.path, root.path));
  return inside ? undefined : places.find(([home]) => holds(home, root.path))?.[1];
}

// the real path of mission control's folder in the fleet at `fleetHome`: ~/.svall/home unless a config it can read says otherwise
function missionOf(fleetHome: string, home: string): string | undefined {
  const paths = resolvePaths(fleetHome);
  let fleet: { home: { cwd: string } };
  try { fleet = fs.existsSync(paths.fleetConfig) ? readFleetConfig(paths) : peekConfig(paths); } catch { fleet = { home: defaultHome() }; }
  const cwd = portablePathValues({ FleetConfig: fleet }, home).find((v) => v.field === 'FleetConfig.home.cwd');
  return cwd && realPath(cwd.path);
}

/** Files a root may not hold, and folders it may neither hold nor lie in. */
export type MachineLocal = { files: string[]; dirs: string[] };

/**
 * What an account keeps for itself and a handover never carries or lands on: each agent's login and config, where the
 * environment puts them and where the default does, OpenCode's database, snapshots, config, state and cache whole, its ssh keys,
 * and Svall's own install, units and shims.
 */
export function machineLocal(m: Pick<MachineMap, 'home' | 'agentHomes' | 'opencode'>): MachineLocal {
  const at = (...p: string[]): string => path.posix.join(m.home, ...p);
  const claudes = [...new Set([at('.claude'), m.agentHomes?.claude ?? at('.claude')])];
  const codexes = [...new Set([at('.codex'), m.agentHomes?.codex ?? at('.codex')])];
  return {
    files: [
      at('.claude.json'), ...claudes.flatMap((d) => [path.posix.join(d, '.credentials.json'), path.posix.join(d, '.claude.json')]),
      ...codexes.map((d) => path.posix.join(d, 'auth.json')), at('.local', 'bin', 'svall'),
    ],
    dirs: [
      at('.ssh'), at('.local', 'share', 'svall'), at('.config', 'svall'), at('.config', 'systemd', 'user'),
      ...new Set([
        at('.local', 'share', 'opencode'), at('.config', 'opencode'), at('.local', 'state', 'opencode'), at('.cache', 'opencode'),
        ...(m.opencode ?? []),
      ]),
    ],
  };
}

function credentialClash(root: InventoryRoot, local: { files: string[]; dirs: string[] }): string | undefined {
  const held = [...local.files, ...local.dirs].find((p) => holds(root.path, p));
  if (held) return held === root.path ? `${root.path} stays on its machine` : `${root.path} holds ${held}, which stays on its machine`;
  const dir = local.dirs.find((d) => holds(d, root.path));
  return dir && `${root.path} lies in ${dir}, which stays on its machine`;
}

// what is on disk decides how a root folds; a path that is not there folds as a folder
function entryOf(p: string): InventoryRoot['entry'] {
  try { return fs.statSync(p).isDirectory() ? 'dir' : 'file'; } catch { return 'dir'; }
}

const characterOf = (v: PathValue): HandoverEntity | undefined =>
  (v.field.startsWith('FleetState.characters.') ? { kind: 'character', id: String(v.pointer[1]) } : undefined);

// a home path as a shell reads it, quoted only when it has to be
const word = (p: string): string => (/^[A-Za-z0-9_./-]+$/.test(p) ? p : shq(p));

/** The commands that give an account the home path `home`, for a message asking for one. */
export const homeCommands = (home: string): string =>
  `sudo mkdir -p ${word(path.posix.dirname(home))}, then sudo useradd -m -d ${word(home)} <user> for a new account, `
  + `or sudo usermod -d ${word(home)} -m <user> for an existing one you are not logged in as`;

/**
 * Everything a handover carries from `source` to `destination`, which share one home path: each working root
 * once, at the path it has on both machines, the transcript each agent recorded, and what stops the move. With
 * the discovered Git graphs, those graphs name every Git root; without them, the recorded repo fields do.
 */
export function buildInventory(state: FleetState, configs: InventoryConfigs, machineMaps: MachineMaps, git?: GitDiscovery): Inventory {
  const { source, destination } = machineMaps;
  const { home } = source;
  const snapshot = exportSnapshot(state);
  const fleet = structuredClone(configs.fleet);
  const { excludes, blockers } = expandExcludes(fleet.handover);
  if (destination.home !== home) {
    blockers.push({
      code: 'home_mismatch',
      message: `the destination's home is ${destination.home} and this machine's ${home}; a fleet moves only between accounts with the same home path. On the destination, ${homeCommands(home)}; then svall host remove <name>, svall host add at that account, and svall host enable <name> --fleet <fleet>`,
    });
  }
  blockers.push(...(git?.blockers ?? []));

  // a root travels at the path it was recorded by, so that path has to be the real one Git and the agents record
  const real = (p: string, entity: HandoverEntity | undefined): boolean => {
    if (CONTROL.test(p) || !p.startsWith('/')) {
      blockers.push({ code: 'path_unsupported', message: `${JSON.stringify(p)} ${p.startsWith('/') ? 'holds a control character' : 'is not absolute'}`, entity });
      return false;
    }
    const at = realPath(p);
    if (at === p) return true;
    const spelled = at.normalize('NFD').toLowerCase() === p.normalize('NFD').toLowerCase();
    blockers.push({
      code: 'path_symlinked', entity,
      message: `${p} ${spelled ? `is spelled ${at} on disk` : `leads to ${at} through a symbolic link`}; a handover carries each folder at its real path, the one Git and the agents record, so use ${at} instead`,
    });
    return false;
  };
  const graphs = git?.graphs ?? [];
  const candidates = new Map<string, InventoryRoot>();
  const offer = (p: string, kind: Kind): void => {
    // the home is on both machines already: standing in it, as a shell at ~ does, copies nothing
    if (p === home && !isGit(kind)) return;
    const had = candidates.get(p);
    if (had && RANK.indexOf(had.kind) <= RANK.indexOf(kind)) return;
    candidates.set(p, { id: rootId(p), kind, entry: entryOf(p), path: p });
  };

  for (const v of portablePathValues({ FleetState: snapshot, FleetConfig: fleet }, home)) {
    if (v.form === 'transcript') continue;
    let kind: Kind | undefined = ROOT_OF[v.field];
    if (kind === 'worktree' && !snapshot.characters[String(v.pointer[1])].repo?.isWorktree) kind = undefined;
    if (git && (kind === 'repo' || kind === 'worktree')) kind = undefined;
    if (kind && real(v.path, characterOf(v))) offer(v.path, kind);
  }
  for (const g of graphs) {
    const entity: HandoverEntity = { kind: 'git', id: g.id };
    const roots = g.worktrees.map((w): [string, Kind] => [w.path, 'worktree']);
    if (g.main) roots.push([g.main.path, 'repo']);
    if (!g.main || !holds(g.main.path, g.commonDir)) roots.push([g.commonDir, 'gitdir']);
    for (const [p, kind] of roots) if (real(p, entity)) offer(p, kind);
  }
  // the fleet's docs and agent profiles lie in its fleet home, and arrive at the same path in the destination's
  const own = resolvePaths(source.fleetHome);
  const theirs = resolvePaths(destination.fleetHome);
  for (const [kind, p, there, what] of [['docs', own.docs, theirs.docs, 'docs'], ['profiles', own.agentProfiles, theirs.agentProfiles, 'agent profiles']] as const) {
    if (!fs.existsSync(p)) continue;
    if (there !== p) blockers.push({ code: 'path_unsupported', message: `the destination keeps this fleet's ${what} at ${there}, not ${p}, so they cannot arrive at the same path` });
    else if (real(p, undefined)) offer(p, kind);
  }

  // of a fleet home, mission control's folder, the docs and the agent profiles travel, and the fleet .env below only when asked for
  const homes: FleetHomes = { source: path.posix.resolve(source.fleetHome), sourceReal: realPath(path.posix.resolve(source.fleetHome)), destination: path.posix.resolve(destination.fleetHome) };
  const placed = [...candidates.values()];
  const mission = placed.find((r) => r.kind === 'home' && !fleetHomeClash(r, [r], homes));
  if (mission) {
    for (const other of fleetHomes(home).filter((f) => realPath(f) !== homes.sourceReal && missionOf(f, home) === mission.path)) {
      blockers.push({
        code: 'mission_control_shared', entity: { kind: 'root', id: mission.id },
        message: `${mission.path} is mission control's folder for this fleet and for the fleet in ${other}, and a handover would move it away from that fleet; give one of them its own folder with home.cwd in its fleet.json`,
      });
    }
  }
  const travels = placed.filter((r) => r === mission || r.kind === 'docs' || r.kind === 'profiles');
  // the destination checks its own by real path when it claims a root
  const [here, there] = [machineLocal(source), machineLocal(destination)];
  const local = { files: [...new Set([...here.files.map((p) => realPath(p)), ...there.files])], dirs: [...new Set([...here.dirs.map((p) => realPath(p)), ...there.dirs])] };
  const allowed = placed.filter((r) => {
    const fleetHome = fleetHomeClash(r, travels, homes);
    if (fleetHome) blockers.push({ code: 'path_unsupported', message: `${r.path} overlaps the fleet home ${fleetHome}, whose token, keys and node.json stay on their machine`, entity: { kind: 'root', id: r.id } });
    const credential = fleetHome ? undefined : credentialClash(r, local);
    if (credential) blockers.push({ code: 'path_unsupported', message: credential, entity: { kind: 'root', id: r.id } });
    return !fleetHome && !credential;
  });

  const roots = fold(allowed, excludes, blockers);
  if (fleet.handover.transferFleetEnv) {
    const env = resolvePaths(source.fleetHome).env;
    const there = resolvePaths(destination.fleetHome).env;
    if (there === env) roots.push({ id: rootId(env), kind: 'env', entry: 'file', path: env });
    else blockers.push({ code: 'path_unsupported', message: `the destination keeps this fleet's .env at ${there}, not ${env}, so it cannot arrive at the same path` });
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
        sessions.push({ characterId: c.id, ...(term && { term }), agent, sessionId, sourcePath: transcriptPath, ...(destinationHome && { destinationHome }) });
      }
    }
  }

  return {
    fromMachineId: source.machineId,
    toMachineId: destination.machineId,
    home,
    fleet,
    snapshot,
    excludes,
    roots: roots.sort((a, b) => byCodeUnit(a.path, b.path)),
    sessions: sessions.sort((a, b) => byCodeUnit(a.characterId, b.characterId) || (a.term ?? 1) - (b.term ?? 1)),
    git: graphs,
    blockers: settle(blockers),
    warnings: settle(git?.warnings ?? []),
  };
}

/**
 * Folds each root into the outermost carried root that copies its files, so a file is sent once. A folded Git
 * root stays listed for the Git import to check; any other folded root has nothing left to do. A folded Git
 * directory whose Git entries the outer root's excludes would leave behind adds a blocker.
 */
function fold(candidates: InventoryRoot[], excludes: readonly string[], blockers: Blocker[]): InventoryRoot[] {
  const carried: InventoryRoot[] = [];
  const out: InventoryRoot[] = [];
  const outerFirst = candidates.sort((a, b) => a.path.length - b.path.length || byCodeUnit(a.path, b.path));
  for (const root of outerFirst) {
    const outer = carried.find((o) => {
      if (!holds(o.path, root.path)) return false;
      return !excludedPath(path.posix.relative(o.path, root.path), rootMatcher(o.kind, excludes), root.entry === 'dir');
    });
    if (!outer) { carried.push(root); out.push(root); continue; }
    if (!isGit(root.kind)) continue;
    out.push({ ...root, foldedInto: outer.id });
    const left = root.kind === 'gitdir' ? gitLeft(root.path, path.posix.relative(outer.path, root.path), rootMatcher(outer.kind, excludes)) : [];
    if (left.length) {
      const shown = left.slice(0, 5).join(', ') + (left.length > 5 ? `, and ${left.length - 5} more` : '');
      blockers.push({
        code: 'path_unsupported', entity: { kind: 'root', id: root.id },
        message: `${root.path}: ${outer.path} carries this Git directory under the fleet's excludes, which would leave behind ${shown}; move the repository out of ${outer.path}, or take the pattern that matches out of handover.exclude in fleet.json (with excludeDefaults: false for a default one)`,
      });
    }
  }
  return out;
}

/** Git's own entries in the Git directory `dir` that `excluded` leaves out, read at `from` inside the folder that carries it; a folder left out is named, not what it holds. */
function gitLeft(dir: string, from: string, excluded: (relative: string, dir: boolean) => boolean): string[] {
  const left: string[] = [];
  const walk = (rel: string): void => {
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(path.posix.join(dir, rel), { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (!rel && !(GIT_DIR_ENTRIES as readonly string[]).includes(e.name)) continue;
      const at = rel ? `${rel}/${e.name}` : e.name;
      if (excluded(`${from}/${at}`, e.isDirectory())) left.push(at);
      else if (e.isDirectory()) walk(at);
    }
  };
  walk('');
  return left.sort(byCodeUnit);
}

/** Blockers or warnings once each, in an order that does not depend on how they were found. */
export function settle<T extends Blocker>(issues: T[]): T[] {
  const once = new Map(issues.map((i) => [canonicalJson(i), i]));
  return [...once.entries()].sort(([a], [b]) => byCodeUnit(a, b)).map(([, i]) => i);
}
