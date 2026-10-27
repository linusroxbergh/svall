import { describe, expect, it } from 'vitest';
import { NewerStateVersion, OlderStateVersion, migrateState } from '../src/migrate.js';
import { DEFAULT_CWD, columnOf, defaultColumns, defaultHome, emptyState } from '../src/state.js';

const island = (id: string) => ({ id, name: id, description: '', instructions: '', context: [], position: { x: 0, y: 0 }, size: { w: 8, h: 4 }, seed: 7 });
const robot = (id: string, islandId: string) => ({
  id, islandId, cell: { x: 1, y: 1 }, name: id, portrait: 'owl', note: '', instructions: '', cwd: '/tmp', context: [], shell: { lastOutputAt: 0 }, unread: false,
});

// a file an older svalld wrote, which keeps its robots under characters
const older = <T extends object>(version: number, rest: T) => {
  const { robots: _, ...base } = emptyState();
  return { ...base, version, ...rest };
};
const asCurrent = <T extends { characters: object }>({ characters, ...rest }: T) => ({ ...rest, version: 12, robots: characters });

describe('migrateState', () => {
  it('passes a version 12 file through', () => {
    const { state, migrated, dropped } = migrateState(emptyState());
    expect(migrated).toBe(false);
    expect(dropped).toEqual([]);
    expect(state.version).toBe(12);
  });

  const agent = { kind: 'claude', sessionId: 's', transcriptPath: '/t', status: 'idle', lastActivityAt: 3 };
  const withSecond = (version: number) => older(version, {
    islands: { i_a: island('i_a') },
    characters: {
      c0: { ...robot('c0', 'i_a'), cwd: '/work', second: { tmux: { windowId: '@2', paneId: '%2' }, unread: true, agent } },
      c1: robot('c1', 'i_a'),
    },
  });

  for (const version of [7, 8]) {
    it(`lifts a version ${version} file to 12: a second terminal gets its robot's cwd, and an absent one stays absent`, () => {
      const { state, migrated, dropped } = migrateState(withSecond(version));
      expect(migrated).toBe(true);
      expect(dropped).toEqual([]);
      expect(state.version).toBe(12);
      expect(state.robots.c0.second).toEqual({ cwd: '/work', tmux: { windowId: '@2', paneId: '%2' }, unread: true, agent });
      expect(state.robots.c1.second).toBeUndefined();
    });
  }

  it('lifts a version 8 file with an OpenCode agent and an interrupted revive as it is', () => {
    const oc = { kind: 'opencode', sessionId: 'ses_0f3a5b7c9d1eAbCdEfGhIjKlMn', status: 'idle', lastActivityAt: 3 };
    const c = { ...robot('c_a', 'i_a'), agent: oc, revive: { command: 'opencode -s x', interrupted: true } };
    const raw = older(8, { islands: { i_a: island('i_a') }, characters: { c_a: c } });
    const { state, migrated, dropped } = migrateState(raw);
    expect(migrated).toBe(true);
    expect(dropped).toEqual([]);
    expect(state).toEqual(asCurrent(raw));
  });

  it('lifts a version 8 file with the launch flags an agent started with, as it is', () => {
    const c = { ...robot('c_a', 'i_a'), agent: { ...agent, flags: ['--effort', "'high'"] } };
    const raw = older(8, { islands: { i_a: island('i_a') }, characters: { c_a: c } });
    const { state, dropped } = migrateState(raw);
    expect(dropped).toEqual([]);
    expect(state).toEqual(asCurrent(raw));
  });

  it('lifts a version 8 file a handover wrote, with a dormant second and what a handover keeps on a robot, as it is', () => {
    const second = { cwd: '/work/sub', unread: false, agent, revive: { command: 'claude --resume s' }, resumeError: 'it did not come up' };
    const c = { ...robot('c_a', 'i_a'), resumeError: 'it did not come up', revive: { command: '' }, second };
    const raw = older(8, { islands: { i_a: island('i_a') }, characters: { c_a: c } });
    const { state, migrated, dropped } = migrateState(raw);
    expect(migrated).toBe(true);
    expect(dropped).toEqual([]);
    expect(state).toEqual(asCurrent(raw));
  });

  it('lifts a version 8 file Svall 0.6.0 wrote, with starred robots and the monitors of both terminals, losing nothing', () => {
    const second = { tmux: { windowId: '@2', paneId: '%2' }, unread: false, agent: { ...agent, monitors: ['b2'] } };
    const c = { ...robot('c_a', 'i_a'), cwd: '/work', tmux: { windowId: '@1', paneId: '%1' }, star: 1, agent: { ...agent, monitors: ['b1'] }, second };
    const raw = older(8, { islands: { i_a: island('i_a') }, characters: { c_a: c, c_b: { ...robot('c_b', 'i_a'), star: 0 } } });
    const { state, migrated, dropped } = migrateState(raw);
    expect(migrated).toBe(true);
    expect(dropped).toEqual([]);
    expect(state).toEqual(asCurrent({ ...raw, characters: { ...raw.characters, c_a: { ...c, second: { ...second, cwd: '/work' } } } }));
  });

  it('lifts a version 8 file Svall 0.9.0 wrote, with robots and the subagents and shells of both terminals, losing nothing but its animals switch', () => {
    const second = { tmux: { windowId: '@2', paneId: '%2' }, unread: false, agent: { ...agent, background: true, shellsOnly: true, subagents: ['a2'] } };
    const c = { ...robot('c_a', 'i_a'), cwd: '/work', robot: 42, agent: { ...agent, subagents: ['a1'] }, second };
    const raw = older(8, { islands: { i_a: island('i_a') }, characters: { c_a: c, c_b: { ...robot('c_b', 'i_a'), robot: 7 } } });
    const { state, migrated, dropped } = migrateState({ ...raw, animals: true });
    expect(migrated).toBe(true);
    expect(dropped).toEqual([]);
    const { robot: _a, ...a } = c;
    expect(state).toEqual(asCurrent({ ...raw, characters: { c_a: { ...a, figure: 42, second: { ...second, cwd: '/work' } }, c_b: { ...robot('c_b', 'i_a'), figure: 7 } } }));
  });

  it('lifts a version 9 file: its characters are its robots, and the robot each one wears is its figure', () => {
    const c = { ...robot('c_a', 'i_a'), robot: 42, second: { cwd: '/work', unread: false } };
    const raw = older(9, { islands: { i_a: island('i_a') }, characters: { c_a: c, c_b: robot('c_b', 'i_a') } });
    const { state, migrated, dropped } = migrateState(raw);
    expect(migrated).toBe(true);
    expect(dropped).toEqual([]);
    const { robot: _, ...a } = c;
    expect(state).toEqual(asCurrent({ ...raw, characters: { c_a: { ...a, figure: 42 }, c_b: robot('c_b', 'i_a') } }));
    expect(state).not.toHaveProperty('characters');
  });

  it('lifts a version 10 file: the board gets the default columns with every robot in the first, and placing waits on the ask', () => {
    const raw = { version: 10, islands: { i_a: island('i_a') }, robots: { c_a: robot('c_a', 'i_a') }, home: defaultHome(), defaultCwd: DEFAULT_CWD };
    const { state, migrated, dropped } = migrateState(raw);
    expect(migrated).toBe(true);
    expect(dropped).toEqual([]);
    expect(state).toEqual({ ...raw, version: 12, columns: defaultColumns(), placingAsk: true });
    expect(state.columns.map((k) => k.name)).toEqual(['To do', 'In progress', 'In review', 'Done']);
    expect(columnOf(state, state.robots.c_a).name).toBe('To do');
  });

  it('lifts a version 10 file whose robot carries keepHere to 12, the mark dropped', () => {
    const raw = { version: 10, islands: { i_a: island('i_a') }, home: defaultHome(), defaultCwd: DEFAULT_CWD };
    const { state, migrated, dropped } = migrateState({ ...raw, robots: { c_a: { ...robot('c_a', 'i_a'), keepHere: true } } });
    expect(migrated).toBe(true);
    expect(dropped).toEqual([]);
    expect(state).toEqual({ ...raw, version: 12, robots: { c_a: robot('c_a', 'i_a') }, columns: defaultColumns(), placingAsk: true });
  });

  it('lifts a version 11 file to 12 with its board as it is, and drops keepHere', () => {
    const columns = [{ id: 'todo', name: 'Backlog' }, { id: 'k_1', name: 'Shipping' }];
    const placed = { ...robot('c_a', 'i_a'), column: 'k_1', columnSource: 'manual' };
    const raw = { version: 11, islands: { i_a: island('i_a') }, home: defaultHome(), defaultCwd: DEFAULT_CWD, columns, placingOff: true };
    const { state, migrated, dropped } = migrateState({ ...raw, robots: { c_a: { ...placed, keepHere: true } } });
    expect(migrated).toBe(true);
    expect(dropped).toEqual([]);
    expect(state).toEqual({ ...raw, version: 12, robots: { c_a: placed } });
  });

  it('reads a current file whose fleet still has the animals switch, and drops the key', () => {
    const raw = { ...emptyState(), islands: { i_a: island('i_a') }, robots: { c_a: robot('c_a', 'i_a') } };
    const { state, migrated, dropped } = migrateState({ ...raw, animals: true });
    expect(migrated).toBe(false);
    expect(dropped).toEqual([]);
    expect(state).toEqual(raw);
    expect(state).not.toHaveProperty('animals');
  });

  it('refuses a file older than version 7 and says so', () => {
    for (const version of [1, 6]) {
      expect(() => migrateState({ version, islands: {}, characters: {} })).toThrow(OlderStateVersion);
    }
    expect(() => migrateState({ version: 6, islands: {}, characters: {} })).toThrow(/version 6, older than this svalld reads \(7\)/);
  });

  it('refuses a file from a newer svalld', () => {
    expect(() => migrateState({ version: 13, islands: {}, robots: {} })).toThrow(NewerStateVersion);
    expect(() => migrateState({ version: 13, islands: {}, robots: {} })).toThrow(/newer than this svalld reads \(12\)/);
  });

  it('rejects garbage', () => {
    expect(() => migrateState({ islands: {} })).toThrow();
    expect(() => migrateState(null)).toThrow();
  });

  it('leaves out a robot the schema rejects, names it, and loads the rest', () => {
    const bad = { ...robot('c_bad', 'i_a'), shell: { lastOutputAt: null } };
    const raw = { ...emptyState(), islands: { i_a: island('i_a') }, robots: { c_a: robot('c_a', 'i_a'), c_bad: bad } };
    const { state, dropped } = migrateState(raw);
    expect(Object.keys(state.robots)).toEqual(['c_a']);
    expect(state.islands.i_a.name).toBe('i_a');
    expect(dropped).toEqual([expect.stringMatching(/^robot c_bad: shell\.lastOutputAt/)]);
  });

  it('leaves out an island the schema rejects, and keeps the robots that stood on it for the fleet to re-home', () => {
    const raw = {
      ...emptyState(),
      islands: { i_a: island('i_a'), i_bad: { ...island('i_bad'), size: { w: 1, h: 1 } } },
      robots: { c_a: robot('c_a', 'i_a'), c_b: { ...robot('c_b', 'i_bad'), note: 'halfway' } },
    };
    const { state, dropped } = migrateState(raw);
    expect(Object.keys(state.islands)).toEqual(['i_a']);
    expect(state.robots.c_b).toMatchObject({ islandId: 'i_bad', note: 'halfway' });
    expect(dropped).toEqual([expect.stringMatching(/^island i_bad: size/)]);
  });

  it('leaves out a fleet-wide field the schema rejects, as each has a default or may be absent', () => {
    const raw = { ...emptyState(), home: { cwd: 3 }, scribeError: 'x', islands: { i_a: island('i_a') }, robots: { c_a: robot('c_a', 'i_a') } };
    const { state, dropped } = migrateState(raw);
    expect(state.home).toEqual(defaultHome());
    expect(state.scribeError).toBeUndefined();
    expect(state.scribeAsk).toBe(true);
    expect(Object.keys(state.robots)).toEqual(['c_a']);
    expect(dropped).toEqual([expect.stringMatching(/^field home: cwd/), expect.stringMatching(/^field scribeError: /)]);
  });

  it('loads the default columns in place of a board with none', () => {
    const { state, dropped } = migrateState({ ...emptyState(), columns: [] });
    expect(state.columns).toEqual(defaultColumns());
    expect(dropped).toEqual([expect.stringMatching(/^field columns: /)]);
  });

  it('still refuses a file whose islands or robots are not records', () => {
    expect(() => migrateState({ ...emptyState(), robots: [] })).toThrow();
    expect(() => migrateState({ ...emptyState(), islands: 'none' })).toThrow();
  });
});
