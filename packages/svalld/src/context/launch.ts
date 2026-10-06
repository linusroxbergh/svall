import path from 'node:path';
import type { AgentKind, ContextItem } from '@svall/protocol';
import { shq } from '../text.js';

// the folder access an OpenCode launch sets ahead of its command
const ACCESS = /^\s*OPENCODE_PERMISSION='(?:[^']|'\\'')*'\s+/;

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
    const rules = Object.fromEntries(dirs.filter((d) => !/[*?]/.test(d)).map((d) => [path.join(path.resolve(d), '*'), 'allow']));
    if (!Object.keys(rules).length) return command;
    // OpenCode matches a permission's name as a wildcard too, so this key adds the rules after a user's own
    // external_directory rule, where they win, rather than replacing it
    return `OPENCODE_PERMISSION=${shq(JSON.stringify({ 'external_director?': rules }))} ${command}`;
  }
  return dirs.reduce((cmd, d) => `${cmd} --add-dir ${shq(d)}`, command);
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
