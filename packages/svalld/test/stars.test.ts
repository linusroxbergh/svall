import { afterEach, describe, expect, it } from 'vitest';
import { starredOf, type Robot } from '@svall/protocol';
import { Config } from '../src/config.js';
import { Fleet } from '../src/fleet.js';
import { silentLogger } from '../src/log.js';
import { resolvePaths } from '../src/paths.js';
import { Store } from '../src/store.js';
import type { Tmux } from '../src/tmux/tmux.js';
import { cleanHomes, makeHome } from './helpers.js';

afterEach(cleanHomes);

const robot = (id: string, x: number): Robot => ({
  id, islandId: 'i_a', cell: { x, y: 1 }, name: id, note: '', portrait: 'owl', instructions: '', cwd: '/tmp', context: [], shell: { lastOutputAt: 0 }, unread: false,
});

describe('stars', () => {
  function boot() {
    const home = makeHome();
    const paths = resolvePaths(home);
    const store = Store.load(paths.state, () => {});
    store.update((d) => { for (const [n, id] of ['a', 'b', 'c', 'd'].entries()) d.robots[id] = robot(id, n); });
    const config = Config.parse({});
    const fleet = new Fleet({ store, tmux: {} as Tmux, paths, config, log: silentLogger });
    const starred = () => starredOf(store.state).map((c) => c.id);
    return { fleet, store, starred };
  }

  it('puts the newest star first', () => {
    const { fleet, starred } = boot();
    fleet.starRobot('a');
    fleet.starRobot('b');
    fleet.starRobot('c');
    expect(starred()).toEqual(['c', 'b', 'a']);
  });

  it('moves a starred robot first when it is starred again without a target', () => {
    const { fleet, starred } = boot();
    for (const id of ['a', 'b', 'c']) fleet.starRobot(id);
    fleet.starRobot('a');
    expect(starred()).toEqual(['a', 'c', 'b']);
  });

  it('places a star dropped on another before or after it', () => {
    const { fleet, starred } = boot();
    for (const id of ['a', 'b', 'c']) fleet.starRobot(id);
    fleet.starRobot('a', 'c', false);
    expect(starred()).toEqual(['a', 'c', 'b']);
    fleet.starRobot('a', 'b', true);
    expect(starred()).toEqual(['c', 'b', 'a']);
    fleet.starRobot('d', 'c', true);
    expect(starred()).toEqual(['c', 'd', 'b', 'a']);
  });

  it('takes an unstarred robot out and keeps the rest in order', () => {
    const { fleet, store, starred } = boot();
    for (const id of ['a', 'b', 'c']) fleet.starRobot(id);
    fleet.unstarRobot('b');
    expect(starred()).toEqual(['c', 'a']);
    expect(store.state.robots.b.star).toBeUndefined();
  });

  it('refuses a target that is not starred', () => {
    const { fleet, starred } = boot();
    fleet.starRobot('a');
    expect(() => fleet.starRobot('b', 'c', false)).toThrow(/not starred/);
    expect(starred()).toEqual(['a']);
  });
});
