import path from 'node:path';
import type { AgentKind, ContextItem } from '@svall/protocol';
import { shq } from '../text.js';

// the folder access an OpenCode launch sets ahead of its command
const ACCESS = /^\s*OPENCODE_CONFIG_CONTENT='(?:[^']|'\\'')*'\s+/;

// the agent a command starts, as fleet.json may write it with a stray leading space
export const agentKindOf = (command: string): AgentKind | undefined =>
  /^\s*(claude|codex|opencode)(\s|$)/.exec(command.replace(ACCESS, ''))?.[1] as AgentKind | undefined;

export const isAgentCommand = (command: string): boolean => agentKindOf(command) !== undefined;

// an agent command gains access to every folder item and every file item's folder: claude and codex as --add-dir,
// opencode, which has no such flag, as permission rules
export function withAddDirs(command: string, items: ContextItem[]): string {
  const kind = agentKindOf(command);
  const dirs = [...new Set(items.flatMap((it) => (it.kind === 'folder' ? [it.ref] : it.kind === 'file' ? [path.dirname(it.ref)] : [])))];
  if (!kind || !dirs.length) return command;
  if (kind === 'opencode') {
    // OpenCode reads * and ? in a rule as wildcards, with no way to escape one, so such a folder is left to ask
    const rules = dirs.filter((d) => !/[*?]/.test(d)).map((d) => ({ action: 'external_directory', resource: path.join(path.resolve(d), '*'), effect: 'allow' }));
    if (!rules.length) return command;
    // this config loads last, so its rules follow the user's top-level ones and win; an agent's own rules still come after
    return `OPENCODE_CONFIG_CONTENT=${shq(JSON.stringify({ permissions: rules }))} ${command}`;
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
  const rest = command.slice(access.length);
  return access + (/\s--(standalone|server)(\s|=|$)/.test(unquoted(rest)) ? rest : rest.replace(/^\s*opencode/, '$& --standalone'));
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

// an agent submits a prompt given as its argument once it is up. The shell sources the line from `file`, as a line typed
// in before the shell is reading is cut past 1024 bytes, and the line has no "$(…)", which fish before 3.4 refuses.
// OpenCode reads none on a resume, so its plugin takes the prompt from the file then
export function withPromptFile(command: string, prompt: string, file: string): { text: string; line: string } {
  const opencode = agentKindOf(command) === 'opencode';
  if (opencode && /\s(-s|--session)(\s|=)/.test(unquoted(command.replace(ACCESS, '')))) return { text: prompt, line: command };
  // `.` and not `source`, which dash lacks; fish has kept `.` as its deprecated name for source
  return { text: `rm -f ${anyShq(file)}; ${command} ${opencode ? '--prompt' : '--'} ${anyShq(prompt)}\n`, line: `. ${anyShq(file)}` };
}
