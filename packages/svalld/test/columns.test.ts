import { afterEach, describe, expect, it } from 'vitest';
import { columnOf, type Robot } from '@svall/protocol';
import { Config } from '../src/config.js';
import { Fleet } from '../src/fleet.js';
import { silentLogger } from '../src/log.js';
import { resolvePaths } from '../src/paths.js';
import { Store } from '../src/store.js';
import type { Tmux } from '../src/tmux/tmux.js';
import { cleanHomes, makeHome } from './helpers.js';

afterEach(cleanHomes);

const robot = (id: string, x: number, extra: Partial<Robot> = {}): Robot => ({
  id, islandId: 'i_a', cell: { x, y: 1 }, name: id, note: '', portrait: 'owl', instructions: '', cwd: '/tmp', context: [], shell: { lastOutputAt: 0 }, unread: false, ...extra,
});

describe('the board', () => {
  function boot() {
    const home = makeHome();
    const paths = resolvePaths(home);
    const store = Store.load(paths.state, () => {});
    store.update((d) => { d.robots.a = robot('a', 0); d.robots.b = robot('b', 1, { column: 'review' }); });
    const config = Config.parse({});
    const fleet = new Fleet({ store, tmux: {} as Tmux, paths, config, log: silentLogger });
    const names = () => store.state.columns.map((k) => k.name);
    const where = (id: string) => columnOf(store.state, store.state.robots[id]).name;
    return { fleet, store, names, where };
  }

  it('adds a column after another or last, trimmed, and refuses an empty name, a twin in any case or a column that is gone', () => {
    const { fleet, names } = boot();
    fleet.addColumn('  Blocked ', 'doing');
    expect(fleet.addColumn('Shipped').map((k) => k.name)).toEqual(['To do', 'In progress', 'Blocked', 'In review', 'Done', 'Shipped']);
    expect(() => fleet.addColumn('   ')).toThrow(/needs a name/);
    expect(() => fleet.addColumn('done')).toThrow(/already called Done/);
    expect(() => fleet.addColumn('Later', 'gone')).toThrow(/no column gone/);
    expect(names()).toHaveLength(6);
  });

  it('renames a column, to its own name in another case too, and its robots stay in it', () => {
    const { fleet, names, where } = boot();
    fleet.renameColumn('review', ' Waiting on CI');
    fleet.renameColumn('done', 'DONE');
    expect(names()).toEqual(['To do', 'In progress', 'Waiting on CI', 'DONE']);
    expect(where('b')).toBe('Waiting on CI');
    expect(() => fleet.renameColumn('todo', 'in progress')).toThrow(/already called In progress/);
    expect(() => fleet.renameColumn('gone', 'x')).toThrow(/no column gone/);
  });

  it('puts a column before or after another, and a robot with no column of its own stays where it sat', () => {
    const { fleet, names, where } = boot();
    fleet.reorderColumn('todo', 'review', true);
    expect(names()).toEqual(['In progress', 'In review', 'To do', 'Done']);
    expect(where('a')).toBe('To do');
    fleet.reorderColumn('done', 'doing', false);
    expect(names()).toEqual(['Done', 'In progress', 'In review', 'To do']);
    expect(where('b')).toBe('In review');
    expect(() => fleet.reorderColumn('todo', 'gone', true)).toThrow(/no column gone/);
  });

  it('deletes a column and moves its robots to the one asked, those in the first by default too', () => {
    const { fleet, store, names, where } = boot();
    fleet.deleteColumn('todo', 'done');
    expect(names()).toEqual(['In progress', 'In review', 'Done']);
    expect(where('a')).toBe('Done');
    expect(where('b')).toBe('In review');
    fleet.deleteColumn('review', 'doing');
    expect(where('b')).toBe('In progress');
    expect(store.state.robots.b).not.toHaveProperty('columnSource');
  });

  it('refuses to delete the last column, or to move its robots into itself or a column that is gone', () => {
    const { fleet, names } = boot();
    expect(() => fleet.deleteColumn('todo', 'todo')).toThrow(/another column/);
    expect(() => fleet.deleteColumn('todo', 'gone')).toThrow(/no column gone/);
    for (const id of ['todo', 'doing', 'review']) fleet.deleteColumn(id, 'done');
    expect(() => fleet.deleteColumn('done', 'done')).toThrow(/last column/);
    expect(names()).toEqual(['Done']);
  });

  it('holds a robot placed by hand until it is let go, which leaves it where it is', () => {
    const { fleet, store, where } = boot();
    expect(fleet.placeRobot('a', 'review')).toMatchObject({ column: 'review', columnSource: 'manual' });
    expect(where('a')).toBe('In review');
    expect(() => fleet.placeRobot('a', 'gone')).toThrow(/no column gone/);
    expect(() => fleet.placeRobot('nobody', 'todo')).toThrow(/no robot nobody/);
    expect(fleet.releaseRobot('a')).not.toHaveProperty('columnSource');
    expect(store.state.robots.a.column).toBe('review');
  });

  it('turns placing on or off, which answers its ask', () => {
    const { fleet, store } = boot();
    expect(store.state.placingAsk).toBe(true);
    fleet.setPlacing(false);
    expect(store.state.placingOff).toBe(true);
    expect(store.state).not.toHaveProperty('placingAsk');
    fleet.setPlacing(true);
    expect(store.state).not.toHaveProperty('placingOff');
  });
});
