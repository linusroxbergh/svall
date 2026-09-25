// @vitest-environment jsdom
import { expect, test, vi } from 'vitest';
import { app, deps, initApp } from '../../src/boot.js';

test('initApp builds the app once and the facade reads it', () => {
  const ctx = initApp();
  expect(initApp()).toBe(ctx);
  expect(app.store).toBe(ctx.store);
  expect(app.bridge).toBe(ctx.bridge);
  // no shell and no port in the url, so nothing connected and the socket is still out of reach
  expect(() => app.api()).toThrow('archid not connected');
  expect(() => deps()).toThrow('archid not connected');
  expect(ctx.store.getState().loaded).toBe(false);
});

test('the app keeps its settings under the fleet the shell names', async () => {
  const saved = new Map<string, string>();
  vi.stubGlobal('localStorage', { getItem: (k: string) => saved.get(k) ?? null, setItem: (k: string, v: string) => saved.set(k, v) });
  vi.resetModules();
  window.__archiHome = '/Users/me/.archipelago-work';
  const fresh = await import('../../src/boot.js');
  fresh.initApp().store.getState().setView('board');
  expect(saved.get('archi.view@/Users/me/.archipelago-work')).toBe('board');
  delete window.__archiHome;
  vi.unstubAllGlobals();
});
