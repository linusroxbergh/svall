import path from 'node:path';
import type { ContextItem } from '@svall/protocol';
import { shq } from '../text.js';

// a command config.json may carry with a stray leading space
const AGENT_COMMAND = /^\s*(claude|codex)(\s|$)/;

// both agents take --add-dir, on a fresh start and on a resume alike
const takesAddDir = (command: string): boolean => AGENT_COMMAND.test(command);

// an agent command gains access to every folder item and every file item's folder
export function withAddDirs(command: string, items: ContextItem[]): string {
  if (!takesAddDir(command)) return command;
  const dirs = [...new Set(items.flatMap((it) => (it.kind === 'folder' ? [it.ref] : it.kind === 'file' ? [path.dirname(it.ref)] : [])))];
  return dirs.reduce((cmd, d) => `${cmd} --add-dir ${shq(d)}`, command);
}

// claude and codex submit a prompt given as their argument once they are up. The shell reads it from a file: typed
// in before the shell is reading, a line past 1024 bytes is cut
export const takesPrompt = (command: string): boolean => AGENT_COMMAND.test(command);
export const withPromptFile = (command: string, file: string): string => `${command} -- "$(cat ${shq(file)}; rm -f ${shq(file)})"`;
