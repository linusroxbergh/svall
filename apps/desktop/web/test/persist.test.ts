import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS } from '../src/settings.js';
import { FILES_TREE_RANGE, HALF_CARD_RANGE, localAppStorage, RESOURCE_COL_RANGE, SETTINGS_KEY, SIDE_WIDTH_RANGE } from '../src/store/index.js';

// a Storage of our own, so a read or a write can be made to fail the way a real one does
class Mem implements Storage {
  private m = new Map<string, string>();
  get length(): number { return this.m.size; }
  key(i: number): string | null { return [...this.m.keys()][i] ?? null; }
  getItem(k: string): string | null { return this.m.get(k) ?? null; }
  setItem(k: string, v: string): void { this.m.set(k, v); }
  removeItem(k: string): void { this.m.delete(k); }
  clear(): void { this.m.clear(); }
  entries(): Record<string, string> { return Object.fromEntries(this.m); }
}

let mem: Mem;
const install = (ls: unknown) => Object.defineProperty(globalThis, 'localStorage', { value: ls, writable: true, configurable: true });
const store = () => localAppStorage()!;

beforeEach(() => { mem = new Mem(); install(mem); });
afterEach(() => install(undefined));

describe('localAppStorage', () => {
  it('writes each setting under the key the app reads it back from', () => {
    const s = store();
    s.setFocus('c1');
    s.setView('board');
    s.setSidebarOpen(false);
    s.setHalfCard({ w: 0.4, h: 0.6 });
    s.setResourceCols({ rail: 200, list: 300 });
    s.setResourceSize({ w: 0.5, h: 0.7 });
    s.setResourceGroups(['global', 'fleet', 'repo']);
    s.setSideWidths({ sidebar: 200, card: 300 });
    s.setFilesTree({ open: false, width: 320 });
    s.setSettings(DEFAULT_SETTINGS);
    expect(mem.entries()).toEqual({
      'svall.focused': 'c1',
      'svall.view': 'board',
      'svall.sidebar.open': 'false',
      'svall.card.half': '{"w":0.4,"h":0.6}',
      'svall.resources.cols': '{"rail":200,"list":300}',
      'svall.resources.size': '{"w":0.5,"h":0.7}',
      'svall.resources.tiers': '["global","fleet","repo"]',
      'svall.side.widths': '{"sidebar":200,"card":300}',
      'svall.files.tree': '{"open":false,"width":320}',
      [SETTINGS_KEY]: JSON.stringify(DEFAULT_SETTINGS),
    });
    expect(store().getResourceGroups()).toEqual(['global', 'fleet', 'repo']);
  });

  it('reads back what it wrote', () => {
    const s = store();
    s.setFocus('c1');
    s.setView('board');
    s.setSidebarOpen(false);
    s.setHalfCard({ w: 0.4, h: 0.6 });
    s.setResourceGroups(['island']);
    s.setFilesTree({ open: false, width: 320 });
    s.setSettings({ ...DEFAULT_SETTINGS, zoom: 1.25 });
    const r = store();
    expect(r.getFocus()).toBe('c1');
    expect(r.getView()).toBe('board');
    expect(r.getSidebarOpen()).toBe(false);
    expect(r.getHalfCard()).toEqual({ w: 0.4, h: 0.6 });
    expect(r.getResourceGroups()).toEqual(['island']);
    expect(r.getFilesTree()).toEqual({ open: false, width: 320 });
    expect(r.getSettings()?.zoom).toBe(1.25);
  });

  it('answers nothing for a key that was never written', () => {
    const s = store();
    expect(s.getFocus()).toBeUndefined();
    expect(s.getView()).toBeUndefined();
    expect(s.getSidebarOpen()).toBeUndefined();
    expect(s.getHalfCard()).toBeUndefined();
    expect(s.getResourceCols()).toBeUndefined();
    expect(s.getSideWidths()).toBeUndefined();
    expect(s.getFilesTree()).toBeUndefined();
    expect(s.getSettings()).toBeUndefined();
  });

  it('brings a width left by a larger or smaller window back into range', () => {
    mem.setItem('svall.resources.cols', '{"rail":9,"list":9999}');
    mem.setItem('svall.side.widths', '{"sidebar":9,"card":9999}');
    expect(store().getResourceCols()).toEqual({ rail: RESOURCE_COL_RANGE.rail.min, list: RESOURCE_COL_RANGE.list.max });
    expect(store().getSideWidths()).toEqual({ sidebar: SIDE_WIDTH_RANGE.sidebar.min, card: SIDE_WIDTH_RANGE.card.max });
    mem.setItem('svall.files.tree', '{"open":true,"width":9999}');
    expect(store().getFilesTree()).toEqual({ open: true, width: FILES_TREE_RANGE.max });
    mem.setItem('svall.files.tree', '{"open":true,"width":9}');
    expect(store().getFilesTree()).toEqual({ open: true, width: FILES_TREE_RANGE.min });
    mem.setItem('svall.resources.size', '{"w":0.01,"h":4}');
    expect(store().getResourceSize()).toEqual({ w: HALF_CARD_RANGE.min, h: HALF_CARD_RANGE.max });
  });

  it('ignores a value of the wrong shape rather than starting on it', () => {
    mem.setItem('svall.view', 'sideways');
    mem.setItem('svall.card.half', 'not json');
    mem.setItem('svall.resources.cols', '{"rail":"wide"}');
    mem.setItem('svall.resources.tiers', '["global","nowhere"]');
    mem.setItem('svall.side.widths', 'null');
    mem.setItem('svall.files.tree', '{"open":"yes","width":"wide"}');
    mem.setItem(SETTINGS_KEY, '{');
    const s = store();
    expect(s.getView()).toBeUndefined();
    expect(s.getHalfCard()).toBeUndefined();
    expect(s.getResourceCols()).toBeUndefined();
    expect(s.getResourceGroups()).toBeUndefined();
    expect(s.getSideWidths()).toBeUndefined();
    expect(s.getFilesTree()).toBeUndefined();
    expect(s.getSettings()).toBeUndefined();
  });

  it('opens Fleet on a set saved while the fleet stood under Global, and reads its own key first', () => {
    mem.setItem('svall.resources.groups', '["global","repo"]');
    expect(store().getResourceGroups()).toEqual(['global', 'repo', 'fleet']);
    mem.setItem('svall.resources.groups', '["repo"]');
    expect(store().getResourceGroups()).toEqual(['repo']);
    mem.setItem('svall.resources.tiers', '["global"]');
    expect(store().getResourceGroups()).toEqual(['global']);
  });

  it('reads the older set a fleet kept under its own key, and no other fleet’s', () => {
    mem.setItem('svall.resources.groups@/Users/me/.svall', '["global"]');
    mem.setItem('svall.resources.groups@/Users/me/.svall-work', '["repo"]');
    expect(localAppStorage('/Users/me/.svall')!.getResourceGroups()).toEqual(['global', 'fleet']);
    expect(localAppStorage('/Users/me/.svall-work')!.getResourceGroups()).toEqual(['repo']);
  });

  it('carries on when the store is full', () => {
    const s = store();
    mem.setItem = () => { throw new Error('QuotaExceededError'); };
    expect(() => s.setFocus('c1')).not.toThrow();
  });

  // every fleet's window is the same app to WebKit, so they share one localStorage
  it('keeps each fleet\'s own settings apart in the one store', () => {
    const a = localAppStorage('/Users/me/.svall')!;
    const b = localAppStorage('/Users/me/.svall-work')!;
    a.setView('board');
    b.setView('map');
    a.setSettings({ ...DEFAULT_SETTINGS, zoom: 1.25 });
    b.setSettings({ ...DEFAULT_SETTINGS, zoom: 0.9 });
    expect(a.getView()).toBe('board');
    expect(b.getView()).toBe('map');
    expect(localAppStorage('/Users/me/.svall')!.getSettings()?.zoom).toBe(1.25);
    expect(localAppStorage('/Users/me/.svall-work')!.getSettings()?.zoom).toBe(0.9);
  });

  it('reads the unscoped keys until the fleet writes its own', () => {
    mem.setItem(SETTINGS_KEY, JSON.stringify({ ...DEFAULT_SETTINGS, zoom: 1.25 }));
    mem.setItem('svall.view', 'board');
    const a = localAppStorage('/Users/me/.svall')!;
    expect(a.getSettings()?.zoom).toBe(1.25);
    expect(a.getView()).toBe('board');
    a.setView('map');
    expect(a.getView()).toBe('map');
  });

  it('is not there at all when the store is switched off', () => {
    install({ getItem: () => { throw new Error('SecurityError'); } });
    expect(localAppStorage()).toBeUndefined();
    install(undefined);
    expect(localAppStorage()).toBeUndefined();
  });
});
