import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { FleetState, PathRootMap } from '@archipelago/protocol';

/** A path as it travels between machines: a root name every machine defines, and what sits under it. */
export type PortablePath = { root: string; relative: string };

export class PathRootError extends Error { code = 'invalid'; }

const unsafe = (p: string): boolean => p.includes('\0') || p.includes('\n');
const trim = (p: string): string => (p.length > 1 && p.endsWith('/') ? p.slice(0, -1) : p);

/** Whether `p` is `root` or lies under it, on a component boundary. */
export const holds = (root: string, p: string): boolean => p === root || p.startsWith(root === '/' ? '/' : `${root}/`);

/** The real path of `p`, or of the deepest part of it that exists with the rest joined back on. */
export function realPath(p: string, realpath: (p: string) => string = (q) => fs.realpathSync(q)): string {
  const tail: string[] = [];
  let head = p;
  for (;;) {
    try { return path.posix.join(realpath(head), ...tail); } catch { /* keep walking up */ }
    const parent = path.posix.dirname(head);
    if (parent === head) return p;
    tail.unshift(path.posix.basename(head));
    head = parent;
  }
}

/** The real path of each root declared through a link; a root that is its own real path, or is not there, is left out. */
export function realRoots(roots: PathRootMap, realpath: (p: string) => string = (q) => fs.realpathSync(q)): PathRootMap {
  return Object.fromEntries(Object.entries(roots).flatMap(([name, dir]): [string, string][] => {
    const lexical = trim(path.posix.normalize(dir));
    let at: string;
    try { at = realpath(lexical); } catch { return []; }
    return at === lexical ? [] : [[name, at]];
  }));
}

/** Which declared root holds this path as written, and where under it. The longest match on a component boundary wins. */
export function holdingRoot(absolute: string, roots: PathRootMap): PortablePath | undefined {
  return longestHolding(trim(path.posix.normalize(absolute)), Object.entries(roots).map(([name, dir]) => [name, trim(path.posix.normalize(dir))]));
}

/** Which declared root holds this path by real path, and where under it: the longest real path of a root that holds its real path. */
export function realHoldingRoot(absolute: string, roots: PathRootMap, realpath: (p: string) => string = (q) => fs.realpathSync(q)): PortablePath | undefined {
  const dirs = Object.entries(roots).flatMap(([name, dir]): [string, string][] => {
    try { return [[name, trim(realpath(trim(path.posix.normalize(dir))))]]; } catch { return []; }
  });
  return longestHolding(realPath(trim(path.posix.normalize(absolute)), realpath), dirs);
}

function longestHolding(p: string, dirs: [name: string, dir: string][]): PortablePath | undefined {
  const match = dirs.sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0])).find(([, dir]) => holds(dir, p));
  if (!match) return undefined;
  const [name, dir] = match;
  return { root: name, relative: p === dir ? '' : p.slice(dir === '/' ? 1 : dir.length + 1) };
}

/** Which root holds this absolute path, and where under it, with its real path held inside that root too. */
export function resolvePortablePath(absolute: string, roots: PathRootMap): PortablePath {
  return locatePath(absolute, roots).portable;
}

/** What `resolvePortablePath` answers, with the real path it held inside the root. */
export function locatePath(absolute: string, roots: PathRootMap): { portable: PortablePath; real: string } {
  if (unsafe(absolute)) throw new PathRootError('a path may not contain a NUL or newline');
  if (!absolute.startsWith('/')) throw new PathRootError(`${absolute} is not absolute`);
  const lexical = trim(path.posix.normalize(absolute));
  if (lexical.split('/').includes('..')) throw new PathRootError(`${absolute} climbs out of its own path`);

  const portable = holdingRoot(lexical, roots);
  if (!portable) throw new PathRootError(`no path root holds ${absolute}`);
  const dir = trim(path.posix.normalize(roots[portable.root]));
  let real: string;
  try { real = fs.realpathSync(dir); } catch { throw new PathRootError(`the path root ${portable.root} (${dir}) does not exist`); }
  const target = realPath(lexical);
  if (!holds(real, target)) throw new PathRootError(`${absolute} leaves the path root ${portable.root}`);
  return { portable, real: target };
}

/** Where a portable path lands on the machine that declares these roots. */
export function mapPortablePath(portable: PortablePath, roots: PathRootMap): string {
  const dir = roots[portable.root];
  if (dir === undefined) throw new PathRootError(`no path root named ${portable.root}`);
  const { relative } = portable;
  if (unsafe(relative)) throw new PathRootError('a path may not contain a NUL or newline');
  if (relative.startsWith('/')) throw new PathRootError(`${relative} is not relative to a root`);
  const lexical = relative === '' ? '' : path.posix.normalize(relative);
  if (lexical.split('/').includes('..')) throw new PathRootError(`${relative} climbs out of the root ${portable.root}`);
  return trim(path.posix.join(trim(path.posix.normalize(dir)), lexical));
}

/**
 * What a handover does with a field that holds a path: `portable` is rewritten through the path roots,
 * `machine-local` names a place on one machine and is never rewritten, `forbidden` is a machine-bound
 * handle removed before a record leaves its machine.
 */
export type PathClassification = 'portable' | 'machine-local' | 'forbidden';

/**
 * How a portable field holds its path: `path` absolute, `home` absolute or `~`-relative, `context` a
 * ref that is a path only for a file or folder item, `file-url` a URL that is a path only when file:,
 * `transcript` an agent session file its adapter places.
 */
export type PortableForm = 'path' | 'home' | 'context' | 'file-url' | 'transcript';

export type PathField = { classification: 'portable'; form: PortableForm } | { classification: 'machine-local' | 'forbidden' };

const portable = (form: PortableForm): PathField => ({ classification: 'portable', form });
const LOCAL: PathField = { classification: 'machine-local' };
const FORBIDDEN: PathField = { classification: 'forbidden' };

/**
 * Every path field of the schemas a handover reads, writes or carries. A name is the schema, then `*`
 * for a record's values and `[]` for an array's items; an entry covers every field beneath it.
 */
export const PATH_FIELDS: Record<string, PathField> = {
  'FleetState.characters.*.cwd': portable('path'),
  'FleetState.characters.*.repo.root': portable('path'),
  'FleetState.characters.*.repo.mainRoot': portable('path'),
  'FleetState.characters.*.context[].ref': portable('context'),
  'FleetState.characters.*.agent.transcriptPath': portable('transcript'),
  'FleetState.characters.*.browser.tabs[].url': portable('file-url'),
  'FleetState.characters.*.second.cwd': portable('path'),
  'FleetState.characters.*.second.agent.transcriptPath': portable('transcript'),
  'FleetState.islands.*.context[].ref': portable('context'),
  'FleetState.home.cwd': portable('home'),
  'FleetState.defaultCwd': portable('home'),
  'FleetState.characters.*.tmux': FORBIDDEN,
  'FleetState.characters.*.panePath': FORBIDDEN,
  'FleetState.characters.*.second.tmux': FORBIDDEN,
  'FleetConfig.home.cwd': portable('home'),
  'FleetConfig.defaultCwd': portable('home'),
  'NodeConfig.shell': LOCAL,
  'MachineRecord.home': LOCAL,
  'MachineRecord.archiBase': LOCAL,
  'MachineRecord.pathRoots.*': LOCAL,
  'TransferManifestV1.sourceRoots.*': LOCAL,
  'TransferManifestV1.sourceRealRoots.*': LOCAL,
  'TransferManifestV1.destinationRoots.*': LOCAL,
  'TransferManifestV1.git[].commonDir': LOCAL,
  'TransferManifestV1.git[].main.path': LOCAL,
  'TransferManifestV1.git[].main.gitDir': LOCAL,
  'TransferManifestV1.git[].worktrees[].path': LOCAL,
  'TransferManifestV1.git[].worktrees[].gitDir': LOCAL,
  'TransferManifestV1.git[].unused[].path': LOCAL,
  'TransferManifestV1.roots[].sourcePath': LOCAL,
  'TransferManifestV1.roots[].destinationPath': LOCAL,
  'TransferManifestV1.roots[].files[].target': LOCAL,
  'TransferManifestV1.sessions[].sourcePath': LOCAL,
  'TransferManifestV1.sessions[].destinationPath': LOCAL,
  'TransferManifestV1.sessions[].sourceHome': LOCAL,
  'TransferManifestV1.sessions[].destinationHome': LOCAL,
  'TransferManifestV1.sessions[].files[].target': LOCAL,
};

/** The string fields of the same schemas that hold no absolute path: ids, names, text, commands, patterns and root-relative paths. */
export const NOT_PATHS: readonly string[] = [
  'FleetState.islands.*.id', 'FleetState.islands.*.name', 'FleetState.islands.*.description', 'FleetState.islands.*.instructions',
  'FleetState.islands.*.context[].label',
  'FleetState.characters.*.id', 'FleetState.characters.*.islandId', 'FleetState.characters.*.name', 'FleetState.characters.*.note',
  'FleetState.characters.*.instructions', 'FleetState.characters.*.agentProfile', 'FleetState.characters.*.repo.branch',
  'FleetState.characters.*.context[].label',
  'FleetState.characters.*.agent.sessionId', 'FleetState.characters.*.agent.model', 'FleetState.characters.*.agent.brief',
  'FleetState.characters.*.agent.prompt', 'FleetState.characters.*.agent.promptId', 'FleetState.characters.*.agent.lastPrompt.id', 'FleetState.characters.*.agent.lastPrompt.text',
  'FleetState.characters.*.revive.command', 'FleetState.characters.*.restedBy', 'FleetState.characters.*.second.restedBy',
  'FleetState.characters.*.resumeError', 'FleetState.characters.*.second.resumeError',
  'FleetState.characters.*.browser.tabs[].id', 'FleetState.characters.*.browser.tabs[].title', 'FleetState.characters.*.browser.active',
  'FleetState.characters.*.second.agent.sessionId', 'FleetState.characters.*.second.agent.model', 'FleetState.characters.*.second.agent.brief',
  'FleetState.characters.*.second.agent.prompt', 'FleetState.characters.*.second.agent.promptId', 'FleetState.characters.*.second.agent.lastPrompt.id',
  'FleetState.characters.*.second.agent.lastPrompt.text', 'FleetState.characters.*.second.revive.command',
  'FleetState.home.command', 'FleetState.home.actions[].label', 'FleetState.home.actions[].prompt', 'FleetState.scribeError.message',
  'FleetConfig.id', 'FleetConfig.gatewayMachineId', 'FleetConfig.home.command', 'FleetConfig.home.actions[].label',
  'FleetConfig.home.actions[].prompt', 'FleetConfig.scribe.model', 'FleetConfig.linear.workspace', 'FleetConfig.linear.teamKeys[]',
  'FleetConfig.mobile.logins[]', 'FleetConfig.mobile.origins[]', 'FleetConfig.mobile.pushContact', 'FleetConfig.handover.exclude[]',
  'NodeConfig.host',
  'MachineRecord.name', 'MachineRecord.ssh', 'MachineRecord.arch',
  'TransferManifestV1.transactionId', 'TransferManifestV1.fromMachineId', 'TransferManifestV1.toMachineId', 'TransferManifestV1.excludes[]',
  'TransferManifestV1.roots[].id', 'TransferManifestV1.roots[].foldedInto',
  'TransferManifestV1.roots[].files[].path', 'TransferManifestV1.roots[].files[].sha256',
  'TransferManifestV1.sessions[].characterId', 'TransferManifestV1.sessions[].sessionId',
  'TransferManifestV1.sessions[].files[].path', 'TransferManifestV1.sessions[].files[].sha256',
  'TransferManifestV1.roots[].files[].gitIndex', 'TransferManifestV1.sessions[].files[].gitIndex',
  'TransferManifestV1.git[].id', 'TransferManifestV1.git[].stash[]', 'TransferManifestV1.git[].tips[]',
  'TransferManifestV1.git[].main.head', 'TransferManifestV1.git[].main.branch', 'TransferManifestV1.git[].main.locked',
  'TransferManifestV1.git[].main.status[]', 'TransferManifestV1.git[].main.index', 'TransferManifestV1.git[].main.characters[]',
  'TransferManifestV1.git[].worktrees[].head', 'TransferManifestV1.git[].worktrees[].branch', 'TransferManifestV1.git[].worktrees[].locked',
  'TransferManifestV1.git[].worktrees[].status[]', 'TransferManifestV1.git[].worktrees[].index', 'TransferManifestV1.git[].worktrees[].characters[]',
  'TransferManifestV1.git[].unused[].head', 'TransferManifestV1.git[].unused[].branch', 'TransferManifestV1.git[].unused[].locked',
];

type Found = { pointer: (string | number)[]; value: unknown; parent: Record<string | number, unknown>; key: string | number };

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;

/** Every value a registered field name reaches inside `doc`, with where it sits. */
export function fieldValues(doc: unknown, field: string): Found[] {
  let at: { pointer: Found['pointer']; value: unknown; parent?: Found['parent']; key?: Found['key'] }[] = [{ pointer: [], value: doc }];
  for (const segment of field.split('.').slice(1)) {
    const next: typeof at = [];
    for (const { pointer, value } of at) {
      if (!isRecord(value)) continue;
      if (segment === '*') {
        for (const [k, v] of Object.entries(value)) next.push({ pointer: [...pointer, k], value: v, parent: value, key: k });
        continue;
      }
      const array = segment.endsWith('[]');
      const key = array ? segment.slice(0, -2) : segment;
      const held = value[key];
      if (held === undefined) continue;
      if (!array) next.push({ pointer: [...pointer, key], value: held, parent: value, key });
      else if (Array.isArray(held)) held.forEach((v, i) => next.push({ pointer: [...pointer, key, i], value: v, parent: held as unknown as Found['parent'], key: i }));
    }
    at = next;
  }
  return at as Found[];
}

/** One path a portable field names, absolute on the machine it was read on. */
export type PathValue = { field: string; pointer: Found['pointer']; form: PortableForm; path: string };

const clean = (p: string): string => trim(path.posix.normalize(p));

function pathOf(form: PortableForm, found: Found, home: string | undefined): string | undefined {
  const { value, parent } = found;
  if (typeof value !== 'string') return undefined;
  const expanded = home !== undefined && (value === '~' || value.startsWith('~/')) ? path.posix.join(home, value.slice(1)) : value;
  if (form === 'context') return parent.kind === 'file' || parent.kind === 'folder' ? clean(expanded) : undefined;
  if (form === 'file-url') {
    if (!value.startsWith('file:')) return undefined;
    // a file: URL naming another host is no path on this machine
    try { return clean(fileURLToPath(value)); } catch { return undefined; }
  }
  return clean(form === 'transcript' ? value : expanded);
}

/** Every path the portable fields of these records name, with `~` read against `home`. */
export function portablePathValues(docs: { FleetState?: FleetState; FleetConfig?: unknown }, home: string | undefined): PathValue[] {
  const out: PathValue[] = [];
  for (const [field, spec] of Object.entries(PATH_FIELDS)) {
    if (spec.classification !== 'portable') continue;
    const doc = docs[field.slice(0, field.indexOf('.')) as keyof typeof docs];
    if (doc === undefined) continue;
    for (const found of fieldValues(doc, field)) {
      const p = pathOf(spec.form, found, home);
      if (p !== undefined) out.push({ field, pointer: found.pointer, form: spec.form, path: p });
    }
  }
  return out;
}

/** The state as it may leave this machine: a copy with every forbidden field and every agent pid removed. */
export function exportSnapshot(state: FleetState): FleetState {
  const copy = structuredClone(state);
  for (const [field, spec] of Object.entries(PATH_FIELDS)) {
    if (spec.classification !== 'forbidden' || !field.startsWith('FleetState.')) continue;
    for (const { parent, key } of fieldValues(copy, field)) delete parent[key];
  }
  for (const c of Object.values(copy.characters)) { delete c.agent?.pid; delete c.second?.agent?.pid; }
  return copy;
}

/**
 * Writes `mapped` where a path value sits in the records it was read from, in the form it was written in: `~` stays `~`
 * while it lands under the home root, a file: URL keeps its query and fragment.
 */
export function rewrite(docs: Record<string, unknown>, v: PathValue, mapped: string, home: string): void {
  let at = docs[v.field.slice(0, v.field.indexOf('.'))] as Record<string | number, unknown>;
  for (const k of v.pointer.slice(0, -1)) at = at[k] as Record<string | number, unknown>;
  const key = v.pointer[v.pointer.length - 1];
  const original = at[key] as string;
  if (v.form === 'file-url') {
    const url = new URL(original);
    url.pathname = pathToFileURL(mapped).pathname;
    at[key] = url.href;
    return;
  }
  const root = path.posix.normalize(home);
  at[key] = (original === '~' || original.startsWith('~/')) && holds(root, mapped) ? path.posix.join('~', path.posix.relative(root, mapped)) : mapped;
}
