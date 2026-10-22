// @vitest-environment jsdom
import { expect, test, vi } from 'vitest';
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
  vi.unstubAllGlobals();
});

test('follows a handover once the shell says handover is on, and asks for none while it is off', async () => {
  const sent: { type: string }[] = [];
  window.webkit = { messageHandlers: { svall: { postMessage: (json: string) => { sent.push(JSON.parse(json) as { type: string }); } } } };
  vi.resetModules();
  const fresh = await import('../../src/boot.js');
  fresh.initApp();
  const info = (handoverEnabled: boolean) => window.__svall!.receive(JSON.stringify({ type: 'shell.info', home: '/u/.svall', log: [], op: false, handoverEnabled }));
  const attaches = () => sent.filter((m) => m.type === 'handover.attach').length;
  info(false);
  expect(attaches()).toBe(0);
  info(true);
  info(true);
  expect(attaches()).toBe(1);
  delete window.webkit;
});
