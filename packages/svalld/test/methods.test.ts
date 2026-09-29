import { afterEach, describe, expect, it } from 'vitest';
import { dispatch, type Ctx } from '../src/api/methods.js';
import { Config } from '../src/config.js';
import { NotFound } from '../src/errors.js';
import { Fleet } from '../src/fleet.js';
import { silentLogger } from '../src/log.js';
import { resolvePaths } from '../src/paths.js';
import { workspaceRoot } from '../src/resources/scan.js';
import { Store } from '../src/store.js';
import type { Tmux } from '../src/tmux/tmux.js';
import { cleanHomes, makeHome } from './helpers.js';

afterEach(cleanHomes);

// a name every object inherits must find nothing, rather than the prototype
describe('names every object has', () => {
  it('answers a method named like one as unknown', async () => {
    for (const method of ['constructor', 'toString', '__proto__', 'hasOwnProperty']) {
      expect(await dispatch({ id: 1, method }, {} as Ctx)).toMatchObject({ id: 1, error: { code: 'unknown_method' } });
    }
  });

  it('finds no character or island by such an id, and leaves every other object alone', async () => {
    const paths = resolvePaths(makeHome());
    const store = Store.load(paths.state, () => {});
    const ctx = { store, fleet: new Fleet({ store, tmux: {} as Tmux, paths, config: Config.parse({}), log: silentLogger }) } as unknown as Ctx;
    for (const id of ['__proto__', 'constructor', 'toString']) {
      expect(await dispatch({ id: 1, method: 'char.update', params: { id, name: 'pwned', instructions: 'pwned' } }, ctx)).toMatchObject({ error: { code: 'not_found' } });
      expect(await dispatch({ id: 2, method: 'island.update', params: { id, name: 'pwned', description: 'pwned' } }, ctx)).toMatchObject({ error: { code: 'not_found' } });
      expect(await dispatch({ id: 3, method: 'island.delete', params: { id } }, ctx)).toMatchObject({ error: { code: 'not_found' } });
    }
    expect(({} as { instructions?: string }).instructions).toBeUndefined();
    expect(({} as { description?: string }).description).toBeUndefined();
  });

  it('finds no character by such an id for a hook or a statusline to report on', () => {
    const paths = resolvePaths(makeHome());
    const store = Store.load(paths.state, () => {});
    const fleet = new Fleet({ store, tmux: {} as Tmux, paths, config: Config.parse({}), log: silentLogger });
    const before = structuredClone(store.state);
    for (const charId of ['__proto__', 'constructor', 'toString']) {
      expect(fleet.onSocketEvent({ hook: { charId, backend: 'claude', name: 'SessionStart', sessionId: '11111111-1111-4111-8111-111111111111', pid: process.pid } })).toBeUndefined();
      expect(fleet.onSocketEvent({ hook: { charId, backend: 'claude', name: 'Stop', cwd: '/' } })).toBeUndefined();
      expect(fleet.onSocketEvent({ status: { charId, contextPct: 40 } })).toBeUndefined();
    }
    expect(store.state).toEqual(before);
    expect(({} as { agent?: unknown }).agent).toBeUndefined();
  });

  it('finds no character by such an id for its folder to be read', () => {
    const store = Store.load(resolvePaths(makeHome()).state, () => {});
    const claude = { dir: '/nowhere/.claude', json: '/nowhere/.claude.json' };
    for (const id of ['__proto__', 'constructor', 'toString']) expect(() => workspaceRoot(id, store.state, claude)).toThrow(NotFound);
  });

  it('finds no island by such an id to put a character on', async () => {
    const paths = resolvePaths(makeHome());
    const store = Store.load(paths.state, () => {});
    store.update((d) => {
      d.islands.i_a = { id: 'i_a', name: 'a', description: '', instructions: '', context: [], position: { x: 0, y: 0 }, size: { w: 7, h: 5 }, seed: 1 };
      d.characters.c_a = { id: 'c_a', islandId: 'i_a', cell: { x: 3, y: 2 }, name: 'a', portrait: 'fox', note: '', instructions: '', cwd: '/', context: [], shell: { lastOutputAt: 0 }, unread: false };
    });
    const ctx = { store, fleet: new Fleet({ store, tmux: {} as Tmux, paths, config: Config.parse({}), log: silentLogger }) } as unknown as Ctx;
    for (const islandId of ['__proto__', 'constructor']) {
      expect(await dispatch({ id: 1, method: 'char.create', params: { islandId, cwd: '/' } }, ctx)).toMatchObject({ error: { code: 'not_found' } });
      expect(await dispatch({ id: 2, method: 'char.update', params: { id: 'c_a', islandId } }, ctx)).toMatchObject({ error: { code: 'not_found' } });
      expect(await dispatch({ id: 3, method: 'char.move', params: { id: 'c_a', islandId } }, ctx)).toMatchObject({ error: { code: 'not_found' } });
    }
    expect(({} as { size?: unknown }).size).toBeUndefined();
    expect(store.state.characters.c_a.islandId).toBe('i_a');
  });
});

describe('the fleets beside this one', () => {
  const fleets = { list: async () => [], create: async () => '/u/.svall-work', start: async (home: string) => home };
  const ctx = (kind: 'app' | 'phone') => ({ fleets, fleet: { renameFleet() {} }, viewer: { kind } }) as unknown as Ctx;

  it('are refused to a phone', async () => {
    for (const [method, params] of [['fleets.list', {}], ['fleets.create', { name: 'work' }], ['fleets.start', { home: '/u/.svall-work' }], ['fleet.rename', { name: 'home' }]] as const) {
      expect(await dispatch({ id: 1, method, params }, ctx('phone'))).toMatchObject({ error: { code: 'forbidden' } });
    }
  });

  it('are listed, created, started and named for the app', async () => {
    expect(await dispatch({ id: 1, method: 'fleets.list' }, ctx('app'))).toEqual({ id: 1, result: { fleets: [] } });
    expect(await dispatch({ id: 2, method: 'fleets.create', params: { name: 'work' } }, ctx('app'))).toEqual({ id: 2, result: { home: '/u/.svall-work' } });
    expect(await dispatch({ id: 3, method: 'fleets.start', params: { home: '/u/.svall-side' } }, ctx('app'))).toEqual({ id: 3, result: { home: '/u/.svall-side' } });
    expect(await dispatch({ id: 4, method: 'fleet.rename', params: { name: 'home' } }, ctx('app'))).toEqual({ id: 4, result: {} });
  });
});
