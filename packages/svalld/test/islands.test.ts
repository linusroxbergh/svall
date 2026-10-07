import { afterEach, describe, expect, it } from 'vitest';
import { HOME_ISLAND, byIslandOrder, homeSizeFor } from '@svall/protocol';
import { Config } from '../src/config.js';
import { Fleet } from '../src/fleet.js';
import { silentLogger } from '../src/log.js';
import { resolvePaths } from '../src/paths.js';
import { Store } from '../src/store.js';
import type { Tmux } from '../src/tmux/tmux.js';
import { cleanHomes, makeHome } from './helpers.js';

afterEach(cleanHomes);

describe('island order', () => {
  function boot() {
    const paths = resolvePaths(makeHome());
    const store = Store.load(paths.state, () => {});
    store.update((d) => {
      d.islands[HOME_ISLAND] = { id: HOME_ISLAND, kind: 'home', name: 'mission control', description: '', instructions: '', context: [], position: { x: 0, y: 40 }, size: homeSizeFor(2), seed: 1 };
    });
    const fleet = new Fleet({ store, tmux: {} as Tmux, paths, config: Config.parse({}), log: silentLogger });
    const listed = () => Object.values(store.state.islands).sort(byIslandOrder).map((i) => i.name);
    return { fleet, listed };
  }

  it('lists by name until a drop numbers every island, and puts islands made later after them', () => {
    const { fleet, listed } = boot();
    const [a, b, c] = ['a', 'b', 'c'].map((name) => fleet.createIsland({ name }));
    expect(listed()).toEqual(['a', 'b', 'c', 'mission control']);
    fleet.reorderIsland(c.id, a.id, false);
    expect(listed()).toEqual(['c', 'a', 'b', 'mission control']);
    fleet.reorderIsland(c.id, b.id, true);
    expect(listed()).toEqual(['a', 'b', 'c', 'mission control']);
    fleet.createIsland({ name: '0' });
    expect(listed()).toEqual(['a', 'b', 'c', '0', 'mission control']);
  });

  it('keeps a renamed island in its place', () => {
    const { fleet, listed } = boot();
    const [a] = ['a', 'b', 'c'].map((name) => fleet.createIsland({ name }));
    fleet.updateIsland(a.id, { name: 'z' });
    expect(listed()).toEqual(['z', 'b', 'c', 'mission control']);
    const d = fleet.createIsland({ name: 'd' });
    fleet.updateIsland(d.id, { name: '0' });
    expect(listed()).toEqual(['z', 'b', 'c', '0', 'mission control']);
  });

  it('leaves the list by name when an island keeps its name', () => {
    const { fleet, listed } = boot();
    const c = fleet.createIsland({ name: 'c' });
    fleet.updateIsland(c.id, { name: 'c' });
    fleet.createIsland({ name: 'b' });
    expect(listed()).toEqual(['b', 'c', 'mission control']);
  });

  it('keeps mission control last', () => {
    const { fleet, listed } = boot();
    const a = fleet.createIsland({ name: 'a' });
    expect(() => fleet.reorderIsland(a.id, HOME_ISLAND, true)).toThrow(/mission control/);
    expect(() => fleet.reorderIsland(HOME_ISLAND, a.id, false)).toThrow(/mission control/);
    expect(listed()).toEqual(['a', 'mission control']);
  });
});
