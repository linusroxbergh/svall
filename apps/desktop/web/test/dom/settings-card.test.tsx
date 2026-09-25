// @vitest-environment jsdom
import './setup.js';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, expect, test, vi } from 'vitest';
import type { ToShell } from '../../src/bridge.js';
import { setAppStore } from '../../src/hooks.js';
import { createAppStore, type AppStore } from '../../src/store/index.js';
import { fleet } from '../fixtures.js';

const call = vi.fn((_method: string, _params?: unknown) => Promise.resolve({ serving: false, logins: [], phones: [] }));
const sent: ToShell[] = [];
const bridge = { present: true, send: (m: ToShell) => { sent.push(m); }, onMessage: () => () => {} };
let store: AppStore;
vi.mock('../../src/boot.js', () => ({
  app: { get store() { return store; }, bridge, api: () => ({ call }) },
  deps: () => ({ api: { call }, store, bridge }),
}));

const { SettingsCard } = await import('../../src/SettingsCard.js');

beforeEach(() => {
  sent.length = 0;
  store = createAppStore();
  setAppStore(store);
  store.getState().setFleet(fleet());
});

// the app's webview refuses to navigate away from the app, so an outside link goes through the shell
test('the Tailscale link in the phone tip opens in the default browser', () => {
  render(<SettingsCard />);
  const link = screen.getByRole('link', { name: 'Tailscale' });
  expect(fireEvent.click(link)).toBe(false);
  expect(sent).toContainEqual({ type: 'openUrl', url: 'https://tailscale.com/download' });
});

const checked = (id: string) => screen.getByTestId(id).getAttribute('aria-checked');

test('the notifications switch asks macOS the first time, and reads on once macOS allows it', () => {
  render(<SettingsCard />);
  expect(checked('set-notify')).toBe('false');
  fireEvent.click(screen.getByTestId('set-notify'));
  expect(sent).toContainEqual({ type: 'notify.enable' });
  expect(store.getState().settings.notifications.on).toBe(true);
  expect(checked('set-notify')).toBe('false');
  act(() => store.getState().setNotifyPermission('granted'));
  expect(checked('set-notify')).toBe('true');
  expect(checked('set-notify-sound')).toBe('true');
});

test('sound and the two events are switched one by one', () => {
  store.getState().setNotifyPermission('granted');
  store.getState().setSettings({ notifications: { on: true, sound: true, statuses: ['blocked', 'done'] } });
  render(<SettingsCard />);
  fireEvent.click(screen.getByTestId('set-notify-done'));
  expect(store.getState().settings.notifications.statuses).toEqual(['blocked']);
  fireEvent.click(screen.getByTestId('set-notify-sound'));
  expect(store.getState().settings.notifications.sound).toBe(false);
  fireEvent.click(screen.getByTestId('set-notify'));
  expect(store.getState().settings.notifications.on).toBe(false);
  expect(screen.queryByTestId('set-notify-sound')).toBeNull();
  expect(sent).not.toContainEqual({ type: 'notify.enable' });
});

test('turned off in System Settings, the switch is disabled and the card points there', () => {
  store.getState().setNotifyPermission('denied');
  render(<SettingsCard />);
  expect((screen.getByTestId('set-notify') as HTMLButtonElement).disabled).toBe(true);
  expect(screen.getByTestId('set-notify-denied')).toBeTruthy();
  fireEvent.click(screen.getByTestId('set-notify-settings'));
  expect(sent).toContainEqual({ type: 'notify.settings' });
});

test('outside the app there is no shell to post banners, so the section is absent', () => {
  bridge.present = false;
  try {
    render(<SettingsCard />);
    expect(screen.queryByTestId('set-notify')).toBeNull();
  } finally {
    bridge.present = true;
  }
});
