import { describe, expect, it } from 'vitest';
import { NewerStateVersion, OlderStateVersion, migrateState } from '../src/migrate.js';
import { defaultHome, emptyState } from '../src/state.js';

const island = (id: string) => ({ id, name: id, description: '', instructions: '', context: [], position: { x: 0, y: 0 }, size: { w: 8, h: 4 }, seed: 7 });
const char = (id: string, islandId: string) => ({
  id, islandId, cell: { x: 1, y: 1 }, name: id, portrait: 'owl', note: '', instructions: '', cwd: '/tmp', context: [], shell: { lastOutputAt: 0 }, unread: false,
});

describe('migrateState', () => {
  it('passes a version 9 file through', () => {
    const { state, migrated, dropped } = migrateState(emptyState());
    expect(migrated).toBe(false);
    expect(dropped).toEqual([]);
    expect(state.version).toBe(9);
  });

  const agent = { kind: 'claude', sessionId: 's', transcriptPath: '/t', status: 'idle', lastActivityAt: 3 };
  const withSecond = (version: number) => ({
    ...emptyState(),
    version,
    islands: { i_a: island('i_a') },
    characters: {
      c0: { ...char('c0', 'i_a'), cwd: '/work', second: { tmux: { windowId: '@2', paneId: '%2' }, unread: true, agent } },
      c1: char('c1', 'i_a'),
    },
  });

  for (const version of [7, 8]) {
    it(`lifts a version ${version} file to 9: a second terminal gets its character's cwd, and an absent one stays absent`, () => {
      const { state, migrated, dropped } = migrateState(withSecond(version));
      expect(migrated).toBe(true);
      expect(dropped).toEqual([]);
      expect(state.version).toBe(9);
      expect(state.characters.c0.second).toEqual({ cwd: '/work', tmux: { windowId: '@2', paneId: '%2' }, unread: true, agent });
      expect(state.characters.c1.second).toBeUndefined();
    });
  }

  it('lifts a version 8 file with an OpenCode agent and an interrupted revive as it is', () => {
    const oc = { kind: 'opencode', sessionId: 'ses_0f3a5b7c9d1eAbCdEfGhIjKlMn', status: 'idle', lastActivityAt: 3 };
    const c = { ...char('c_a', 'i_a'), worktree: true, agent: oc, revive: { command: 'opencode -s x', interrupted: true } };
    const raw = { ...emptyState(), version: 8, islands: { i_a: island('i_a') }, characters: { c_a: c } };
    const { state, migrated, dropped } = migrateState(raw);
    expect(migrated).toBe(true);
    expect(dropped).toEqual([]);
    expect(state).toEqual({ ...raw, version: 9 });
  });

  it('refuses a file older than version 7 and says so', () => {
    for (const version of [1, 6]) {
      expect(() => migrateState({ version, islands: {}, characters: {} })).toThrow(OlderStateVersion);
    }
    expect(() => migrateState({ version: 6, islands: {}, characters: {} })).toThrow(/version 6, older than this svalld reads \(7\)/);
  });

  it('refuses a file from a newer svalld', () => {
    expect(() => migrateState({ version: 10, islands: {}, characters: {} })).toThrow(NewerStateVersion);
    expect(() => migrateState({ version: 10, islands: {}, characters: {} })).toThrow(/newer than this svalld reads \(9\)/);
  });

  it('rejects garbage', () => {
    expect(() => migrateState({ islands: {} })).toThrow();
    expect(() => migrateState(null)).toThrow();
  });

  it('leaves out a character the schema rejects, names it, and loads the rest', () => {
    const bad = { ...char('c_bad', 'i_a'), shell: { lastOutputAt: null } };
    const raw = { ...emptyState(), islands: { i_a: island('i_a') }, characters: { c_a: char('c_a', 'i_a'), c_bad: bad } };
    const { state, dropped } = migrateState(raw);
    expect(Object.keys(state.characters)).toEqual(['c_a']);
    expect(state.islands.i_a.name).toBe('i_a');
    expect(dropped).toEqual([expect.stringMatching(/^character c_bad: shell\.lastOutputAt/)]);
  });

  it('leaves out an island the schema rejects, and keeps the characters that stood on it for the fleet to re-home', () => {
    const raw = {
      ...emptyState(),
      islands: { i_a: island('i_a'), i_bad: { ...island('i_bad'), size: { w: 1, h: 1 } } },
      characters: { c_a: char('c_a', 'i_a'), c_b: { ...char('c_b', 'i_bad'), note: 'halfway' } },
    };
    const { state, dropped } = migrateState(raw);
    expect(Object.keys(state.islands)).toEqual(['i_a']);
    expect(state.characters.c_b).toMatchObject({ islandId: 'i_bad', note: 'halfway' });
    expect(dropped).toEqual([expect.stringMatching(/^island i_bad: size/)]);
  });

  it('leaves out a fleet-wide field the schema rejects, as each has a default or may be absent', () => {
    const raw = { ...emptyState(), home: { cwd: 3 }, scribeError: 'x', islands: { i_a: island('i_a') }, characters: { c_a: char('c_a', 'i_a') } };
    const { state, dropped } = migrateState(raw);
    expect(state.home).toEqual(defaultHome());
    expect(state.scribeError).toBeUndefined();
    expect(state.scribeAsk).toBe(true);
    expect(Object.keys(state.characters)).toEqual(['c_a']);
    expect(dropped).toEqual([expect.stringMatching(/^field home: cwd/), expect.stringMatching(/^field scribeError: /)]);
  });

  it('still refuses a file whose islands or characters are not records', () => {
    expect(() => migrateState({ ...emptyState(), characters: [] })).toThrow();
    expect(() => migrateState({ ...emptyState(), islands: 'none' })).toThrow();
  });
});
