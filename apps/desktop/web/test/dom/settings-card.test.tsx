// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, expect, test, vi } from 'vitest';
import { fleet } from '../fixtures.js';
import { bridge, call, freshStore, sent, store } from './harness.js';

call.mockImplementation(() => Promise.resolve({ serving: false, logins: [], phones: [] }));
bridge.present = true;
vi.mock('../../src/boot.js', async () => (await import('./harness.js')).bootModule());

const { SettingsCard } = await import('../../src/SettingsCard.js');

beforeEach(() => {
  freshStore();
});

// the app's webview refuses to navigate away from the app, so an outside link goes through the shell
test('the Tailscale link in the phone tip opens in the default browser', () => {
  render(<SettingsCard />);
  const link = screen.getByRole('link', { name: 'Tailscale' });
  expect(fireEvent.click(link)).toBe(false);
  expect(sent).toContainEqual({ type: 'openUrl', url: 'https://tailscale.com/download' });
});

test('the fleet name saves on Enter and retitles the window, and a name that will not do says why and is not sent', async () => {
  render(<SettingsCard />);
  const input = screen.getByTestId('set-fleet-name') as HTMLInputElement;
  expect(['autocapitalize', 'autocorrect', 'spellcheck', 'autocomplete'].map((a) => input.getAttribute(a))).toEqual(['off', 'off', 'false', 'off']);
  input.focus();
  fireEvent.change(input, { target: { value: 'Big Base' } });
  fireEvent.keyDown(input, { key: 'Enter' });
  expect(screen.getByTestId('set-fleet-name-error').textContent).toMatch(/lowercase/);
  expect(call).not.toHaveBeenCalledWith('fleet.rename', expect.anything());
  input.focus();
  fireEvent.change(input, { target: { value: 'base' } });
  fireEvent.keyDown(input, { key: 'Enter' });
  await waitFor(() => expect(sent).toContainEqual({ type: 'retitle' }));
  expect(call).toHaveBeenCalledWith('fleet.rename', { name: 'base' });
  expect(screen.queryByTestId('set-fleet-name-error')).toBeNull();
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

test('turned off in System Settings, the switch still asks macOS and the card points there', () => {
  store.getState().setNotifyPermission('denied');
  render(<SettingsCard />);
  expect(screen.getByTestId('set-notify-denied')).toBeTruthy();
  fireEvent.click(screen.getByTestId('set-notify'));
  expect(sent).toContainEqual({ type: 'notify.enable' });
  expect(store.getState().settings.notifications.on).toBe(true);
  expect(checked('set-notify')).toBe('false');
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

test('the zoom tip names the keys as bound, and leaves out one that is unbound', () => {
  render(<SettingsCard />);
  const tip = () => document.getElementById('set-tip-zoom')!.textContent;
  expect(tip()).toBe('⌘− and ⌘+ scale the map, panels and terminal text. ⌘0 sets 100%.');
  act(() => store.getState().setSettings({ bindings: { zoomIn: 'cmd+shift+i', zoomReset: null } }));
  expect(tip()).toBe('⌘− and ⌘⇧I scale the map, panels and terminal text.');
  act(() => store.getState().setSettings({ bindings: { zoomOut: null } }));
  expect(tip()).toBe('Scales the map, panels and terminal text. ⌘0 sets 100%.');
});

test('the worktree switch reads the fleet and flips it', () => {
  call.mockClear();
  render(<SettingsCard />);
  const sw = () => screen.getByTestId('set-worktrees');
  expect(sw().getAttribute('aria-checked')).toBe('true');
  fireEvent.click(sw());
  expect(call).toHaveBeenCalledWith('worktrees.set', { enabled: false });
  act(() => store.getState().setFleet({ ...fleet(), worktreesOff: true }));
  expect(sw().getAttribute('aria-checked')).toBe('false');
  fireEvent.click(sw());
  expect(call).toHaveBeenCalledWith('worktrees.set', { enabled: true });
});

test('the robots switch reads the fleet and flips it', () => {
  call.mockClear();
  render(<SettingsCard />);
  const sw = () => screen.getByTestId('set-robots');
  expect(sw().getAttribute('aria-checked')).toBe('false');
  fireEvent.click(sw());
  expect(call).toHaveBeenCalledWith('robots.set', { enabled: true });
  act(() => store.getState().setFleet({ ...fleet(), robots: true }));
  expect(sw().getAttribute('aria-checked')).toBe('true');
  fireEvent.click(sw());
  expect(call).toHaveBeenCalledWith('robots.set', { enabled: false });
});

test('dormancy steps two hours at a time from 2 to 48, then never', () => {
  call.mockClear();
  render(<SettingsCard />);
  expect(screen.getByTestId('dormancy-level').textContent).toBe('12 hours');
  fireEvent.click(screen.getByTestId('dormancy-more'));
  expect(call).toHaveBeenCalledWith('dormancy.set', { hours: 14 });
  fireEvent.click(screen.getByTestId('dormancy-less'));
  expect(call).toHaveBeenCalledWith('dormancy.set', { hours: 10 });
  act(() => store.getState().setFleet({ ...fleet(), dormantAfterHours: 2 }));
  expect(screen.getByTestId('dormancy-level').textContent).toBe('2 hours');
  expect((screen.getByTestId('dormancy-less') as HTMLButtonElement).disabled).toBe(true);
  act(() => store.getState().setFleet({ ...fleet(), dormantAfterHours: 48 }));
  expect(screen.getByTestId('dormancy-level').textContent).toBe('2 days');
  fireEvent.click(screen.getByTestId('dormancy-more'));
  expect(call).toHaveBeenCalledWith('dormancy.set', { hours: 0 });
  call.mockClear();
  act(() => store.getState().setFleet({ ...fleet(), dormantAfterHours: 0 }));
  expect(screen.getByTestId('dormancy-level').textContent).toBe('never');
  expect((screen.getByTestId('dormancy-more') as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(screen.getByTestId('dormancy-less'));
  expect(call).toHaveBeenCalledWith('dormancy.set', { hours: 48 });
});

test('a wait off the steps moves to the nearest step either side', () => {
  call.mockClear();
  act(() => store.getState().setFleet({ ...fleet(), dormantAfterHours: 72 }));
  render(<SettingsCard />);
  expect(screen.getByTestId('dormancy-level').textContent).toBe('3 days');
  fireEvent.click(screen.getByTestId('dormancy-less'));
  expect(call).toHaveBeenCalledWith('dormancy.set', { hours: 48 });
  fireEvent.click(screen.getByTestId('dormancy-more'));
  expect(call).toHaveBeenCalledWith('dormancy.set', { hours: 0 });
});

test('main agent picks between the CLIs svalld finds', () => {
  act(() => store.getState().setFleet({ ...fleet(), mainAgent: 'claude', agentsFound: ['claude', 'codex'] }));
  render(<SettingsCard />);
  const pick = screen.getByTestId('set-main-agent') as HTMLSelectElement;
  expect(pick.value).toBe('claude');
  fireEvent.change(pick, { target: { value: 'codex' } });
  expect(call).toHaveBeenCalledWith('mainAgent.set', { agent: 'codex' });
});

test('main agent disables a CLI svalld does not find', () => {
  act(() => store.getState().setFleet({ ...fleet(), mainAgent: 'claude', agentsFound: ['claude'] }));
  render(<SettingsCard />);
  const codex = screen.getByRole('option', { name: /^Codex/ }) as HTMLOptionElement;
  expect(codex.disabled).toBe(true);
  expect(codex.textContent).toBe('Codex (not found: install it, then svall-dev setup)');
});

test('the update section stands at the foot only while an update waits, and its button asks the shell to install', () => {
  render(<SettingsCard />);
  expect(screen.queryByTestId('set-update')).toBeNull();
  act(() => store.getState().setUpdate('0.2.1'));
  expect(screen.getByTestId('settings').lastElementChild?.textContent).toContain('Svall 0.2.1 is out');
  fireEvent.click(screen.getByTestId('set-update'));
  expect(sent).toContainEqual({ type: 'update.install' });
  act(() => store.getState().setUpdate(undefined));
  expect(screen.queryByTestId('set-update')).toBeNull();
});
