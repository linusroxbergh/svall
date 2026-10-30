import fs from 'node:fs';
import type { AgentKind } from '@svall/protocol';
import { condenseTurnsClaude, lastMessageClaude, userPromptsClaude, type Pending } from './claude-transcript.js';
import { condenseTurnsCodex, lastMessageCodex, userPromptsCodex } from './codex-transcript.js';
import { condenseTurnsOpencode, lastMessageOpencode, userPromptsOpencode } from './opencode-transcript.js';

const READERS: Record<AgentKind, { prompts: typeof userPromptsClaude; condense: typeof condenseTurnsClaude; last: typeof lastMessageClaude }> = {
  claude: { prompts: userPromptsClaude, condense: condenseTurnsClaude, last: lastMessageClaude },
  codex: { prompts: userPromptsCodex, condense: condenseTurnsCodex, last: lastMessageCodex },
  opencode: { prompts: userPromptsOpencode, condense: condenseTurnsOpencode, last: lastMessageOpencode },
};

export function userPrompts(kind: AgentKind, text: string, limit: number, pending?: Pending): string[] {
  return READERS[kind].prompts(text, limit, pending);
}

export function condenseTurns(kind: AgentKind, text: string, turns: number, opts: { toolLinks?: boolean } = {}): string {
  return READERS[kind].condense(text, turns, opts);
}

/** The agent's answer in the newest turn, unclipped; undefined when it ended without one. */
export function lastMessage(kind: AgentKind, text: string): string | undefined {
  return READERS[kind].last(text);
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

// the folder a transcript line records its session working in: Claude's on each line, Codex's in each turn's context and
// in the settings a resume applies
function cwdOf(kind: AgentKind, line: string): string | undefined {
  let j: { cwd?: unknown; type?: unknown; payload?: { cwd?: unknown; type?: unknown; thread_settings?: { cwd?: unknown } } };
  try { j = JSON.parse(line); } catch { return undefined; }
  const cwd = kind === 'claude' ? j.cwd
    : j.type === 'turn_context' || j.type === 'session_meta' ? j.payload?.cwd
      : j.type === 'event_msg' && j.payload?.type === 'thread_settings_applied' ? j.payload.thread_settings?.cwd : undefined;
  return typeof cwd === 'string' && cwd.startsWith('/') ? cwd : undefined;
}

/** The folder a Claude or Codex transcript last records its session working in, read from its last 8 MB; OpenCode records none. */
export function recordedCwd(kind: AgentKind, file: string): string | undefined {
  if (kind === 'opencode') return undefined;
  for (const maxBytes of [512 * 1024, 8 * 1024 * 1024]) {
    const text = readTail(file, maxBytes);
    const lines = text.split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
      if (!lines[i].includes('"cwd"')) continue;
      const cwd = cwdOf(kind, lines[i]);
      if (cwd) return cwd;
    }
    if (Buffer.byteLength(text) < maxBytes) return undefined;
  }
  return undefined;
}
