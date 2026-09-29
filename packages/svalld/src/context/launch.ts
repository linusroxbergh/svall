import path from 'node:path';
import type { ContextItem } from '@svall/protocol';
import { shq } from '../text.js';

// claude or codex, as fleet.json may write it with a stray leading space. Both take --add-dir and a prompt as
// their argument, on a fresh start and on a resume alike
export const isAgentCommand = (command: string): boolean => /^\s*(claude|codex)(\s|$)/.test(command);

// an agent command gains access to every folder item and every file item's folder
export function withAddDirs(command: string, items: ContextItem[]): string {
  if (!isAgentCommand(command)) return command;
  const dirs = [...new Set(items.flatMap((it) => (it.kind === 'folder' ? [it.ref] : it.kind === 'file' ? [path.dirname(it.ref)] : [])))];
  return dirs.reduce((cmd, d) => `${cmd} --add-dir ${shq(d)}`, command);
}

// an agent submits a prompt given as its argument once it is up. The shell reads it from a file: typed in before the
// shell is reading, a line past 1024 bytes is cut
export const withPromptFile = (command: string, file: string): string => `${command} -- "$(cat ${shq(file)}; rm -f ${shq(file)})"`;
