import fs from 'node:fs';
import type { AgentKind } from '@svall/protocol';
import { condenseTurnsClaude, userPromptsClaude, type Pending } from './claude-transcript.js';
import { condenseTurnsCodex, userPromptsCodex } from './codex-transcript.js';
import { condenseTurnsOpencode, userPromptsOpencode } from './opencode-transcript.js';

// each agent writes its own transcript format, and no parser reads anything out of another's file
const READERS: Record<AgentKind, { prompts: typeof userPromptsClaude; condense: typeof condenseTurnsClaude }> = {
  claude: { prompts: userPromptsClaude, condense: condenseTurnsClaude },
  codex: { prompts: userPromptsCodex, condense: condenseTurnsCodex },
  opencode: { prompts: userPromptsOpencode, condense: condenseTurnsOpencode },
};

export function userPrompts(kind: AgentKind, text: string, limit: number, pending?: Pending): string[] {
  return READERS[kind].prompts(text, limit, pending);
}

export function condenseTurns(kind: AgentKind, text: string, turns: number, opts: { toolLinks?: boolean } = {}): string {
  return READERS[kind].condense(text, turns, opts);
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
