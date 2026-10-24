// @vitest-environment jsdom
import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, expect, test, vi } from 'vitest';
import { bridge, call, freshStore, sent, store } from './harness.js';

call.mockImplementation(() => new Promise(() => {}));
vi.mock('../../src/boot.js', async () => (await import('./harness.js')).bootModule());

const { UtilityDock } = await import('../../src/UtilityDock.js');
const { ConfirmSleep } = await import('../../src/Confirm.js');

beforeEach(() => {
  freshStore();
});

// the map calls preventDefault on its presses, and WebKit then sends no mousedown
test('a press on the map closes the usage panel', async () => {
  store.getState().toggleUsage(true);
  render(<><div data-testid="map" /><UtilityDock /></>);
  await act(async () => {});
  act(() => { fireEvent.pointerDown(screen.getByTestId('map')); });
  expect(store.getState().usageOpen).toBe(false);
});

test('the × closes the open panel and hands the keys back to the terminal', async () => {
  bridge.present = true;
  try {
    act(() => { store.getState().setView('board'); store.getState().focus('c0'); });
    store.getState().toggleLoad(true);
    render(<UtilityDock />);
    await act(async () => {});
    sent.length = 0;
    fireEvent.click(screen.getByTestId('corner-panel-close'));
    const s = store.getState();
    expect([s.usageOpen, s.mobileOpen, s.loadOpen]).toEqual([false, false, false]);
    expect(sent).toContainEqual({ type: 'term.focus', id: 'c0' });
  } finally {
    bridge.present = false;
  }
});

// the dialogs a panel's buttons open stand outside the dock
test('answering a dialog the load panel opened leaves the panel open', async () => {
  store.getState().toggleLoad(true);
  render(<><div data-testid="map" /><UtilityDock /><ConfirmSleep /></>);
  await act(async () => {});
  act(() => store.getState().setSleepingRobot('c1'));
  act(() => { fireEvent.pointerDown(screen.getByTestId('confirm-sleep-cancel')); });
  expect(store.getState().loadOpen).toBe(true);
  act(() => { fireEvent.pointerDown(screen.getByTestId('map')); });
  expect(store.getState().loadOpen).toBe(false);
});

test('the settings button names the key the user bound, not the one it shipped with', () => {
  render(<UtilityDock />);
  expect(screen.getByTestId('settings-open').title).toBe('Settings (⌘,)');
  act(() => store.getState().setSettings({ bindings: { toggleSettings: 'cmd+shift+o' } }));
  expect(screen.getByTestId('settings-open').title).toBe('Settings (⌘⇧O)');
});

test('the settings button carries a dot only while an update waits and the sidebar is hidden', () => {
  render(<UtilityDock />);
  expect(screen.queryByTestId('settings-update')).toBeNull();
  act(() => store.getState().setUpdate('0.2.1'));
  expect(screen.queryByTestId('settings-update')).toBeNull();
  act(() => store.getState().toggleSidebar(false));
  expect(screen.getByTestId('settings-update')).toBeTruthy();
  expect(screen.getByTestId('settings-open').getAttribute('aria-label')).toBe('Settings, update available');
  act(() => store.getState().setUpdate(undefined));
  expect(screen.queryByTestId('settings-update')).toBeNull();
  expect(screen.getByTestId('settings-open').getAttribute('aria-label')).toBe('Settings');
});
