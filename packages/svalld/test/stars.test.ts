import { afterEach, describe, expect, it } from 'vitest';
import { starredOf, type Character } from '@svall/protocol';
import { Config } from '../src/config.js';
import { Fleet } from '../src/fleet.js';
import { silentLogger } from '../src/log.js';
import { resolvePaths } from '../src/paths.js';
import { Store } from '../src/store.js';
import type { Tmux } from '../src/tmux/tmux.js';
import { cleanHomes, makeHome } from './helpers.js';

afterEach(cleanHomes);

const character = (id: string, x: number): Character => ({
  id, islandId: 'i_a', cell: { x, y: 1 }, name: id, note: '', portrait: 'owl', instructions: '', cwd: '/tmp', context: [], shell: { lastOutputAt: 0 }, unread: false,
});

describe('stars', () => {
  function boot() {
    const paths = resolvePaths(makeHome());
    const store = Store.load(paths.state, () => {});
    store.update((d) => { for (const [n, id] of ['a', 'b', 'c', 'd'].entries()) d.characters[id] = character(id, n); });
    const fleet = new Fleet({ store, tmux: {} as Tmux, paths, config: Config.parse({}), log: silentLogger });
    const starred = () => starredOf(store.state).map((c) => c.id);
    return { fleet, store, starred };
  }

  it('puts the newest star first', () => {
    const { fleet, starred } = boot();
    fleet.starCharacter('a');
    fleet.starCharacter('b');
    fleet.starCharacter('c');
    expect(starred()).toEqual(['c', 'b', 'a']);
  });

  it('places a star dropped on another before or after it', () => {
    const { fleet, starred } = boot();
    for (const id of ['a', 'b', 'c']) fleet.starCharacter(id);
    fleet.starCharacter('a', 'c', false);
    expect(starred()).toEqual(['a', 'c', 'b']);
    fleet.starCharacter('a', 'b', true);
    expect(starred()).toEqual(['c', 'b', 'a']);
    fleet.starCharacter('d', 'c', true);
    expect(starred()).toEqual(['c', 'd', 'b', 'a']);
  });

  it('takes an unstarred character out and keeps the rest in order', () => {
    const { fleet, store, starred } = boot();
    for (const id of ['a', 'b', 'c']) fleet.starCharacter(id);
    fleet.unstarCharacter('b');
    expect(starred()).toEqual(['c', 'a']);
    expect(store.state.characters.b.star).toBeUndefined();
  });

  it('refuses a target that is not starred', () => {
    const { fleet, starred } = boot();
    fleet.starCharacter('a');
    expect(() => fleet.starCharacter('b', 'c', false)).toThrow(/not starred/);
    expect(starred()).toEqual(['a']);
  });
});
