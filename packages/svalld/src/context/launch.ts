import path from 'node:path';
import type { AgentKind, ContextItem } from '@svall/protocol';
import { shq } from '../text.js';

// the agent a command starts, as config.json may write it with a stray leading space
export const agentKindOf = (command: string): AgentKind | undefined =>
  /^\s*(claude|codex|opencode)(\s|$)/.exec(command)?.[1] as AgentKind | undefined;

export const isAgentCommand = (command: string): boolean => agentKindOf(command) !== undefined;

// claude and codex gain access to every folder item and every file item's folder
export function withAddDirs(command: string, items: ContextItem[]): string {
  const kind = agentKindOf(command);
  if (kind !== 'claude' && kind !== 'codex') return command;
  const dirs = [...new Set(items.flatMap((it) => (it.kind === 'folder' ? [it.ref] : it.kind === 'file' ? [path.dirname(it.ref)] : [])))];
  return dirs.reduce((cmd, d) => `${cmd} --add-dir ${shq(d)}`, command);
}

// an agent submits a prompt given as its argument once it is up. The shell reads it from a file: typed in before the
// shell is reading, a line past 1024 bytes is cut. OpenCode reads none on a resume, so its plugin takes the file then
export function withPromptFile(command: string, file: string): string {
  const read = `"$(cat ${shq(file)}; rm -f ${shq(file)})"`;
  if (agentKindOf(command) !== 'opencode') return `${command} -- ${read}`;
  return /\s(-s|--session)(\s|=)/.test(command) ? command : `${command} --prompt ${read}`;
}
