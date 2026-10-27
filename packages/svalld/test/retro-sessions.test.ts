import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Agent, Robot } from '@svall/protocol';
import { appendSessions, readSessions, sessionLines } from '../src/retro/sessions.js';
import { cleanHomes, makeHome } from './helpers.js';

afterEach(cleanHomes);

const A = '3f2b8c1e-6a4d-4e7b-9c21-5d8f0a1b2c3d';
const B = '019eefb3-8d5c-7b00-ad02-80c4930f7426';
const agent = (sessionId: string, o: Partial<Agent> = {}): Agent => ({ kind: 'claude', sessionId, status: 'idle', lastActivityAt: 0, ...o });
const robot = (o: Partial<Robot> = {}): Robot => ({
  id: 'c_a', islandId: 'i_x', cell: { x: 1, y: 1 }, name: 'a', portrait: 'owl', note: '', instructions: '', cwd: '/r/wt', context: [],
  shell: { lastOutputAt: 0 }, unread: false, repo: { root: '/r/wt', mainRoot: '/r', branch: 'b', isWorktree: true }, ...o,
});

describe('sessionLines', () => {
  it('writes where a new session ran when it takes the slot', () => {
    const lines = sessionLines(robot(), robot({ agent: agent(A, { model: 'opus', transcriptPath: '/t/a.jsonl' }) }), 5);
    expect(lines).toEqual([{ at: 5, session: A, robot: 'c_a', island: 'i_x', cwd: '/r/wt', repo: '/r', branch: 'b', agent: 'claude', model: 'opus', transcript: '/t/a.jsonl' }]);
  });

  it('writes nothing for a revive of the session already held', () => {
    expect(sessionLines(robot({ agent: agent(A, { pid: 1 }) }), robot({ agent: agent(A, { pid: 2, status: 'working' }) }), 5)).toEqual([]);
  });

  it('ends the old session and starts the new one when a clear replaces it', () => {
    const lines = sessionLines(robot({ agent: agent(A) }), robot({ agent: agent(B) }), 7);
    expect(lines).toEqual([{ at: 7, session: A, end: 7 }, expect.objectContaining({ at: 7, session: B, robot: 'c_a' })]);
  });

  it('writes a model or transcript that changes, and an end when the agent goes', () => {
    expect(sessionLines(robot({ agent: agent(A, { model: 'opus' }) }), robot({ agent: agent(A, { model: 'sonnet', transcriptPath: '/t/b.jsonl' }) }), 8))
      .toEqual([{ at: 8, session: A, model: 'sonnet', transcript: '/t/b.jsonl' }]);
    expect(sessionLines(robot({ agent: agent(A) }), robot(), 9)).toEqual([{ at: 9, session: A, end: 9 }]);
  });

  it('records the second terminal too, where only its cwd says which repo it ran in', () => {
    const second = { cwd: '/elsewhere', unread: false, agent: agent(B, { kind: 'codex' }) };
    expect(sessionLines(robot(), robot({ second }), 3)).toEqual([{ at: 3, session: B, robot: 'c_a', island: 'i_x', cwd: '/elsewhere', agent: 'codex' }]);
  });

  it('writes a session the record has not named in full, whatever changed', () => {
    const named = (s: string) => s === A;
    const held = robot({ agent: agent(B, { model: 'opus' }) });
    const full = { session: B, robot: 'c_a', island: 'i_x', cwd: '/r/wt', repo: '/r', branch: 'b', agent: 'claude', model: 'opus' };
    // a resume of a session a move brought changes nothing the slot shows
    expect(sessionLines(held, held, 4, named)).toEqual([{ at: 4, ...full }]);
    expect(sessionLines(robot({ agent: agent(B) }), held, 5, named)).toEqual([{ at: 5, ...full }]);
    expect(sessionLines(held, robot(), 6, named)).toEqual([{ at: 6, ...full, end: 6 }]);
    expect(sessionLines(robot({ agent: agent(A) }), robot(), 7, named)).toEqual([{ at: 7, session: A, end: 7 }]);
  });
});

describe('readSessions', () => {
  it('folds each session\'s lines in order and skips junk', () => {
    const file = path.join(makeHome(), 'retro', 'sessions.ndjson');
    appendSessions(file, sessionLines(robot(), robot({ agent: agent(A, { model: 'opus' }) }), 1));
    fs.appendFileSync(file, 'not json\n{"session":1}\n');
    appendSessions(file, [{ at: 2, session: A, model: 'sonnet' }, { at: 3, session: A, end: 3 }]);
    expect(readSessions(file).get(A)).toEqual({ at: 3, session: A, robot: 'c_a', island: 'i_x', cwd: '/r/wt', repo: '/r', branch: 'b', agent: 'claude', model: 'sonnet', end: 3, start: 1 });
    // resumed on another robot, it runs again
    appendSessions(file, sessionLines(undefined, robot({ id: 'c_b', agent: agent(A) }), 4));
    expect(readSessions(file).get(A)).toMatchObject({ robot: 'c_b', start: 1 });
    expect(readSessions(file).get(A)).not.toHaveProperty('end');
  });

  it('reads a missing file as no sessions', () => {
    expect(readSessions('/nonexistent/sessions.ndjson').size).toBe(0);
  });
});
