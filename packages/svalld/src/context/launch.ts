import fs from 'node:fs';
import path from 'node:path';
import type { AgentKind, ContextItem } from '@svall/protocol';
import { opencodeSvallRules } from '../svall-permissions.js';
import { shq } from '../text.js';

// the folder access an OpenCode launch sets ahead of its command
const ACCESS = /^\s*OPENCODE_CONFIG_CONTENT='(?:[^']|'\\'')*'\s+/;
// OpenCode marks links as OSC 8 only for a terminal it trusts with them, which tmux is not; a click on a link Ghostty
// can't see, a label or a wrapped URL's tail, then reaches OpenCode, which opens it itself instead of Svall asking
const HYPERLINKS = /^\s*(?:FORCE_HYPERLINK=1\s+(?=opencode(\s|$)))?/;

// the agent a command starts, as fleet.json may write it with a stray leading space
export const agentKindOf = (command: string): AgentKind | undefined =>
  /^\s*(claude|codex|opencode)(\s|$)/.exec(command.replace(ACCESS, '').replace(HYPERLINKS, ''))?.[1] as AgentKind | undefined;

export const isAgentCommand = (command: string): boolean => agentKindOf(command) !== undefined;

// an agent command gains access to every folder item and every file item's folder: claude and codex as --add-dir,
// opencode, which has no such flag, as permission rules
export function withAddDirs(command: string, items: ContextItem[], svallPermissions = false): string {
  const kind = agentKindOf(command);
  const dirs = [...new Set(items.flatMap((it) => (it.kind === 'folder' ? [it.ref] : it.kind === 'file' ? [path.dirname(it.ref)] : [])))];
  if (!kind || !dirs.length) return command;
  if (kind === 'opencode') {
    // OpenCode reads * and ? in a rule as wildcards, with no way to escape one, so such a folder is left to ask
    const rules = dirs.filter((d) => !/[*?]/.test(d)).map((d) => ({ action: 'external_directory', resource: path.join(path.resolve(d), '*'), effect: 'allow' }));
    if (!rules.length) return command;
    // this config loads last, so its rules follow the user's top-level ones and win; an agent's own rules still come after
    return `OPENCODE_CONFIG_CONTENT=${shq(JSON.stringify({ permissions: [...rules, ...(svallPermissions ? opencodeSvallRules() : [])] }))} ${command}`;
  }
  return dirs.reduce((cmd, d) => `${cmd} --add-dir ${shq(d)}`, command);
}

// a command with its quoted words emptied, so a flag inside one is no flag
const unquoted = (command: string): string => command.replace(/\\.|'[^']*'|"(?:[^"\\]|\\.)*"/g, "''");

// a TUI on the user's shared server gets the environment of whoever started it, not the robot's; one on a server the
// user names keeps it. Codex's update picker on start would take the keys of a launch nobody watches
export function withStandalone(command: string): string {
  if (agentKindOf(command) === 'codex') {
    return /\s--(no-daemon|remote)(\s|=|$)/.test(unquoted(command)) ? command : command.replace(/^\s*codex(\s+(resume|fork)(?=\s|$))?/, '$& --no-daemon -c check_for_update_on_startup=false');
  }
  if (agentKindOf(command) !== 'opencode') return command;
  const access = ACCESS.exec(command)?.[0] ?? '';
  const rest = command.slice(access.length).replace(HYPERLINKS, '');
  return `${access}FORCE_HYPERLINK=1 ${/\s--(standalone|server)(\s|=|$)/.test(unquoted(rest)) ? rest : rest.replace(/^\s*opencode/, '$& --standalone')}`;
}

// a revive saved under OpenCode 1 may carry -m or --agent, which 2's TUI refuses; dormancy saved their values plain
export const withoutV1Flags = (revive: string): string =>
  agentKindOf(revive) === 'opencode' ? revive.replace(/\s(?:-m|--model|--agent)(?:=\S+|\s+\S+)/g, '') : revive;

// OpenCode's TUI holds back the submit of a /command while its command menu is open, which a space after the name closes
export const promptText = (command: string, prompt: string): string =>
  agentKindOf(command) === 'opencode' && /^\/\S+$/.test(prompt.trim()) ? `${prompt.trim()} ` : prompt;

// a word sh, bash, zsh and fish all read as `s`: fish reads \\ and \' inside single quotes, so each ' and \ goes outside them
const anyShq = (s: string): string =>
  s.split(/(['\\])/).map((p, i) => (i % 2 ? `\\${p}` : p && `'${p}'`)).join('') || "''";

const POINTER = 'Read and follow your prompt in ';
// Claude attaches an @ file unasked, where its Read tool asks outside the project; Codex and OpenCode read it unasked
const pointer = (kind: AgentKind | undefined, task: string): string => `${POINTER}${kind === 'claude' ? `@${JSON.stringify(task)}` : task}`;

// an agent submits a prompt given as its argument once it is up. The shell sources the line from `file`, as a line typed
// in before the shell is reading is cut past 1024 bytes, and the line has no "$(…)", which fish before 3.4 refuses.
// OpenCode reads none on a resume, so its plugin takes the prompt from the file then
export function withPromptFile(command: string, prompt: string, file: string, taskFile: string): { text: string; line: string; task?: string } {
  const kind = agentKindOf(command);
  if (kind === 'opencode' && /\s(-s|--session)(\s|=)/.test(unquoted(command.replace(ACCESS, '')))) return { text: prompt, line: command };
  // the prompt waits in `taskFile`, as `pkill -f` matches any word of an argv; a /command runs only as one submitted
  const task = /^\s*\//.test(prompt) ? undefined : prompt;
  // `.` and not `source`, which dash lacks; fish has kept `.` as its deprecated name for source. OpenCode takes a word
  // starting with - after a bare --prompt for a flag
  const arg = task === undefined ? prompt : pointer(kind, taskFile);
  return { text: `rm -f ${anyShq(file)}; ${command} ${kind === 'opencode' ? '--prompt=' : '-- '}${anyShq(arg)}\n`, line: `. ${anyShq(file)}`, ...(task !== undefined && { task }) };
}

const escaped = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** `text` with each pointer to a task file in `dir` read back as the prompt it holds, while the file is there. */
export function expandPointers(text: string, dir: string): string {
  if (!text.includes(POINTER)) return text;
  const files = new RegExp(`${escaped(POINTER)}@?"?(${escaped(dir)}/[^"\\s/]+\\.md)"?`, 'g');
  return text.replace(files, (all, file: string) => { try { return fs.readFileSync(file, 'utf8'); } catch { return all; } });
}

const eachString = (v: unknown, f: (s: string) => string): unknown => (typeof v === 'string' ? f(v)
  : Array.isArray(v) ? v.map((x) => eachString(x, f))
  : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, eachString(x, f)])) : v);

/** A transcript's JSON lines with their pointers read back, before a reader clips them or matches the hook's prompt. */
export function expandTranscript(text: string, dir: string): string {
  if (!text.includes(POINTER)) return text;
  return text.split('\n').map((l) => {
    if (!l.includes(POINTER)) return l;
    try { return JSON.stringify(eachString(JSON.parse(l), (s) => expandPointers(s, dir))); } catch { return l; }
  }).join('\n');
}
