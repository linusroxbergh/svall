import { describe, expect, it } from 'vitest';
import type { Api } from '../src/api.js';
import type { Bridge, ToShell } from '../src/bridge.js';
import { chooseResource } from '../src/resources/choose.js';
import { followResources, listingKey, loadResources } from '../src/resources/load.js';
import { createAppStore } from '../src/store/index.js';
import { fleet } from './fixtures.js';

const tick = () => new Promise((r) => setTimeout(r, 0));

function fakeApi() {
  let calls = 0;
  const api = { call: (m: string) => { if (m === 'resources.get') calls++; return Promise.resolve({ sources: [{ rootId: 'r:/h', root: '/h', name: 'Claude', tier: 'global', islandIds: [], characterIds: [], groups: [] }] }); } } as unknown as Pick<Api, 'call'>;
  return { api, calls: () => calls };
}

describe('loadResources', () => {
  it('puts the listing in the store, and leaves the store alone when svalld cannot answer', async () => {
    const store = createAppStore();
    const sources = [{ rootId: 'r:/d/islands/i1', root: '/d/islands/i1', name: 'one', tier: 'island', docs: 'r:/d/islands/i1', islandIds: ['i1'], characterIds: [], groups: [] }];
    await loadResources({ api: { call: () => Promise.resolve({ sources }) } as never, store });
    expect(store.getState().resources).toEqual(sources);
    await loadResources({ api: { call: () => Promise.reject(new Error('down')) } as never, store });
    expect(store.getState().resources).toEqual(sources);
  });
});

describe('followResources', () => {
  it('loads once the fleet is there, and again only when the set of roots changes', async () => {
    const { api, calls } = fakeApi();
    const store = createAppStore();
    const stop = followResources({ api, store });
    expect(calls()).toBe(0);
    const f = fleet();
    store.getState().setFleet(f);
    await tick();
    expect(calls()).toBe(1);
    expect(store.getState().resources[0].name).toBe('Claude');

    store.getState().setFleet({ ...f });
    await tick();
    expect(calls()).toBe(1);

    const [id] = Object.keys(f.characters);
    store.getState().setFleet({ ...f, characters: { ...f.characters, [id]: { ...f.characters[id], cwd: '/somewhere/else', repo: undefined } } });
    await tick();
    expect(calls()).toBe(2);
    stop();
  });
  it('keys the fleet by its distinct roots', () => {
    const f = fleet();
    expect(listingKey(f)).toBe(listingKey({ ...f }));
  });
  it('moves when an island or a character is added, renamed or moved, and not otherwise', () => {
    const f = fleet();
    const [cid] = Object.keys(f.characters), [iid] = Object.keys(f.islands);
    const c = f.characters[cid], i = f.islands[iid];
    expect(listingKey({ ...f, characters: { ...f.characters, [cid]: { ...c, unread: !c.unread, note: 'changed' } } })).toBe(listingKey(f));
    expect(listingKey({ ...f, characters: { ...f.characters, [cid]: { ...c, name: 'renamed' } } })).not.toBe(listingKey(f));
    expect(listingKey({ ...f, characters: { ...f.characters, [cid]: { ...c, islandId: 'elsewhere' } } })).not.toBe(listingKey(f));
    expect(listingKey({ ...f, characters: { ...f.characters, [cid]: { ...c, agentProfile: 'reviewer' } } })).not.toBe(listingKey(f));
    expect(listingKey({ ...f, islands: { ...f.islands, [iid]: { ...i, name: 'renamed' } } })).not.toBe(listingKey(f));
    expect(listingKey({ ...f, islands: { ...f.islands, extra: { ...i, id: 'extra' } } })).not.toBe(listingKey(f));
  });
});

describe('chooseResource', () => {
  it('shows a row with no file of its own in Finder, and opens nothing', async () => {
    const sent: ToShell[] = [];
    const bridge = { present: true, send: (m: ToShell) => sent.push(m), onMessage: () => () => {} } as Bridge;
    const asked: string[] = [];
    const api = { call: (m: string) => { asked.push(m); return Promise.resolve({ text: '', mtimeMs: 1 }); } } as unknown as Pick<Api, 'call'>;
    const store = createAppStore();
    await chooseResource({ api, store, bridge }, { id: 'mcp:linear', name: 'linear', reveal: '/h/.claude.json', target: 'file' });
    expect(sent).toEqual([{ type: 'reveal', path: '/h/.claude.json' }]);
    expect(asked).toEqual([]);
    expect(store.getState().ide).toEqual({});
    expect(store.getState().resourcesShown).toBeUndefined();
    expect(store.getState().resourcesChosen).toBeUndefined();
  });

  it('marks the one row it was given, though its neighbours open the same file', async () => {
    const bridge = { present: true, send: () => {}, onMessage: () => () => {} } as unknown as Bridge;
    const api = { call: () => Promise.resolve({ text: '', mtimeMs: 1 }) } as unknown as Pick<Api, 'call'>;
    const store = createAppStore();
    const hook = (name: string) => ({ id: `hooks:${name}`, name, reveal: '/h/.claude/settings.json', target: 'file' as const,
      open: { rootId: 'r:/h/.claude', path: 'settings.json', find: `"${name}"` } });
    await chooseResource({ api, store, bridge }, hook('Stop'));
    expect(store.getState().resourcesChosen).toBe('hooks:Stop');
    await chooseResource({ api, store, bridge }, hook('PreToolUse'));
    expect(store.getState().resourcesChosen).toBe('hooks:PreToolUse');
    expect(store.getState().resourcesShown).toEqual({ rootId: 'r:/h/.claude', path: 'settings.json' });
  });
});
