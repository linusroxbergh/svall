// @vitest-environment jsdom
import './setup.js';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, expect, test, vi } from 'vitest';
import { setAppStore } from '../../src/hooks.js';
import { createAppStore, type AppStore } from '../../src/store/index.js';
import { fleet } from '../fixtures.js';

const call = vi.fn(() => new Promise(() => {}));
const bridge = { present: false, send() {}, onMessage: () => () => {} };
let store: AppStore;
vi.mock('../../src/boot.js', () => ({
  app: { get store() { return store; }, bridge, api: () => ({ call }) },
  deps: () => ({ api: { call }, store, bridge }),
}));

const { UtilityDock } = await import('../../src/UtilityDock.js');

beforeEach(() => {
  store = createAppStore();
  setAppStore(store);
  store.getState().setFleet(fleet());
});

// the map calls preventDefault on its presses, and WebKit then sends no mousedown
test('a press on the map closes the usage panel', async () => {
  store.getState().toggleUsage(true);
  render(<><div data-testid="map" /><UtilityDock /></>);
  await act(async () => {});
  act(() => { fireEvent.pointerDown(screen.getByTestId('map')); });
  expect(store.getState().usageOpen).toBe(false);
});

test('the settings button names the key the user bound, not the one it shipped with', () => {
  render(<UtilityDock />);
  expect(screen.getByTestId('settings-open').title).toBe('Settings (⌘,)');
  act(() => store.getState().setSettings({ bindings: { toggleSettings: 'cmd+shift+o' } }));
  expect(screen.getByTestId('settings-open').title).toBe('Settings (⌘⇧O)');
});

test('the settings button carries a dot only while an update waits', () => {
  render(<UtilityDock />);
  expect(screen.queryByTestId('settings-update')).toBeNull();
  act(() => store.getState().setUpdate('0.2.1'));
  expect(screen.getByTestId('settings-update')).toBeTruthy();
  expect(screen.getByTestId('settings-open').getAttribute('aria-label')).toBe('Settings, update available');
  act(() => store.getState().setUpdate(undefined));
  expect(screen.queryByTestId('settings-update')).toBeNull();
  expect(screen.getByTestId('settings-open').getAttribute('aria-label')).toBe('Settings');
});
