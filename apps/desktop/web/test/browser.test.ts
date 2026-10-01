import { describe, expect, it } from 'vitest';
import type { Api } from '../src/api.js';
import type { Bridge, FromShell, ToShell } from '../src/bridge.js';
import { createBrowserManager } from '../src/browser.js';
import { createAppStore } from '../src/store/index.js';
import { chr, fleet } from './fixtures.js';

const rect = { x: 400, y: 60, width: 600, height: 500 };
const tabs = { tabs: [{ id: 't_1', url: 'https://a.test/', title: '' }, { id: 't_2', url: 'https://b.test/', title: 'B' }], active: 't_1' };

function fakes() {
  const sent: ToShell[] = [];
  const handlers = new Set<(m: FromShell) => void>();
  const bridge: Bridge & { emit(m: FromShell): void } = {
    present: true,
    send: (m) => { sent.push(m); },
    onMessage: (h) => { handlers.add(h); return () => handlers.delete(h); },
    emit: (m) => { for (const h of handlers) h(m); },
  };
  const calls: { method: string; params: unknown }[] = [];
  const api = {
    call: (method: string, params: unknown) => { calls.push({ method, params }); return Promise.resolve(method === 'browser.open' ? { id: (params as { tab?: string }).tab ?? 't_new', url: (params as { url: string }).url, title: '' } : {}); },
    fire: (method: string, params: unknown) => { calls.push({ method, params }); },
  } as unknown as Api;
  const store = createAppStore();
  const f = fleet();
  f.characters.c0 = chr('c0', 'i_b', { x: 1, y: 1 }, { browser: tabs });
  store.getState().setFleet(f);
  return { sent, calls, bridge, api, store, manager: createBrowserManager(api, bridge, store) };
}

describe('browser manager', () => {
  it('creates a view at the tab url once, then only restates its rect', () => {
    const { sent, store, manager } = fakes();
    manager.show('c0', 't_1', rect);
    expect(sent).toEqual([{ type: 'browser.show', tab: 't_1', rect, url: 'https://a.test/', focus: true }]);
    expect(store.getState().webviews.t_1.rect).toEqual(rect);
    manager.show('c0', 't_1', { ...rect, width: 300 }, false);
    expect(sent.at(-1)).toEqual({ type: 'browser.show', tab: 't_1', rect: { ...rect, width: 300 }, focus: false });
    manager.move('t_1', { ...rect, width: 200 });
    expect(store.getState().webviews.t_1.rect.width).toBe(200);
    manager.hide('t_1');
    expect(sent.at(-1)).toEqual({ type: 'browser.hide', tab: 't_1' });
    // a tab the fleet does not know gets no view
    manager.show('c0', 't_9', rect);
    expect(sent.filter((m) => m.type === 'browser.show' && m.tab === 't_9')).toEqual([]);
  });

  it('mirrors what the shell reports and tells svalld when url or title changed', () => {
    const { bridge, calls, store, manager } = fakes();
    manager.show('c0', 't_1', rect);
    bridge.emit({ type: 'browser.state', tab: 't_1', url: 'https://a.test/', title: '', loading: true, canGoBack: false, canGoForward: false });
    expect(store.getState().webviews.t_1.loading).toBe(true);
    expect(calls.filter((c) => c.method === 'browser.update')).toEqual([]);
    bridge.emit({ type: 'browser.state', tab: 't_1', url: 'https://a.test/x', title: 'A', loading: false, canGoBack: true, canGoForward: false });
    expect(calls.at(-1)).toEqual({ method: 'browser.update', params: { id: 'c0', tab: 't_1', url: 'https://a.test/x', title: 'A' } });
    bridge.emit({ type: 'browser.state', tab: 't_1', url: 'https://a.test/x', title: 'A', loading: false, canGoBack: true, canGoForward: false, error: 'The server cannot be found.' });
    expect(store.getState().webviews.t_1.error).toBe('The server cannot be found.');
  });

  it('registers a popup the shell opened under the character of the tab it came from, and frees it with its tab', async () => {
    const { bridge, calls, sent, store } = fakes();
    bridge.emit({ type: 'browser.opened', from: 't_2', tab: 't_pop00001', url: 'https://login.test/' });
    await new Promise((r) => setTimeout(r, 0));
    expect(calls.at(-1)).toEqual({ method: 'browser.open', params: { id: 'c0', tab: 't_pop00001', url: 'https://login.test/' } });
    // the view is on record even though no pane has placed it, so a tab closed before it was ever shown still frees it
    expect(store.getState().webviews.t_pop00001).toBeDefined();
    store.getState().applyPatch([{ op: 'add', path: '/characters/c0/browser/tabs/-', value: { id: 't_pop00001', url: 'https://login.test/', title: '' } }]);
    store.getState().applyPatch([{ op: 'remove', path: '/characters/c0/browser/tabs/2' }]);
    expect(sent.at(-1)).toEqual({ type: 'browser.close', tab: 't_pop00001' });
    expect(store.getState().webviews.t_pop00001).toBeUndefined();
  });

  it('closes a popup that closed itself before svalld had answered for it', async () => {
    const { bridge, calls, store } = fakes();
    bridge.emit({ type: 'browser.opened', from: 't_2', tab: 't_pop00002', url: 'https://probe.test/' });
    bridge.emit({ type: 'browser.closed', tab: 't_pop00002' });
    expect(calls.filter((k) => k.method === 'browser.close')).toEqual([]);
    await new Promise((r) => setTimeout(r, 0));
    expect(calls.at(-1)).toEqual({ method: 'browser.close', params: { id: 'c0', tab: 't_pop00002' } });
    expect(store.getState().webviews.t_pop00002).toBeUndefined();
  });

  it('drops the tab of a view that closed itself, and tells svalld once', () => {
    const { bridge, calls, sent, store, manager } = fakes();
    manager.show('c0', 't_1', rect);
    sent.length = 0;
    bridge.emit({ type: 'browser.closed', tab: 't_1' });
    expect(store.getState().webviews.t_1).toBeUndefined();
    expect(calls.filter((k) => k.method === 'browser.close')).toEqual([{ method: 'browser.close', params: { id: 'c0', tab: 't_1' } }]);
    // svalld drops the tab in answer; the patch finds no view left, so nothing bounces back to the shell
    store.getState().applyPatch([{ op: 'remove', path: '/characters/c0/browser/tabs/0' }, { op: 'replace', path: '/characters/c0/browser/active', value: 't_2' }]);
    expect(sent).toEqual([]);
    expect(calls.filter((k) => k.method === 'browser.close')).toHaveLength(1);
  });

  it('frees the view of a tab that left the fleet, and every view of a character that left', () => {
    const { sent, store, manager } = fakes();
    manager.show('c0', 't_1', rect);
    manager.show('c0', 't_2', rect);
    store.getState().applyPatch([{ op: 'remove', path: '/characters/c0/browser/tabs/0' }, { op: 'replace', path: '/characters/c0/browser/active', value: 't_2' }]);
    expect(sent.at(-1)).toEqual({ type: 'browser.close', tab: 't_1' });
    expect(store.getState().webviews.t_1).toBeUndefined();
    store.getState().applyPatch([{ op: 'remove', path: '/characters/c0' }]);
    expect(sent.at(-1)).toEqual({ type: 'browser.close', tab: 't_2' });
    expect(store.getState().webviews).toEqual({});
  });

  it('asks by the pointer where a link followed in a terminal opens, and opens nothing yet', () => {
    const { bridge, calls, store } = fakes();
    bridge.emit({ type: 'term.openUrl', id: 'c0-2', url: 'https://ticket.test/1', x: 120, y: 340 });
    expect(store.getState().linkAsk).toEqual({ url: 'https://ticket.test/1', charId: 'c0', x: 120, y: 340, surface: 'c0-2' });
    expect(calls.filter((k) => k.method === 'browser.open')).toEqual([]);
  });

  it('sends a link the browser cannot hold, and one of a character that is gone, out of the app', () => {
    const { bridge, calls, sent, store } = fakes();
    bridge.emit({ type: 'term.openUrl', id: 'c0', url: 'mailto:a@b.test', x: 0, y: 0 });
    expect(sent.at(-1)).toEqual({ type: 'openUrl', url: 'mailto:a@b.test' });
    store.getState().applyPatch([{ op: 'remove', path: '/characters/c0' }]);
    bridge.emit({ type: 'term.openUrl', id: 'c0', url: 'https://ticket.test/1', x: 0, y: 0 });
    expect(sent.at(-1)).toEqual({ type: 'openUrl', url: 'https://ticket.test/1' });
    expect(store.getState().linkAsk).toBeUndefined();
    expect(calls.filter((k) => k.method === 'browser.open')).toEqual([]);
  });

  it('loads into the active tab or opens a first one, and steps history', () => {
    const { sent, calls, manager } = fakes();
    manager.show('c0', 't_1', rect);
    manager.load('c0', 't_1', 'b.test');
    expect(sent.at(-1)).toEqual({ type: 'browser.load', tab: 't_1', url: 'https://b.test' });
    manager.load('c0', undefined, 'c.test');
    expect(calls.at(-1)).toEqual({ method: 'browser.open', params: { id: 'c0', url: 'https://c.test' } });
    manager.go('t_1', 'back');
    expect(sent.at(-1)).toEqual({ type: 'browser.go', tab: 't_1', action: 'back' });
  });
});
