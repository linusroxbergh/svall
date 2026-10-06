import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FleetState } from '@svall/protocol';

const trim = (p: string): string => (p.length > 1 && p.endsWith('/') ? p.slice(0, -1) : p);

/** Whether `p` is `root` or lies under it, on a component boundary. */
export const holds = (root: string, p: string): boolean => p === root || p.startsWith(root === '/' ? '/' : `${root}/`);

/** The real path of `p`, spelled as the disk stores it, or of the deepest part of it that exists with the rest joined back on. */
export function realPath(p: string, realpath: (p: string) => string = (q) => fs.realpathSync.native(q)): string {
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

/**
 * What a handover does with a field that holds a path: `portable` names a place the fleet uses, which travels as it
 * is and whose folder the handover carries, `machine-local` names a place on one machine only or what that machine
 * found there, `forbidden` is a handle on a process, a pid, a tmux id or what a pane shows, removed before a record
 * leaves its machine.
 */
export type PathClassification = 'portable' | 'machine-local' | 'forbidden';

/**
 * How a portable field holds its path: `path` absolute, `home` absolute or `~`-relative, `context` a
 * ref that is a path only for a file or folder item, `file-url` a URL that is a path only when file:,
 * `transcript` an agent session file its session carries.
 */
export type PortableForm = 'path' | 'home' | 'context' | 'file-url' | 'transcript';

export type PathField = { classification: 'portable'; form: PortableForm } | { classification: 'machine-local' | 'forbidden' };

const portable = (form: PortableForm): PathField => ({ classification: 'portable', form });
const LOCAL: PathField = { classification: 'machine-local' };
const FORBIDDEN: PathField = { classification: 'forbidden' };

/**
 * Every path field of the schemas a handover reads, writes or carries, and every field bound to one machine or
 * process. A name is the schema, then `*` for a record's values and `[]` for an array's items; an entry covers
 * every field beneath it.
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
  'FleetState.characters.*.agent.pid': FORBIDDEN,
  'FleetState.characters.*.second.agent.pid': FORBIDDEN,
  // what a live window shows: codex running there without a hook
  'FleetState.characters.*.hint': FORBIDDEN,
  // the agent CLIs this machine's svalld finds; the destination finds its own when it activates
  'FleetState.agentsFound': LOCAL,
  'FleetConfig.home.cwd': portable('home'),
  'FleetConfig.defaultCwd': portable('home'),
  'NodeConfig.shell': LOCAL,
  'MachineRecord.home': LOCAL,
  'MachineRecord.svallBase': LOCAL,
  'TransferManifestV1.home': LOCAL,
  'TransferManifestV1.git[].commonDir': LOCAL,
  'TransferManifestV1.git[].main.path': LOCAL,
  'TransferManifestV1.git[].main.gitDir': LOCAL,
  'TransferManifestV1.git[].worktrees[].path': LOCAL,
  'TransferManifestV1.git[].worktrees[].gitDir': LOCAL,
  'TransferManifestV1.git[].unused[].path': LOCAL,
  'TransferManifestV1.roots[].path': LOCAL,
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
  'FleetState.characters.*.agent.asking[]', 'FleetState.characters.*.agent.askedTool',
  'FleetState.characters.*.revive.command', 'FleetState.characters.*.restedBy', 'FleetState.characters.*.second.restedBy',
  'FleetState.characters.*.resumeError', 'FleetState.characters.*.second.resumeError',
  'FleetState.characters.*.browser.tabs[].id', 'FleetState.characters.*.browser.tabs[].title', 'FleetState.characters.*.browser.active',
  'FleetState.characters.*.second.agent.sessionId', 'FleetState.characters.*.second.agent.model', 'FleetState.characters.*.second.agent.brief',
  'FleetState.characters.*.second.agent.prompt', 'FleetState.characters.*.second.agent.promptId', 'FleetState.characters.*.second.agent.lastPrompt.id',
  'FleetState.characters.*.second.agent.lastPrompt.text', 'FleetState.characters.*.second.agent.asking[]', 'FleetState.characters.*.second.agent.askedTool',
  'FleetState.characters.*.second.revive.command',
  'FleetState.name', 'FleetState.home.command', 'FleetState.home.actions[].label', 'FleetState.home.actions[].prompt', 'FleetState.scribeError.message',
  'FleetConfig.id', 'FleetConfig.name', 'FleetConfig.gatewayMachineId', 'FleetConfig.home.command', 'FleetConfig.home.actions[].label',
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

/**
 * The numbers, flags and choices of the state and fleet.json that name nothing bound to one machine or process:
 * layout, times, statuses and settings. Those that do are in PATH_FIELDS, and leave with the state stripped of them.
 */
export const NOT_BOUND: readonly string[] = [
  'FleetState.version', 'FleetState.islands.*.position', 'FleetState.islands.*.size', 'FleetState.islands.*.seed',
  'FleetState.islands.*.collapsed', 'FleetState.islands.*.kind', 'FleetState.islands.*.descriptionSource', 'FleetState.islands.*.order',
  'FleetState.islands.*.context[].kind', 'FleetState.islands.*.context[].source', 'FleetState.islands.*.context[].pinned', 'FleetState.islands.*.context[].prState',
  'FleetState.characters.*.cell', 'FleetState.characters.*.noteSource', 'FleetState.characters.*.portrait', 'FleetState.characters.*.repo.isWorktree',
  'FleetState.characters.*.context[].kind', 'FleetState.characters.*.context[].source', 'FleetState.characters.*.context[].pinned', 'FleetState.characters.*.context[].prState',
  'FleetState.characters.*.shell.lastOutputAt', 'FleetState.characters.*.unread', 'FleetState.characters.*.keepHere', 'FleetState.characters.*.worktree',
  'FleetState.characters.*.revive.interrupted', 'FleetState.characters.*.second.revive.interrupted',
  'FleetState.characters.*.agent.kind', 'FleetState.characters.*.agent.status', 'FleetState.characters.*.agent.contextPct', 'FleetState.characters.*.agent.background',
  'FleetState.characters.*.agent.lastPrompt.at', 'FleetState.characters.*.agent.lastActivityAt',
  'FleetState.characters.*.second.unread', 'FleetState.characters.*.second.agent.kind', 'FleetState.characters.*.second.agent.status',
  'FleetState.characters.*.second.agent.contextPct', 'FleetState.characters.*.second.agent.background', 'FleetState.characters.*.second.agent.lastPrompt.at',
  'FleetState.characters.*.second.agent.lastActivityAt',
  'FleetState.scribeOff', 'FleetState.scribeAsk', 'FleetState.scribeError.at', 'FleetState.worktreesOff', 'FleetState.dormantAfterHours', 'FleetState.mainAgent', 'FleetState.scribeAgent',
  'FleetConfig.mainAgent', 'FleetConfig.scribe.agent', 'FleetConfig.handover.enabled', 'FleetConfig.handover.excludeDefaults', 'FleetConfig.handover.transferFleetEnv',
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

/** The state as it may leave this machine: a copy with every forbidden and machine-local field removed. */
export function exportSnapshot(state: FleetState): FleetState {
  const copy = structuredClone(state);
  for (const [field, spec] of Object.entries(PATH_FIELDS)) {
    if (spec.classification === 'portable' || !field.startsWith('FleetState.')) continue;
    for (const { parent, key } of fieldValues(copy, field)) delete parent[key];
  }
  return copy;
}
