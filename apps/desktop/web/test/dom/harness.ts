import './setup.js';
import { vi } from 'vitest';
import type { FromShell, ToShell } from '../../src/bridge.js';
import { setAppStore } from '../../src/hooks.js';
import { createAppStore, type AppStore } from '../../src/store/index.js';
import { fleet } from '../fixtures.js';

// what boot.js gives the page, for a DOM test to mock it with:
// vi.mock('../../src/boot.js', async () => (await import('./harness.js')).bootModule());
export const call = vi.fn((_method: string, _params?: unknown): Promise<unknown> => Promise.resolve({}));
export const sent: ToShell[] = [];
const handlers = new Set<(m: FromShell) => void>();
/** A message from the native shell to every handler the page has registered. */
export const shell = (m: FromShell): void => { for (const h of handlers) h(m); };
export const bridge = {
  present: false,
  send: (m: ToShell) => { sent.push(m); },
  onMessage: (h: (m: FromShell) => void) => { handlers.add(h); return () => { handlers.delete(h); }; },
};
const manager = { show: vi.fn(() => Promise.resolve()), move: vi.fn(), hide: vi.fn() };
export let store: AppStore;

/** A store holding the fixture fleet, with what the shell was sent and the calls made forgotten. */
export function freshStore(make: () => AppStore = () => createAppStore()): AppStore {
  sent.length = 0;
  handlers.clear();
  call.mockClear();
  store = make();
  setAppStore(store);
  store.getState().setFleet(fleet());
  return store;
}

export const bootModule = () => ({
  app: { get store() { return store; }, bridge, api: () => ({ call }), manager: () => manager, browser: () => ({ move() {} }) },
  deps: () => ({ api: { call }, store, bridge }),
});
