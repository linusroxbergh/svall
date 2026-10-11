// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, expect, test, vi } from 'vitest';
import { fleet } from '../fixtures.js';
import { bridge, call, freshStore, sent, shell, store } from './harness.js';

call.mockImplementation(() => Promise.resolve({ serving: false, logins: [], phones: [] }));
bridge.present = true;
vi.mock('../../src/boot.js', async () => (await import('./harness.js')).bootModule());

const { SettingsCard } = await import('../../src/SettingsCard.js');

beforeEach(() => {
  freshStore();
});

const show = (pane: string) => fireEvent.click(screen.getByTestId(`settings-tab-${pane}`));

// the app's webview refuses to navigate away from the app, so an outside link goes through the shell
test('the Tailscale link in the phone tip opens in the default browser', () => {
  render(<SettingsCard />);
  show('phone');
  const link = screen.getByRole('link', { name: 'Tailscale' });
  expect(fireEvent.click(link)).toBe(false);
  expect(sent).toContainEqual({ type: 'openUrl', url: 'https://tailscale.com/download' });
});

test('the fleet name saves on Enter and retitles the window, and a name that will not do says why and is not sent', async () => {
  render(<SettingsCard />);
  show('fleet');
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
  show('notifications');
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
  show('notifications');
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
  show('notifications');
  expect(screen.getByTestId('set-notify-denied')).toBeTruthy();
  fireEvent.click(screen.getByTestId('set-notify'));
  expect(sent).toContainEqual({ type: 'notify.enable' });
  expect(store.getState().settings.notifications.on).toBe(true);
  expect(checked('set-notify')).toBe('false');
  fireEvent.click(screen.getByTestId('set-notify-settings'));
  expect(sent).toContainEqual({ type: 'notify.settings' });
});

test('outside the app there is no shell to post banners or hold the Mac awake, so neither shows', () => {
  bridge.present = false;
  try {
    render(<SettingsCard />);
    expect(screen.queryByTestId('settings-tab-notifications')).toBeNull();
    expect(screen.queryByTestId('set-keep-awake')).toBeNull();
  } finally {
    bridge.present = true;
  }
});

test('keep Mac awake holds while agents work or need you until another is picked', () => {
  render(<SettingsCard />);
  const pick = screen.getByTestId('set-keep-awake') as HTMLSelectElement;
  expect(pick.value).toBe('needs');
  fireEvent.change(pick, { target: { value: 'off' } });
  expect(store.getState().settings.keepAwake).toBe('off');
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
  show('fleet');
  const sw = () => screen.getByTestId('set-worktrees');
  expect(sw().getAttribute('aria-checked')).toBe('true');
  fireEvent.click(sw());
  expect(call).toHaveBeenCalledWith('worktrees.set', { enabled: false });
  act(() => store.getState().setFleet({ ...fleet(), worktreesOff: true }));
  expect(sw().getAttribute('aria-checked')).toBe('false');
  fireEvent.click(sw());
  expect(call).toHaveBeenCalledWith('worktrees.set', { enabled: true });
});

test('the characters toggle reads the fleet, robots by default, and picks animals or robots', () => {
  call.mockClear();
  render(<SettingsCard />);
  show('fleet');
  const pick = (name: string) => screen.getByRole('radiogroup', { name: 'Characters' }).querySelector(`[role="radio"][data-pick="${name}"]`)!;
  expect(pick('robots').getAttribute('aria-checked')).toBe('true');
  expect(pick('animals').getAttribute('aria-checked')).toBe('false');
  fireEvent.click(pick('animals'));
  expect(call).toHaveBeenCalledWith('robots.set', { enabled: false });
  act(() => store.getState().setFleet({ ...fleet(), animals: true }));
  expect(pick('animals').getAttribute('aria-checked')).toBe('true');
  expect(pick('robots').getAttribute('aria-checked')).toBe('false');
  fireEvent.click(pick('robots'));
  expect(call).toHaveBeenCalledWith('robots.set', { enabled: true });
});

test('dormancy steps two hours at a time from 2 to 48, then never', () => {
  call.mockClear();
  render(<SettingsCard />);
  show('fleet');
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
  show('fleet');
  expect(screen.getByTestId('dormancy-level').textContent).toBe('3 days');
  fireEvent.click(screen.getByTestId('dormancy-less'));
  expect(call).toHaveBeenCalledWith('dormancy.set', { hours: 48 });
  fireEvent.click(screen.getByTestId('dormancy-more'));
  expect(call).toHaveBeenCalledWith('dormancy.set', { hours: 0 });
});

test('main agent picks between the CLIs svalld finds', () => {
  act(() => store.getState().setFleet({ ...fleet(), mainAgent: 'claude', agentsFound: ['claude', 'codex'] }));
  render(<SettingsCard />);
  show('fleet');
  const pick = screen.getByTestId('set-main-agent') as HTMLSelectElement;
  expect(pick.value).toBe('claude');
  fireEvent.change(pick, { target: { value: 'codex' } });
  expect(call).toHaveBeenCalledWith('mainAgent.set', { agent: 'codex' });
});

test('main agent disables a CLI svalld does not find', () => {
  act(() => store.getState().setFleet({ ...fleet(), mainAgent: 'claude', agentsFound: ['claude'] }));
  render(<SettingsCard />);
  show('fleet');
  const codex = screen.getByRole('option', { name: /^Codex/ }) as HTMLOptionElement;
  expect(codex.disabled).toBe(true);
  expect(codex.textContent).toBe('Codex (not found: install it, then svall-dev setup)');
});

test('the updates pane is listed only while an update waits, its button asks the shell to install, and its going shows the first pane', () => {
  render(<SettingsCard />);
  expect(screen.queryByTestId('settings-tab-updates')).toBeNull();
  act(() => store.getState().setUpdate('0.2.1'));
  show('updates');
  expect(screen.getByRole('tabpanel').textContent).toContain('Svall 0.2.1 is out');
  fireEvent.click(screen.getByTestId('set-update'));
  expect(sent).toContainEqual({ type: 'update.install' });
  act(() => store.getState().setUpdate(undefined));
  expect(screen.queryByTestId('settings-tab-updates')).toBeNull();
  expect(screen.getByTestId('settings-tab-machine').getAttribute('aria-selected')).toBe('true');
  expect(screen.getByTestId('set-robot-motion')).toBeTruthy();
});

test('the keyboard pane lists the shortcuts in place, and leaving it while a row waits stops the listening', () => {
  render(<SettingsCard />);
  show('keyboard');
  fireEvent.click(screen.getByTestId('key-quit'));
  expect(store.getState().capturingKey).toBe('quit');
  expect(screen.getByTestId('key-quit').textContent).toBe('press a key');
  show('machine');
  expect(screen.queryByTestId('key-quit')).toBeNull();
  expect(store.getState().capturingKey).toBeUndefined();
});

test('a press anywhere but the waiting row stops the listening, so the next chord is not taken', () => {
  render(<SettingsCard />);
  show('keyboard');
  const quit = screen.getByTestId('key-quit');
  for (const away of [() => fireEvent.pointerDown(document.body), () => act(() => shell({ type: 'shell.pressedAway' }))]) {
    fireEvent.click(quit);
    fireEvent.pointerDown(quit);
    expect(store.getState().capturingKey).toBe('quit');
    away();
    expect(store.getState().capturingKey).toBeUndefined();
    expect(quit.textContent).not.toBe('press a key');
  }
});

test('robot motion starts on, and its switch turns the stored setting off', () => {
  render(<SettingsCard />);
  expect(checked('set-robot-motion')).toBe('true');
  fireEvent.click(screen.getByTestId('set-robot-motion'));
  expect(store.getState().settings.robotMotion).toBe(false);
  expect(checked('set-robot-motion')).toBe('false');
});
