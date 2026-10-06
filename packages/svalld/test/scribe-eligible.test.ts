import { describe, expect, it } from 'vitest';
import type { AgentStatus, Character } from '@svall/protocol';
import { BACKSTOP_BYTES, BACKSTOP_MS, REST_BYTES, REST_MS, eligible, type Seen } from '../src/scribe/eligible.js';

const NOW = 100_000_000;
const T = '/t.jsonl';
const char = (status: AgentStatus, quietMs: number, extra: Partial<Character> = {}): Character => ({
  id: 'c', islandId: 'i', cell: { x: 0, y: 0 }, name: 'golden heron', portrait: 'fox', note: '', instructions: '', cwd: '/tmp', context: [],
  tmux: { windowId: '@1', paneId: '%1' }, shell: { lastOutputAt: 0 }, unread: false,
  agent: { kind: 'claude', sessionId: 's', transcriptPath: T, status, lastActivityAt: NOW - quietMs },
  ...extra,
});

const opencode = (status: AgentStatus, quietMs: number): Character => {
  const c = char(status, quietMs);
  return { ...c, agent: { ...c.agent!, kind: 'opencode' } };
};

describe('eligible', () => {
  const cases: [string, Character, Seen | undefined, number, boolean][] = [
    ['at rest with enough new transcript', char('done', REST_MS), undefined, REST_BYTES, true],
    ['idle counts as at rest', char('idle', REST_MS), { lastPassAt: NOW - 1000, path: T, bytes: 1000 }, 1000 + REST_BYTES, true],
    ['not quiet long enough', char('done', REST_MS - 1), undefined, REST_BYTES, false],
    ['too little new transcript', char('done', REST_MS), { lastPassAt: 0, path: T, bytes: 5000 }, 5000 + REST_BYTES - 1, false],
    ['a new session, smaller than the last one seen', char('done', REST_MS), { lastPassAt: NOW, path: '/old.jsonl', bytes: 500_000 }, REST_BYTES, true],
    ['working in a new session', char('working', 0), { lastPassAt: NOW, path: '/old.jsonl', bytes: 500_000 }, BACKSTOP_BYTES, true],
    ['blocked waits for the user', char('blocked', REST_MS * 10), undefined, 1e6, false],
    ['working, long since the last pass, grown a lot', char('working', 0), { lastPassAt: NOW - BACKSTOP_MS, path: T, bytes: 0 }, BACKSTOP_BYTES, true],
    ['working, pass too recent', char('working', 0), { lastPassAt: NOW - BACKSTOP_MS + 1, path: T, bytes: 0 }, 1e6, false],
    ['working, not grown enough', char('working', 0), { lastPassAt: 0, path: T, bytes: 0 }, BACKSTOP_BYTES - 1, false],
    ['dormant', char('done', REST_MS, { tmux: undefined }), undefined, 1e6, false],
    ['no agent', char('done', REST_MS, { agent: undefined }), undefined, 1e6, false],
    ['holding off after a failure', char('done', REST_MS), { lastPassAt: 0, path: T, bytes: 0, retryAt: NOW + 1 }, 1e6, false],
    ['retry once the hold is over', char('done', REST_MS), { lastPassAt: 0, path: T, bytes: 0, retryAt: NOW }, 1e6, true],
    // Svall's OpenCode log holds only what was said and each tool call, so one exchange adds a few hundred bytes
    ['an OpenCode exchange at rest', opencode('done', REST_MS), undefined, 200, true],
    ['an OpenCode log barely grown', opencode('done', REST_MS), undefined, 100, false],
  ];
  it.each(cases)('%s', (_name, c, seen, bytes, expected) => {
    expect(eligible(c, seen, bytes, NOW)).toBe(expected);
  });
});
