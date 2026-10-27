import { describe, expect, it } from 'vitest';
import type { Api } from '../src/api.js';
import type { Bridge, FromShell, ToShell } from '../src/bridge.js';
import { followMenu, menuChords } from '../src/menu.js';
import { createAppStore } from '../src/store/index.js';
import { fleet } from './fixtures.js';

const fleets = [{ home: '/u/.svall', name: 'main', current: true, windowOpen: true }, { home: '/u/.svall-work', name: 'work', current: false, windowOpen: false }];

function ctx(answer: (method: string) => Promise<unknown> = () => Promise.resolve({})) {
  const calls: { method: string; params: unknown }[] = [];
  const sent: ToShell[] = [];
  const handlers = new Set<(m: FromShell) => void>();
  const api = { call: (method: string, params: unknown) => { calls.push({ method, params }); return answer(method); } } as unknown as Api;
  const bridge: Bridge & { emit(m: FromShell): void } = {
    present: true, send: (m) => { sent.push(m); },
    onMessage: (h) => { handlers.add(h); return () => handlers.delete(h); },
    emit: (m) => { for (const h of handlers) h(m); },
  };
  const store = createAppStore(undefined);
  store.getState().setFleet(fleet());
  followMenu({ api, bridge, store });
  const states = () => sent.filter((m) => m.type === 'menu.state');
  return { calls, sent, bridge, store, states };
}

const settle = () => new Promise((r) => setTimeout(r, 0));

describe('menuChords', () => {
  it('names each action by its chord, zoom in as ⌘+ while it answers that, and leaves an unbound one out', () => {
    expect(menuChords({})).toMatchObject({ zoomIn: 'cmd++', zoomOut: 'cmd+-', toggleSettings: 'cmd+,', toggleSides: 'cmd+shift+s' });
    const chosen = menuChords({ zoomIn: 'cmd+shift+z', toggleView: null });
    expect(chosen.zoomIn).toBe('cmd+shift+z');
    expect(chosen).not.toHaveProperty('toggleView');
    expect(menuChords({ toggleView: 'cmd++' })).toMatchObject({ zoomIn: 'cmd+=', toggleView: 'cmd++' });
  });
});

describe('followMenu', () => {
  it('tells the shell what the menu shows at once, and again only when that changes', () => {
    const c = ctx();
    expect(c.states()).toHaveLength(1);
    expect(c.states()[0]).toMatchObject({ state: { view: 'map', card: false, browser: false }, chords: { toggleView: 'cmd+m' } });
    c.store.getState().showToast('unrelated');
    expect(c.states()).toHaveLength(1);
    c.store.getState().setView('board');
    c.store.getState().setSettings({ bindings: { toggleView: 'cmd+shift+b' } });
    expect(c.states().at(-1)).toMatchObject({ state: { view: 'board' }, chords: { toggleView: 'cmd+shift+b' } });
    // the side card alone is what Hide Sidebars would hide
    c.store.getState().toggleSidebar(false);
    expect(c.states().at(-1)).toMatchObject({ state: { sides: false } });
    c.store.getState().toggleSideCard(true);
    expect(c.states().at(-1)).toMatchObject({ state: { sides: true, sideCard: true } });
  });

  it('runs a clicked command as its key would, and Settings… opens the window without closing an open one', () => {
    const c = ctx();
    c.bridge.emit({ type: 'menu.run', action: 'zoomIn' });
    expect(c.store.getState().settings.zoom).toBeGreaterThan(0.9);
    c.bridge.emit({ type: 'menu.run', action: 'toggleSettings' });
    c.bridge.emit({ type: 'menu.run', action: 'toggleSettings' });
    expect(c.store.getState().settingsOpen).toBe(true);
    c.bridge.emit({ type: 'menu.run', action: 'shortcuts' });
    expect(c.store.getState().settingsAsk).toEqual({ pane: 'keyboard' });
    c.bridge.emit({ type: 'menu.run', action: 'nothing such' });
  });

  it('a click stops a shortcut row waiting for a chord, and New Fleet… asks only for a name', () => {
    const c = ctx();
    c.store.getState().toggleSettings(true);
    c.store.getState().setCapturingKey('zoomIn');
    c.bridge.emit({ type: 'menu.run', action: 'zoomOut' });
    expect(c.store.getState().capturingKey).toBeUndefined();
    c.store.getState().setCapturingKey('zoomIn');
    c.bridge.emit({ type: 'menu.run', action: 'newFleet' });
    expect(c.store.getState()).toMatchObject({ capturingKey: undefined, fleetPicker: 'new' });
  });

  it('lists the fleets when File opens, or says why it cannot', async () => {
    const c = ctx((method) => Promise.resolve(method === 'fleets.list' ? { fleets } : {}));
    c.bridge.emit({ type: 'menu.ask' });
    await settle();
    expect(c.sent.at(-1)).toEqual({ type: 'menu.fleets', fleets: [], note: 'svalld is not connected' });
    c.store.getState().setStatus('online');
    c.bridge.emit({ type: 'menu.ask' });
    await settle();
    expect(c.sent.at(-1)).toEqual({ type: 'menu.fleets', fleets });
    c.store.getState().setConnectionState({ state: 'online', owner: 'trift' });
    c.bridge.emit({ type: 'menu.ask' });
    await settle();
    expect(c.sent.at(-1)).toEqual({ type: 'menu.fleets', fleets: [], note: 'This fleet runs on trift' });
  });

  it('opens a fleet picked in File once it has started, and says so when it cannot', async () => {
    const c = ctx((method) => (method === 'fleets.start' ? Promise.resolve({ home: '/u/.svall-work' }) : Promise.resolve({})));
    c.bridge.emit({ type: 'menu.openFleet', home: '/u/.svall-work' });
    await settle();
    expect(c.calls).toContainEqual({ method: 'fleets.start', params: { home: '/u/.svall-work' } });
    expect(c.sent.at(-1)).toEqual({ type: 'openFleet', home: '/u/.svall-work' });

    const failing = ctx(() => Promise.reject(new Error('no daemon')));
    failing.bridge.emit({ type: 'menu.openFleet', home: '/u/.svall-work' });
    await settle();
    expect(failing.store.getState().toast?.text).toBe('Could not open /u/.svall-work: no daemon');
  });
});
