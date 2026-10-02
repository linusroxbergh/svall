import fs from 'node:fs';
import type { AgentKind } from '@svall/protocol';
import { codexHookCommand, type CodexPaths } from './codex/install.js';
import { hooksFor } from './hooks/receiver.js';
import { helperBeside, helperOr, isOurs, resolvePaths } from './paths.js';
import { bundled, ownRuntime } from './runtime.js';
import { readJsonSettings, readOrUndefined, requireWritable, same, writeJsonSettings, type JsonSettings } from './settings-file.js';
import { shq, unshq } from './text.js';

type HookEntry = { type: string; command?: string; timeout?: number; async?: boolean; additionalContextLimit?: number };
type HookGroup = { matcher?: string; hooks?: HookEntry[] };
type StatusLine = { type?: string; command?: string };

// an entry from an earlier setup is rewritten whole, so a moved node, a changed command or a changed flag is repaired
function mergeOurHooks(settings: Record<string, unknown>, events: readonly string[], entryFor: (ev: string) => HookEntry, script: string, group: Omit<HookGroup, 'hooks'>): Record<string, unknown> {
  const out = structuredClone(settings);
  const hooks = ((out.hooks ??= {}) as Record<string, HookGroup[]>);
  for (const ev of events) {
    const groups = (hooks[ev] ??= []);
    const ours = groups.flatMap((g) => g.hooks ?? []).filter((h) => isOurs(h.command, script));
    for (const h of ours) { delete h.async; Object.assign(h, entryFor(ev)); }
    if (!ours.length) groups.push({ ...group, hooks: [entryFor(ev)] });
  }
  return out;
}

// any of the events will do; an event added since is left to the out-of-date checks
const holdsHook = (settings: Record<string, unknown>, events: readonly string[], script: string): boolean => {
  const hooks = (settings.hooks ?? {}) as Record<string, HookGroup[]>;
  return events.some((ev) => (hooks[ev] ?? []).some((g) => (g.hooks ?? []).some((h) => isOurs(h.command, script))));
};

// an event Claude Code need not wait on: it only says a subagent is gone. PermissionRequest waits, so a question
// is on record before the tool call its answer lets through
const ASYNC_HOOKS = new Set(['SubagentStop']);

export const mergeHooks = (settings: Record<string, unknown>, command: string, script: string, events: readonly string[] = hooksFor('claude')): Record<string, unknown> =>
  mergeOurHooks(settings, events, (ev) => ({ type: 'command', command, timeout: 10, ...(ASYNC_HOOKS.has(ev) && { async: true }) }), script, { matcher: '*' });

// SessionEnd and Interrupt are capped at 3 s. The two events the daemon answers carry the whole brief, which codex
// would otherwise cut to a preview past its spill threshold
const codexEntry = (ev: string, command: string): HookEntry => ({
  type: 'command', command, timeout: ev === 'SessionEnd' || ev === 'Interrupt' ? 3 : 10,
  ...(ev === 'SessionStart' || ev === 'UserPromptSubmit' ? { additionalContextLimit: 0 } : {}),
});

// a matcher is a regex on codex and is ignored outright for several events, so a match-all group has none
export const mergeCodexHooks = (current: Record<string, unknown>, command: string, script: string): Record<string, unknown> =>
  mergeOurHooks(current, hooksFor('codex'), (ev) => codexEntry(ev, command), script, {});

export const codexInstalled = (current: Record<string, unknown>, script: string): boolean => holdsHook(current, hooksFor('codex'), script);

export function unmergeHooks(settings: Record<string, unknown>, script: string): Record<string, unknown> {
  const out = structuredClone(settings);
  const hooks = out.hooks as Record<string, HookGroup[]> | undefined;
  if (!hooks || typeof hooks !== 'object') return out;
  const ours = (h: HookEntry) => isOurs(h.command, script);
  let removed = false;
  for (const [ev, groups] of Object.entries(hooks)) {
    if (!Array.isArray(groups) || !groups.some((g) => (g.hooks ?? []).some(ours))) continue;
    removed = true;
    const kept = groups.flatMap((g) => {
      if (!(g.hooks ?? []).some(ours)) return [g];
      const rest = g.hooks!.filter((h) => !ours(h));
      return rest.length ? [{ ...g, hooks: rest }] : [];
    });
    if (kept.length) hooks[ev] = kept; else delete hooks[ev];
  }
  // a hooks object the user left empty is theirs to keep; only one this call emptied goes
  if (removed && !Object.keys(hooks).length) delete out.hooks;
  return out;
}

/** Whether the Claude settings run the statusline and the hook script of the fleet at `home`. */
export function hooksInstalled(settings: Record<string, unknown>, home: string): boolean {
  const paths = resolvePaths(home);
  const status = (settings.statusLine as StatusLine | undefined)?.command ?? '';
  return ownHead(status, paths.statusScript) !== undefined && holdsHook(settings, hooksFor('claude'), paths.hookScript);
}

const WORD = String.raw`'(?:[^']|'\\'')*'`;
const escape = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
type Wrapped = { head: string; inner?: string };

// our wrapper of `script` at the top of `command`: all up to the script, then the command it wraps as one quoted word.
// the script inside a nested wrapper's quoted argument is followed by an escaped quote, so it never matches here
function ownWrapper(command: string, script: string): Wrapped | undefined {
  const m = new RegExp(String.raw`^([\s\S]*?${escape(shq(script))})(?: (${WORD}))?$`).exec(command);
  return m ? { head: m[1], inner: m[2] === undefined ? undefined : unshq(m[2]) } : undefined;
}

// the other variant's wrapper, which statusWrapper wrote
const OTHER = new RegExp(String.raw`^(svall_status\(\) \{ [\s\S]*? \}; svall_status ${WORD})(?: (${WORD}))?$`);
function otherWrapper(command: string): Wrapped | undefined {
  const m = OTHER.exec(command);
  return m ? { head: m[1], inner: m[2] === undefined ? undefined : unshq(m[2]) } : undefined;
}

// the second variant to set up goes inside the first one's wrapper, which keeps its place
function withStatus(command: string | undefined, wrapper: string, script: string): string {
  if (!command) return wrapper;
  const own = ownWrapper(command, script);
  if (own) return own.inner ? `${wrapper} ${shq(own.inner)}` : wrapper;
  const other = otherWrapper(command);
  if (other) return `${other.head} ${shq(withStatus(other.inner, wrapper, script))}`;
  return `${wrapper} ${shq(command)}`;
}

function withoutStatus(command: string, script: string): string | undefined {
  const own = ownWrapper(command, script);
  if (own) return own.inner;
  const other = otherWrapper(command);
  if (!other) return command;
  const inner = other.inner && withoutStatus(other.inner, script);
  return inner ? `${other.head} ${shq(inner)}` : other.head;
}

/** The part of the statusline that runs `script`, up to it, wherever in a chain of wrappers it sits. */
function ownHead(command: string | undefined, script: string): string | undefined {
  for (let c = command; c; c = otherWrapper(c)?.inner) {
    const own = ownWrapper(c, script);
    if (own) return own.head;
  }
  return undefined;
}

// Claude Code's context reading reaches the daemon only through its statusLine, so the user's own statusline becomes the
// wrapper's argument; an earlier wrapper is rebuilt around its inner command, inside the other variant's if there is one
export function mergeStatusLine(settings: Record<string, unknown>, wrapper: string, script: string): Record<string, unknown> {
  const out = structuredClone(settings);
  const current = out.statusLine as StatusLine | undefined;
  const command = current?.type === 'command' && current.command ? current.command : undefined;
  const next = withStatus(command, wrapper, script);
  if (command === next) return out;
  out.statusLine = { ...current, type: 'command', command: next };
  return out;
}

export function unmergeStatusLine(settings: Record<string, unknown>, script: string): Record<string, unknown> {
  const out = structuredClone(settings);
  const current = out.statusLine as StatusLine | undefined;
  if (current?.type !== 'command' || ownHead(current.command, script) === undefined) return out;
  const inner = withoutStatus(current.command!, script);
  if (inner) out.statusLine = { ...current, command: inner };
  else delete out.statusLine;
  return out;
}

// the node setup ran with, or the one on PATH once a version manager has removed it
export const nodeRun = (node: string, script: string): string => `n=${shq(node)}; [ -x "$n" ] || n=node; "$n" ${shq(script)}`;

// every Claude session on the machine runs the statusline, so outside a character, or once the script
// is gone, the one the user had runs on its own; inside one, the helper wraps it, or node where there is none
export const statusWrapper = (node: string, script: string): string => {
  const helper = helperBeside(script);
  return `svall_status() { if [ -n "$SVALL_CHAR_ID" ] && [ -x ${helper} ]; then shift; ${helper} status "$@"; elif [ -n "$SVALL_CHAR_ID" ] && [ -f "$1" ]; then n=${shq(node)}; [ -x "$n" ] || n=node; "$n" "$@"; elif [ -n "$2" ]; then c=$2; shift 2; eval "$c"; fi; }; svall_status ${shq(script)}`;
};

// outside a character the shell exits before anything starts, as every session on the machine runs this hook;
// $PPID is the agent, which tells it apart from a `claude -p` or `codex exec` run inside it
export const hookCommand = (node: string, script: string, backend: AgentKind): string =>
  `[ -z "$SVALL_CHAR_ID" ] || { ${helperOr(script, `${backend} "$PPID"`, nodeRun(node, script))}; }`;

/** Codex's hooks file when Codex is wanted here (on PATH, or its home exists); throws on one that is not JSON. */
export const readCodexHooks = (codex: CodexPaths, wanted = fs.existsSync(codex.dir)): JsonSettings | undefined =>
  (wanted ? readJsonSettings(codex.hooks) : undefined);

export const CODEX_TRUST = 'Codex asks once to trust these hooks: start codex and choose "Trust all and continue", or trust them in /hooks';

/** Writes the hooks into Codex's own file, when Codex is wanted here. */
export function installCodexHooks(script: string, before: JsonSettings | undefined): string[] {
  if (!before) return [];
  const wrote = writeJsonSettings(before, withCodexHooks(before.settings, script), 'codex hooks');
  return wrote.length ? [...wrote, CODEX_TRUST] : [];
}

/** Writes the hooks and the statusline into the Claude settings, when Claude is wanted here. */
export const installClaudeHooks = (home: string, before: JsonSettings | undefined): string[] =>
  (before ? writeJsonSettings(before, withClaudeHooks(before.settings, home), 'claude hooks and statusline') : []);

// the node the installed statusline names, while it is there: the commands fall back to the node on PATH,
// so svall running under another node is no reason to rewrite them
function installedNode(settings: Record<string, unknown>, script: string): string | undefined {
  const quoted = /\bn=('(?:[^']|'\\'')*'); \[ -x "\$n" \]/.exec(ownHead((settings.statusLine as StatusLine | undefined)?.command, script) ?? '')?.[1];
  if (!quoted) return undefined;
  try {
    fs.accessSync(unshq(quoted), fs.constants.X_OK);
    return unshq(quoted);
  } catch {
    return undefined;
  }
}

// the hooks and statusline setup writes into the Claude settings for the fleet at `home`
function withClaudeHooks(settings: Record<string, unknown>, home: string): Record<string, unknown> {
  const paths = resolvePaths(home);
  const node = ownRuntime().bundle ? process.execPath : installedNode(settings, paths.statusScript) ?? process.execPath;
  return mergeStatusLine(
    mergeHooks(settings, hookCommand(node, paths.hookScript, 'claude'), paths.hookScript),
    statusWrapper(node, paths.statusScript),
    paths.statusScript,
  );
}

const withCodexHooks = (current: Record<string, unknown>, script: string): Record<string, unknown> =>
  mergeCodexHooks(current, codexHookCommand(script, bundled ? process.execPath : undefined), script);

/** Whether the Claude settings already hold what setup would write for the fleet at `home`. */
export const claudeHooksCurrent = (settings: Record<string, unknown>, home: string): boolean => same(withClaudeHooks(settings, home), settings);

/** Whether Codex's hooks file already holds what setup would write for `script`. */
export const codexHooksCurrent = (current: Record<string, unknown>, script: string): boolean => same(withCodexHooks(current, script), current);

/** Throws, before anything is written, when the Claude settings or Codex's hooks need a change setup cannot write. */
export function requireWritableHooks(home: string, settings: JsonSettings | undefined, codexHooks: JsonSettings | undefined): void {
  if (settings) requireWritable(settings, withClaudeHooks(settings.settings, home));
  if (codexHooks) requireWritable(codexHooks, withCodexHooks(codexHooks.settings, resolvePaths(home).hookScript));
}

export type Removal = [JsonSettings, Record<string, unknown>, string];

/** What setup takes out of the files of agents turned off here, each file read and checked first; throws before anything is written. */
export function hookRemovals(o: { home: string; settingsPath: string; codex: CodexPaths; claudeWanted: boolean; codexWanted: boolean }): Removal[] {
  const paths = resolvePaths(o.home);
  const holdsOurs = (file: string): boolean => {
    const text = readOrUndefined(file) ?? '';
    return text.includes(paths.hookScript) || text.includes(paths.statusScript);
  };
  const removals: Removal[] = [];
  if (!o.claudeWanted && holdsOurs(o.settingsPath)) {
    const s = readJsonSettings(o.settingsPath);
    removals.push([s, unmergeStatusLine(unmergeHooks(s.settings, paths.hookScript), paths.statusScript), 'claude hooks removed']);
  }
  if (!o.codexWanted && holdsOurs(o.codex.hooks)) {
    const s = readJsonSettings(o.codex.hooks);
    removals.push([s, unmergeHooks(s.settings, paths.hookScript), 'codex hooks removed']);
  }
  for (const [current, next] of removals) requireWritable(current, next);
  return removals;
}
