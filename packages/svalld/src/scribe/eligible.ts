import type { Character } from '@svall/protocol';

export const REST_MS = 45_000;
export const REST_BYTES = 2 * 1024;
export const BACKSTOP_MS = 10 * 60_000;
export const BACKSTOP_BYTES = 20 * 1024;

// what the scribe remembers of its last pass on a character; retryAt holds off a character whose last `failures` passes failed
export type Seen = { lastPassAt: number; path: string; bytes: number; retryAt?: number; failures?: number };

// bytes is the transcript's size now; a new session's transcript starts with nothing seen
export function eligible(c: Character, seen: Seen | undefined, bytes: number, now: number): boolean {
  const a = c.agent;
  if (!c.tmux || !a?.transcriptPath) return false;
  if (seen?.retryAt !== undefined && now < seen.retryAt) return false;
  const last = seen?.path === a.transcriptPath ? seen : undefined;
  const lastPassAt = last?.lastPassAt ?? 0;
  const grown = bytes - (last?.bytes ?? 0);
  if (a.status === 'done' || a.status === 'idle') return now - a.lastActivityAt >= REST_MS && grown >= REST_BYTES;
  if (a.status === 'working') return now - lastPassAt >= BACKSTOP_MS && grown >= BACKSTOP_BYTES;
  return false;
}
