import path from 'node:path';
import type { AgentKind, ContextItem } from '@svall/protocol';
import { shq } from '../text.js';

// the folder access an OpenCode launch sets ahead of its command
const ACCESS = /^\s*OPENCODE_CONFIG_CONTENT='(?:[^']|'\\'')*'\s+/;

// the agent a command starts, as config.json may write it with a stray leading space
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
    // this config loads last, so its rules follow the user's own and win
    return `OPENCODE_CONFIG_CONTENT=${shq(JSON.stringify({ permissions: rules }))} ${command}`;
  }
  return dirs.reduce((cmd, d) => `${cmd} --add-dir ${shq(d)}`, command);
}

// OpenCode's TUI otherwise runs on the user's shared background service, whose plugins can't tell which character a
// session belongs to; a private server inherits the character's environment
export function withStandalone(command: string): string {
  if (agentKindOf(command) !== 'opencode' || /\s--standalone(\s|$)/.test(command)) return command;
  const access = ACCESS.exec(command)?.[0] ?? '';
  return access + command.slice(access.length).replace(/^\s*opencode/, '$& --standalone');
}

// OpenCode's TUI holds back the submit of a /command while its command menu is open, which a space after the name closes
export const promptText = (command: string, prompt: string): string =>
  agentKindOf(command) === 'opencode' && /^\/\S+$/.test(prompt.trim()) ? `${prompt.trim()} ` : prompt;

// an agent submits a prompt given as its argument once it is up. The shell reads it from a file: typed in before the
// shell is reading, a line past 1024 bytes is cut. OpenCode reads none on a resume, so its plugin takes the file then
export function withPromptFile(command: string, file: string): string {
  const read = `"$(cat ${shq(file)}; rm -f ${shq(file)})"`;
  if (agentKindOf(command) !== 'opencode') return `${command} -- ${read}`;
  return /\s(-s|--session)(\s|=)/.test(command.replace(ACCESS, '')) ? command : `${command} --prompt ${read}`;
}
