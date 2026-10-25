import type { ErrorFrame } from '@svall/protocol';

export class NotFound extends Error { code = 'not_found'; }
export class Dormant extends Error { code = 'dormant'; }
export class Invalid extends Error { code = 'invalid'; }
export class Blocked extends Error { code = 'blocked'; }

/** An error as a client reads it: its own code when that is a protocol code, else `internal`, and its data when it has any. */
export function errorFrame(e: unknown): ErrorFrame {
  const err = e as Error & { code?: unknown; data?: unknown };
  // a protocol code is lowercase words; a Node errno such as ENOENT is no answer a client can act on
  const code = typeof err.code === 'string' && /^[a-z_]+$/.test(err.code) ? err.code : 'internal';
  const data = err.data && typeof err.data === 'object' && !Array.isArray(err.data) ? err.data as Record<string, unknown> : undefined;
  return { code, message: err.message, ...(data ? { data } : {}) };
}
