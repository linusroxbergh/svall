// @vitest-environment jsdom
import './setup.js';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, expect, test, vi } from 'vitest';
import type { FromShell, ToShell } from '../../src/bridge.js';
import { setAppStore } from '../../src/hooks.js';
import { createAppStore, type AppStore } from '../../src/store/index.js';
import { fleet } from '../fixtures.js';

const call = vi.fn((_method: string, _params: unknown) => Promise.resolve({}));
const sent: ToShell[] = [];
const handlers = new Set<(m: FromShell) => void>();
const shell = (m: FromShell) => { for (const h of handlers) h(m); };
const bridge = {
  present: true,
  send: (m: ToShell) => { sent.push(m); },
  onMessage: (h: (m: FromShell) => void) => { handlers.add(h); return () => { handlers.delete(h); }; },
};
let store: AppStore;
vi.mock('../../src/boot.js', () => ({
  app: { get store() { return store; }, bridge, api: () => ({ call }) },
  deps: () => ({ api: { call }, store, bridge }),
}));

const { Sidebar } = await import('../../src/Sidebar.js');

beforeEach(() => {
  sent.length = 0;
  handlers.clear();
  bridge.present = true;
  store = createAppStore();
  setAppStore(store);
  store.getState().setFleet(fleet());
  render(<Sidebar />);
});

// fireEvent returns false when a listener called preventDefault, which is what keeps WebKit's own menu away
const rightClick = (testid: string): boolean => !fireEvent.contextMenu(screen.getByTestId(testid), { clientX: 40, clientY: 90 });

test('a character row asks the shell for a menu at the pointer, and Delete opens the delete confirmation', () => {
  expect(rightClick('sb-char-c0')).toBe(true);
  expect(sent).toEqual([{ type: 'menu', x: 40, y: 90, items: [{ id: '0', title: 'Delete', enabled: true }] }]);
  shell({ type: 'menu.pick', id: '0' });
  expect(store.getState().closingCharacter).toBe('c0');
  expect(call).not.toHaveBeenCalled();
});

test('an empty island offers Delete, which opens the island confirmation', () => {
  rightClick('sb-island-i_e');
  expect(sent).toEqual([{ type: 'menu', x: 40, y: 90, items: [{ id: '0', title: 'Delete', enabled: true }] }]);
  shell({ type: 'menu.pick', id: '0' });
  expect(store.getState().deletingIsland).toBe('i_e');
});

test('an island with characters shows Delete greyed out, as the daemon refuses it', () => {
  rightClick('sb-island-i_b');
  expect(sent).toEqual([{ type: 'menu', x: 40, y: 90, items: [{ id: '0', title: 'Delete', enabled: false }] }]);
});

test('mission control, an island being renamed, and a page without the shell keep the default menu', () => {
  expect(rightClick('sb-island-home')).toBe(false);
  fireEvent.doubleClick(screen.getByTestId('sb-island-i_a'));
  expect(rightClick('island-name-input')).toBe(false);
  bridge.present = false;
  expect(rightClick('sb-char-c2')).toBe(false);
  expect(sent).toEqual([]);
});

test('a pick answers the latest menu only', () => {
  rightClick('sb-island-i_e');
  rightClick('sb-char-c2');
  shell({ type: 'menu.pick', id: '0' });
  expect(store.getState().closingCharacter).toBe('c2');
  expect(store.getState().deletingIsland).toBeUndefined();
});

test('the sidebar holds its animation still while the app is in the background', () => {
  const paused = () => screen.getByTestId('sidebar').getAttribute('data-paused');
  expect(paused()).toBe('false');
  act(() => store.getState().setActive(false));
  expect(paused()).toBe('true');
});
