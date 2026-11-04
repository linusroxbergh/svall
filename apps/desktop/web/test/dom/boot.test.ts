// @vitest-environment jsdom
import { expect, test, vi } from 'vitest';
import type { MachineId } from '@svall/protocol';
import { app, deps, initApp } from '../../src/boot.js';

test('initApp builds the app once and the facade reads it', () => {
  const ctx = initApp();
  expect(initApp()).toBe(ctx);
  expect(app.store).toBe(ctx.store);
  expect(app.bridge).toBe(ctx.bridge);
  // no shell and no port in the url, so nothing connected and the socket is still out of reach
  expect(() => app.api()).toThrow('svalld not connected');
  expect(() => deps()).toThrow('svalld not connected');
  expect(ctx.store.getState().loaded).toBe(false);
});

test('the app keeps its settings under the fleet the shell names', async () => {
  const saved = new Map<string, string>();
  vi.stubGlobal('localStorage', { getItem: (k: string) => saved.get(k) ?? null, setItem: (k: string, v: string) => saved.set(k, v) });
  vi.resetModules();
  window.__svallHome = '/Users/me/.svall-work';
  const fresh = await import('../../src/boot.js');
  fresh.initApp().store.getState().setView('board');
  expect(saved.get('svall.view@/Users/me/.svall-work')).toBe('board');
  delete window.__svallHome;
});

test('Send Feedback… opens the form from the menu although svalld never connected', async () => {
  const sent: string[] = [];
  (window as unknown as { webkit: unknown }).webkit = { messageHandlers: { svall: { postMessage: (m: string) => sent.push(m) } } };
  vi.resetModules();
  const fresh = await import('../../src/boot.js');
  const { store } = fresh.initApp();
  window.__svall!.receive(JSON.stringify({ type: 'menu.run', action: 'feedback' }));
  expect(store.getState().feedbackOpen).toBe(true);
  expect(() => fresh.app.api()).toThrow('svalld not connected');
  delete (window as unknown as { webkit?: unknown }).webkit;
});

test('the shell names this machine, and a local action it refuses is said on a toast', async () => {
  (window as unknown as { webkit: unknown }).webkit = { messageHandlers: { svall: { postMessage: () => {} } } };
  vi.resetModules();
  const fresh = await import('../../src/boot.js');
  const { store } = fresh.initApp();
  const receive = (m: object) => window.__svall!.receive(JSON.stringify(m));
  receive({ type: 'shell.info', home: '/h', log: [], op: false, ghosttyKeys: {}, machine: 'mac-id' });
  expect(store.getState().shell?.machine).toBe('mac-id');
  receive({ type: 'shell.info', home: '/h', log: [], op: false, ghosttyKeys: {}, machine: '' });
  expect(store.getState().shell?.machine).toBeUndefined();
  const studio = '22222222-2222-4222-8222-222222222222';
  store.getState().setFleet({ ...store.getState().fleet, machines: { [studio as MachineId]: { name: 'studio', reachable: true, since: 0 } } });
  receive({ type: 'local.unavailable', action: 'reveal', machine: studio });
  expect(store.getState().toast?.text).toBe('This Mac cannot open that: it is on studio');
  receive({ type: 'local.unavailable', action: 'folder.pick', machine: '' });
  expect(store.getState().toast?.text).toBe('This Mac cannot open that yet; try again');
  delete (window as unknown as { webkit?: unknown }).webkit;
});
