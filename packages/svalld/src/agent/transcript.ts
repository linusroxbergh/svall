import fs from 'node:fs';
import type { AgentKind } from '@svall/protocol';
import { condenseTurnsClaude, userPromptsClaude, type Pending } from './claude-transcript.js';
import { condenseTurnsCodex, userPromptsCodex } from './codex-transcript.js';

// each agent writes its own transcript format, and either parser reads nothing out of the other's file
export function userPrompts(kind: AgentKind, text: string, limit: number, pending?: Pending): string[] {
  return kind === 'codex' ? userPromptsCodex(text, limit, pending) : userPromptsClaude(text, limit, pending);
}

export function condenseTurns(kind: AgentKind, text: string, turns: number, opts: { toolLinks?: boolean } = {}): string {
  return kind === 'codex' ? condenseTurnsCodex(text, turns, opts) : condenseTurnsClaude(text, turns, opts);
}

export function readTail(file: string, maxBytes = 512 * 1024): string {
  let fd: number | undefined;
  try {
    const size = fs.statSync(file).size;
    const start = Math.max(0, size - maxBytes);
    fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(size - start);
    // the file can shrink between the stat and the read; only the bytes actually read are text.
    const read = fs.readSync(fd, buf, 0, buf.length, start);
    return buf.toString('utf8', 0, read);
  } catch {
    return '';
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}
