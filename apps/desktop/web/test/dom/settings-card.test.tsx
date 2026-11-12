// @vitest-environment jsdom
import fs from 'node:fs';
import path from 'node:path';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { MachineId } from '@svall/protocol';
import { fleet } from '../fixtures.js';
import { bridge, call, freshStore, sent, shell, store } from './harness.js';

call.mockImplementation(() => Promise.resolve({ serving: false, logins: [], phones: [] }));
bridge.present = true;
vi.mock('../../src/boot.js', async () => (await import('./harness.js')).bootModule());

const { SettingsCard } = await import('../../src/SettingsCard.js');
const { dropBuffer, getBuffer, isDirty } = await import('../../src/ide/buffers.js');
const { openFile, saveFile } = await import('../../src/ide/files.js');
const { deps } = await import('../../src/boot.js');

beforeEach(() => {
  freshStore();
});

const show = (pane: string) => fireEvent.click(screen.getByTestId(`settings-tab-${pane}`));

// the app's webview refuses to navigate away from the app, so an outside link goes through the shell
test('the Tailscale link in the phone tip opens in the default browser', async () => {
  render(<SettingsCard />);
  show('phone');
  const link = await screen.findByRole('link', { name: 'Tailscale' });
  expect(fireEvent.click(link)).toBe(false);
  expect(sent).toContainEqual({ type: 'openUrl', url: 'https://tailscale.com/download' });
});

test('the phone tip asks for Tailscale on the home: this Mac on the home, and by its name in a window on a worker', async () => {
  render(<SettingsCard />);
  show('phone');
  const tip = (await screen.findByRole('link', { name: 'Tailscale' })).parentElement!;
  expect(tip.textContent).toContain('needs Tailscale on this Mac and the phone.');
  act(() => store.getState().setVia({ machine: '4b7a3c1e-2d5f-4e6a-9b8c-0f1e2d3c4b5a' as MachineId, home: '0c1d2e3f-4a5b-4c6d-8e7f-9a0b1c2d3e4f' as MachineId, name: 'studio', online: true }));
  expect(tip.textContent).toContain('needs Tailscale on studio and the phone.');
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

test('turned off in System Settings, the switch is off and says why, and the card\'s button goes there', () => {
  store.getState().setNotifyPermission('denied');
  render(<SettingsCard />);
  show('notifications');
  expect(screen.getByTestId('set-notify-denied')).toBeTruthy();
  const sw = screen.getByTestId('set-notify') as HTMLButtonElement;
  expect([sw.disabled, sw.dataset.tip]).toEqual([true, 'macOS has them off for Svall; turn them on in System Settings']);
  expect(checked('set-notify')).toBe('false');
  fireEvent.click(screen.getByTestId('set-notify-settings'));
  expect(sent).toContainEqual({ type: 'notify.settings' });
  act(() => store.getState().setNotifyPermission('unknown'));
  expect([sw.disabled, sw.hasAttribute('data-tip')]).toEqual([false, false]);
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

test('outside the app the config files and the cookie import are off, each saying why', () => {
  bridge.present = false;
  try {
    render(<SettingsCard />);
    const off = (id: string) => [screen.getByTestId(id).hasAttribute('disabled'), screen.getByTestId(id).getAttribute('data-tip')];
    expect([off('settings-ghostty'), off('settings-fleet')]).toEqual([[true, 'Works only in the Svall app.'], [true, 'Works only in the Svall app.']]);
    show('browser');
    expect(off('settings-cookies')).toEqual([true, 'Works only in the Svall app.']);
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

test("mission control's and the scribe's model pick among their CLI's models or the default, and are not offered for a CLI whose models Settings does not list", () => {
  const f = fleet();
  act(() => store.getState().setFleet({ ...f, mainAgent: 'claude', agentsFound: ['claude', 'codex'], home: { ...f.home, model: 'opus' }, scribeAgent: 'claude', scribeModel: 'claude-haiku-4-5' }));
  render(<SettingsCard />);
  show('fleet');
  const crew = screen.getByTestId('set-home-model') as HTMLSelectElement;
  expect(crew.value).toBe('opus');
  expect([...crew.options].map((o) => o.text)).toEqual(['default', 'haiku', 'sonnet', 'opus', 'fable']);
  fireEvent.change(crew, { target: { value: 'sonnet' } });
  expect(call).toHaveBeenCalledWith('model.set', { of: 'home', agent: 'claude', model: 'sonnet' });
  fireEvent.change(crew, { target: { value: '' } });
  expect(call).toHaveBeenLastCalledWith('model.set', { of: 'home', agent: 'claude', model: undefined });
  // a model fleet.json names that Settings does not list stays shown as the one set
  const scribe = screen.getByTestId('set-scribe-model') as HTMLSelectElement;
  expect(scribe.value).toBe('claude-haiku-4-5');
  expect([...scribe.options].map((o) => o.value)).toEqual(['', 'claude-haiku-4-5', 'haiku', 'sonnet', 'opus', 'fable']);
  fireEvent.change(scribe, { target: { value: 'opus' } });
  expect(call).toHaveBeenCalledWith('model.set', { of: 'scribe', agent: 'claude', model: 'opus' });
  // a codex crew on its own model, and an opencode scribe, whose model is its provider's
  act(() => store.getState().setFleet({ ...f, mainAgent: 'codex', agentsFound: ['codex', 'opencode'], home: { ...f.home, command: 'codex' }, scribeAgent: 'opencode' }));
  const codex = screen.getByTestId('set-home-model') as HTMLSelectElement;
  expect(codex.value).toBe('');
  expect([...codex.options].map((o) => o.text)).toEqual(["Codex's own", 'gpt-6-luna', 'gpt-6-astra', 'gpt-6-sol']);
  expect(screen.queryByTestId('set-scribe-model')).toBeNull();
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

test('Machines asks the fleet again after a list that failed, showing this Mac\'s registry and why meanwhile', async () => {
  vi.useFakeTimers();
  try {
    let fails = true;
    call.mockImplementation((method: string) => {
      if (method !== 'machines.list') return Promise.resolve({});
      return fails ? Promise.reject(new Error('svalld connection closed')) : Promise.resolve({ machines: [
        { id: 'bbbbbbbb-0000-4000-8000-000000000000', name: 'studio', role: 'home', reachable: true, robots: 7 },
      ] });
    });
    act(() => {
      store.getState().setVia({ machine: 'aaaaaaaa-0000-4000-8000-000000000000' as never, home: 'bbbbbbbb-0000-4000-8000-000000000000' as never, name: 'studio', online: true });
      store.getState().setStatus('online');
      store.getState().setMachines([{ id: 'cccccccc-0000-4000-8000-000000000000', name: 'box', ssh: 'ada@box', platform: 'linux-x64' }] as never);
    });
    render(<SettingsCard />);
    show('machines');
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(screen.queryByTestId('machine-studio')).toBeNull();
    expect(screen.queryByTestId('machines-reading')).toBeNull();
    expect(screen.queryByTestId('machine-box')).not.toBeNull();
    expect(screen.getByTestId('machines-error').textContent).toContain("The fleet's machines could not be read");
    expect(screen.getByTestId('machines-reload').textContent).toBe('Try again');
    fails = false;
    fireEvent.click(screen.getByTestId('machines-reload'));
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(screen.queryByTestId('machine-studio')).not.toBeNull();
    expect(screen.queryByTestId('machines-error')).toBeNull();
  } finally {
    vi.useRealTimers();
    call.mockImplementation(() => Promise.resolve({}));
  }
});

test('Phone reads the link before it shows its switch, which never reads off while it does not know', async () => {
  let answer!: (m: unknown) => void;
  try {
    call.mockImplementation((m: string) => (m === 'mobile.get' ? new Promise((r) => { answer = r; }) : Promise.resolve({})));
    render(<SettingsCard />);
    show('phone');
    expect(screen.getByTestId('set-mobile-reading').textContent).toBe('Reading the phone link…');
    expect(screen.queryByTestId('set-mobile')).toBeNull();
    await act(async () => answer({ serving: true, url: 'https://mac.ts.net:8443', port: 8443, logins: ['ada@github'], phones: [] }));
    expect(screen.queryByTestId('set-mobile-reading')).toBeNull();
    expect(checked('set-mobile')).toBe('true');
    cleanup();
    freshStore();
    call.mockImplementation((m: string) => (m === 'mobile.get' ? Promise.reject(new Error('not connected')) : Promise.resolve({})));
    render(<SettingsCard />);
    show('phone');
    // a read that failed leaves the switch to try
    await screen.findByTestId('set-mobile');
    expect(checked('set-mobile')).toBe('false');
  } finally {
    call.mockImplementation(() => Promise.resolve({ serving: false, logins: [], phones: [] }));
  }
});

test('Phone says why a home move left the link off, beside the switch that turns it on again', async () => {
  call.mockImplementation((m: string) => Promise.resolve(m === 'mobile.get' ? { serving: false, url: '', port: 8443, logins: [], phones: [], reason: 'Access denied' } : {}));
  render(<SettingsCard />);
  fireEvent.click(screen.getByTestId('settings-tab-phone'));
  expect(await screen.findByText('Access denied')).toBeTruthy();
  expect(screen.getByTestId('set-mobile')).toBeTruthy();
  expect(screen.queryByTestId('set-mobile-blocked')).toBeNull();
});

test('a window on a far home adds a machine there, and acts on that home\'s workers, but for making one its home', async () => {
  const HOME = 'bbbbbbbb-0000-4000-8000-000000000000';
  const BOX = 'cccccccc-0000-4000-8000-000000000000';
  try {
    call.mockImplementation((method: string) => Promise.resolve(method === 'machines.list' ? { machines: [{ id: HOME, name: 'studio', role: 'home', reachable: true, robots: 1 }, { id: BOX, name: 'box', role: 'worker', reachable: true, robots: 2 }] } : {}));
    act(() => {
      store.getState().setVia({ machine: 'aaaaaaaa-0000-4000-8000-000000000000' as never, home: HOME as never, name: 'studio', online: true });
      store.getState().setStatus('online');
      store.getState().setMachines([{ id: HOME, name: 'studio', ssh: 'ada@studio', platform: 'linux-x64' }, { id: BOX, name: 'box', ssh: 'ada@box', platform: 'linux-x64', far: true }] as never);
    });
    render(<SettingsCard />);
    show('machines');
    await screen.findByTestId('machine-box');
    expect(screen.getByTestId('machine-add')).toBeTruthy();
    const row = screen.getByTestId('machine-box');
    expect(row.querySelector('[data-testid="machine-doctor"]')).not.toBeNull();
    fireEvent.click(row.querySelector('[data-testid="machine-more"]')!);
    expect(row.querySelector('[data-testid="machine-upgrade"]')!.textContent).toBe("Upgrade to studio's release");
    expect(row.querySelector('[data-testid="machine-remove"]')).not.toBeNull();
    expect(row.querySelector('[data-testid="machine-make-home"]')).toBeNull();
    call.mockImplementation((method: string) => Promise.resolve(method === 'machines.list' ? { machines: [{ id: BOX, name: 'box', role: 'worker', reachable: false, robots: 2, joining: 'No route to host' }] } : {}));
    act(() => store.getState().setFleet({ ...store.getState().fleet, machines: { [BOX]: { name: 'box', reachable: false, since: 1 } } } as never));
    const joining = await screen.findByTestId('machine-joining-box');
    // a machine still owed its join says so first, though it is not reachable either
    expect([...joining.children].map((c) => c.textContent)).toEqual(['has not joined yet', 'No route to host']);
    // and keeps, as on a Mac home, its address, its Check and a ⋯ that can forget it
    expect(row.querySelector('.machine-meta')!.textContent).toBe('ada@box · 2 robots');
    expect(row.querySelector('[data-testid="machine-doctor"]')).not.toBeNull();
    // its ⋯ still open from above
    expect(row.querySelector('[data-testid="machine-forget"]')).not.toBeNull();
  } finally {
    call.mockImplementation(() => Promise.resolve({}));
  }
});

test('a window standing in for its home keeps its Phone pane, which says the home is away, and offers no Add machine', async () => {
  try {
    act(() => {
      store.getState().setVia({ machine: 'aaaaaaaa-0000-4000-8000-000000000000' as never, home: 'bbbbbbbb-0000-4000-8000-000000000000' as never, name: 'studio' });
      store.getState().setStatus('online');
    });
    render(<SettingsCard />);
    show('phone');
    expect(screen.getByTestId('set-mobile-away').textContent).toBe('studio is not reachable; its phone link shows once it is.');
    expect(call).not.toHaveBeenCalledWith('mobile.get', expect.anything());
    expect(screen.queryByTestId('set-mobile')).toBeNull();
    show('machines');
    expect(screen.queryByTestId('machine-add')).toBeNull();
  } finally {
    call.mockImplementation(() => Promise.resolve({}));
  }
});

test('a far home that calls itself otherwise than this Mac\'s registry is acted on by the registry\'s name: checked, opened, and brought back', async () => {
  const ME = 'aaaaaaaa-0000-4000-8000-000000000000';
  const HOME = 'bbbbbbbb-0000-4000-8000-000000000000';
  call.mockImplementation((method: string) => Promise.resolve(method === 'machines.list' ? { machines: [
    { id: HOME, name: 'vps-1234', role: 'home', platform: 'linux', reachable: true, robots: 7 },
    { id: ME, name: 'mac', role: 'worker', platform: 'darwin', reachable: true, robots: 3 },
  ] } : {}));
  try {
    act(() => {
      store.getState().setVia({ machine: ME as never, home: HOME as never, name: 'vps-1234', online: true });
      store.getState().setStatus('online');
      store.getState().setMachines([{ id: HOME, name: 'studio', ssh: 'ada@studio', platform: 'linux-x64' }] as never);
    });
    render(<SettingsCard />);
    show('machines');
    const row = await screen.findByTestId('machine-studio');
    fireEvent.click(row.querySelector('[data-testid="machine-more"]')!);
    expect((row.querySelector('[data-testid="machine-terminal"]') as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(row.querySelector('[data-testid="machine-bring-back"]')!);
    expect(store.getState().homeSheet).toEqual({ to: HOME, name: 'studio', back: true });
    fireEvent.click(row.querySelector('[data-testid="machine-doctor"]')!);
    expect(sent).toContainEqual({ type: 'host.start', op: 'doctor', args: { name: 'studio' } });
  } finally {
    call.mockImplementation(() => Promise.resolve({}));
  }
});

test('Machines names each machine\'s role from the fleet, the home first and a worker that dials in too, and the far home\'s row alone has its actions, of what this Mac\'s registry lists', async () => {
  const ME = 'aaaaaaaa-0000-4000-8000-000000000000';
  const HOME = 'bbbbbbbb-0000-4000-8000-000000000000';
  const DIAL = 'cccccccc-0000-4000-8000-000000000000';
  const LINUX = 'dddddddd-0000-4000-8000-000000000000';
  call.mockImplementation((method: string) => Promise.resolve(method === 'machines.list' ? { machines: [
    { id: HOME, name: 'studio', role: 'home', platform: 'linux', reachable: true, robots: 7 },
    { id: ME, name: 'mac', role: 'worker', platform: 'darwin', reachable: true, robots: 3 },
    { id: DIAL, name: 'laptop', role: 'worker', platform: 'darwin', dialsIn: true, reachable: false, robots: 1 },
    { id: LINUX, name: 'vault', role: 'worker', platform: 'linux', reachable: true, robots: 0 },
  ] } : {}));
  try {
    act(() => {
      store.getState().setVia({ machine: ME as never, home: HOME as never, name: 'studio', online: true });
      store.getState().setStatus('online');
      store.getState().setMachines([{ id: HOME, name: 'studio', ssh: 'ada@studio', platform: 'linux-x64' }] as never);
    });
    render(<SettingsCard />);
    show('machines');
    await screen.findByTestId('machine-studio');
    const rows = [...screen.getByTestId('machines').querySelectorAll('.machine')];
    expect(rows.map((r) => r.getAttribute('data-role'))).toEqual(['home', 'worker', 'worker', 'worker']);
    const line = (name: string, part: string) => screen.getByTestId(`machine-${name}`).querySelector(part)?.textContent;
    expect([line('studio', '.badge'), line('studio', '.machine-meta')]).toEqual(['home', 'ada@studio · 7 robots']);
    expect([line('mac', 'b'), line('mac', '.badge'), line('mac', '.machine-meta')]).toEqual(['this Mac', 'worker', '3 robots']);
    expect(screen.getByTestId('machine-studio').querySelector('.badge')!.getAttribute('data-tip')).toBe('Holds the fleet and starts new robots.');
    expect(screen.getByTestId('machine-mac').querySelector('.badge')!.getAttribute('data-tip')).toBe('Runs robots moved to it.');
    expect(line('laptop', '.machine-meta')).toBe('connects out to studio · 1 robot');
    expect(screen.getByTestId('machine-laptop').querySelector('.machine-meta')!.getAttribute('data-tip')).toBe('laptop connects to studio; nothing connects in.');
    // no route in this Mac's registry says nothing of who opens the link
    expect(line('vault', '.machine-meta')).toBeUndefined();
    // the far home has its Check and ⋯ from this window; a worker of it is that home's to manage
    expect(screen.getByTestId('machine-studio').querySelector('[data-testid="machine-doctor"]')).not.toBeNull();
    expect(screen.getByTestId('machine-mac').querySelector('[data-testid="machine-doctor"]')).toBeNull();
    // the home's row by the name this Mac knows it by, as its menu and sheet go
    act(() => store.getState().setMachines([{ id: HOME, name: 'box', ssh: 'ada@studio', platform: 'linux-x64' }] as never));
    expect(screen.getByTestId('machine-box').querySelector('.machine-meta')!.textContent).toBe('ada@studio · 7 robots');
    expect(screen.queryByTestId('machine-studio')).toBeNull();
  } finally {
    call.mockImplementation(() => Promise.resolve({}));
  }
});

test('Machines lists every machine with its ssh, its release and last check, each with its own actions, and Add machine last', () => {
  store.getState().setShell({ home: '/Users/ada/.svall', log: [], op: false });
  render(<SettingsCard />);
  show('machines');
  expect(sent).toContainEqual({ type: 'host.list' });
  act(() => store.getState().setMachines([
    { name: 'mac', id: 'm0', platform: 'darwin-arm64' },
    { name: 'trift', id: 'm1', ssh: 'ada@trift', platform: 'linux-x64', check: { at: Date.UTC(2026, 9, 21, 12, 0), failed: 0, warned: 2, release: '0.13.0' } },
    { name: 'studio', id: 'm2', ssh: 'ada@studio', platform: 'linux-arm64' },
  ]));
  // this Mac is no machine to act on
  expect(screen.queryByTestId('machine-mac')).toBeNull();
  const trift = screen.getByTestId('machine-trift');
  expect(trift.textContent).toContain('ada@trift');
  expect(trift.textContent).toContain('release 0.13.0');
  expect(trift.textContent).toContain('2 warnings');
  expect(screen.getByTestId('machine-studio').textContent).toContain('not checked yet');
  // a rollback is offered only by the upgrade whose own rollback failed
  expect(trift.querySelector('[data-testid="machine-rollback"]')).toBeNull();

  fireEvent.click(trift.querySelector('[data-testid="machine-doctor"]')!);
  expect(sent).toContainEqual({ type: 'host.start', op: 'doctor', args: { name: 'trift' } });
  expect(store.getState().hostOpen).toBe(true);
  expect(store.getState().hostMachine).toBe('trift');

  // one run at a time
  fireEvent.click(screen.getByTestId('machine-studio').querySelector('[data-testid="machine-more"]')!);
  expect((screen.getByTestId('machine-studio').querySelector('[data-testid="machine-forget"]') as HTMLButtonElement).disabled).toBe(true);
  act(() => { store.getState().hostDone('doctor', 0); store.getState().toggleHost(false); });
  fireEvent.click(screen.getByTestId('machine-studio').querySelector('[data-testid="machine-forget"]')!);
  expect(store.getState().hostConfirm).toEqual({ name: 'studio', forget: true });
  expect(store.getState().hostMachine).toBe('studio');

  act(() => store.getState().toggleHost(false));
  fireEvent.click(screen.getByTestId('machine-add'));
  expect(store.getState().hostOpen).toBe(true);
  expect(store.getState().hostMachine).toBeUndefined();
});

test('Machines says when the list could not be read, and offers to read it again', () => {
  store.getState().setShell({ home: '/Users/ada/.svall', log: [], op: false });
  render(<SettingsCard />);
  show('machines');
  act(() => store.getState().setMachines([], 'svall host list exited with code 1'));
  expect(screen.getByTestId('machines-error').textContent).toContain('svall host list exited with code 1');
  sent.length = 0;
  fireEvent.click(screen.getByTestId('machines-reload'));
  expect(sent).toEqual([{ type: 'host.list' }]);
});

const kickers = () => [...document.querySelectorAll('.set-group > .kicker')].map((k) => k.firstChild!.textContent);
const tipOf = (id: string) => document.getElementById(`set-tip-${id}`)!.textContent;

test('each pane is groups of rows under their names, and an action is a row with its button at the right', () => {
  store.getState().setNotifyPermission('denied');
  store.getState().setUpdate('0.2.1');
  render(<SettingsCard />);
  expect(kickers()).toEqual(['Display', 'Map', 'Power', 'Config files']);
  expect([...document.querySelectorAll('.set-group')[1].querySelectorAll('.row > span')].map((r) => r.firstChild!.textContent))
    .toEqual(['arrange on its own', 'links on cards', 'robot motion', 'usage meter']);
  for (const [id, label, info] of [['settings-ghostty', 'Ghostty config', 'Terminal font, colours and cursor.'], ['settings-fleet', 'fleet config', 'Mission control, fleet defaults, scribe and phone logins.']]) {
    const open = screen.getByTestId(id);
    expect([open.textContent, open.className, open.closest('.row')!.firstChild!.firstChild!.textContent]).toEqual(['Open', 'btn sm', label]);
    expect(open.closest('.row')!.querySelector('[role="tooltip"]')!.textContent).toBe(info);
  }
  // with a way to the fleet's config, nothing holds the button back to say why
  expect(screen.getByTestId('settings-fleet').hasAttribute('data-tip')).toBe(false);
  show('browser');
  expect(kickers()).toEqual(['Sign-ins']);
  expect(screen.getByTestId('set-1password-needs').textContent).toBe("Needs the 1Password CLI: brew install 1password-cli, then switch on Integrate with 1Password CLI in 1Password's Developer settings.");
  expect(screen.getByTestId('settings-cookies').textContent).toBe('Import');
  act(() => store.getState().setShell({ home: '/Users/ada/.svall', log: [], op: true }));
  expect(screen.queryByTestId('set-1password-needs')).toBeNull();
  show('keyboard');
  expect(kickers()).toEqual(['Shortcuts']);
  expect(document.querySelector('.set-group .set-note')!.textContent).toContain('Unlisted ⌘ chords go to the terminal.');
  show('notifications');
  expect(kickers()).toEqual(['Notifications']);
  const denied = screen.getByTestId('set-notify-denied');
  expect([denied.className, denied.firstChild!.textContent, denied.querySelector('b')!.firstChild!.textContent]).toEqual(['row', 'macOS', 'off for Svall']);
  expect(within(denied).getByTestId('set-notify-settings').textContent).toBe('Open System Settings');
  show('fleet');
  expect(kickers()).toEqual(['Fleet', 'New robots', 'Scribe', 'Idle agents']);
  const permissions = screen.getByRole('switch', { name: 'Let robots run svall without asking' });
  expect(permissions.closest('.row')!.firstChild!.firstChild!.textContent).toBe('run svall without asking');
  show('updates');
  expect(kickers()).toEqual(['Updates']);
  expect(document.querySelector('.set-win .desc, .set-win .opens')).toBeNull();
});

test('Keyboard\'s rows read in the window\'s lowercase, a name keeping its capital', () => {
  render(<SettingsCard />);
  show('keyboard');
  const labels = [...document.querySelectorAll('.set-group .row > span:first-child')].map((r) => r.textContent);
  expect(labels.slice(0, 3)).toEqual(['new robot', 'mission control', 'arrange the fleet']);
  expect(labels).toContain('quit Svall');
});

test('the pane\'s cut edge fades while more of it lies below, and not once it is scrolled to its end', () => {
  render(<SettingsCard />);
  const panel = screen.getByTestId('settings-panel');
  const size = (top: number) => {
    Object.defineProperties(panel, { scrollHeight: { value: 900, configurable: true }, clientHeight: { value: 500, configurable: true }, scrollTop: { value: top, configurable: true } });
    fireEvent.scroll(panel);
  };
  size(0);
  expect(panel.getAttribute('data-more')).toBe('true');
  size(400);
  expect(panel.getAttribute('data-more')).toBe('false');
});

test('an Info says what a control is for in two sentences at most', async () => {
  render(<SettingsCard />);
  expect(tipOf('keep-awake')).toBe('Stops idle sleep while agents work, so they keep running and your phone reaches the fleet. The screen still dims and locks, and nothing is held on battery.');
  show('fleet');
  expect(tipOf('dormancy')).toBe('Frees memory. Opening the terminal resumes the conversation; agents with background work stay up.');
  expect(tipOf('scribe')).toBe('Updates names, notes and links after an agent stops. Each pass is one headless Claude Code call.');
  expect(tipOf('placing')).toBe("Each scribe pass also picks the robot's board column. A robot moved by hand is left alone.");
  expect(tipOf('main-agent')).toBe('What mission control, the scribe and new robots start.');
  expect(tipOf('worktrees')).toBe('Agents in a git repo make a worktree for their task and leave the main checkout alone.');
  call.mockImplementation(() => Promise.resolve({ serving: false, url: '', port: 0, logins: [], phones: [] }));
  show('phone');
  await screen.findByTestId('set-mobile');
  expect(tipOf('phone')).toBe('Reachable only on your tailnet; needs Tailscale on this Mac and the phone. After switching it off, turn notifications on again on each phone.');
});

test('a fleet name that will not do is said in a note under its row, and the last scribe failure keeps a tool\'s words behind details', () => {
  act(() => store.getState().setFleet({ ...fleet(), scribeError: { message: 'the scribe stopped: Command failed: claude -p exited 1', at: 1 } }));
  render(<SettingsCard />);
  show('fleet');
  const input = screen.getByTestId('set-fleet-name') as HTMLInputElement;
  fireEvent.change(input, { target: { value: 'Big Base' } });
  fireEvent.keyDown(input, { key: 'Enter' });
  fireEvent.blur(input);
  const error = screen.getByTestId('set-fleet-name-error');
  expect([error.className, error.previousElementSibling!.contains(input)]).toEqual(['set-note fleet-error', true]);
  const failure = screen.getByTestId('set-scribe-error');
  expect(within(failure).getByText('the scribe stopped')).toBeTruthy();
  expect(failure.querySelector('details')!.textContent).toBe('detailsCommand failed: claude -p exited 1');
  // an agent refused for want of a login is said in Svall's words, with its login to copy, the agent's own words behind details
  act(() => store.getState().setFleet({ ...fleet(), scribeError: { message: 'claude -p failed: Not logged in · Please run /login', at: 1 } }));
  expect(screen.getByTestId('set-scribe-error').querySelector('.said > div > span')!.textContent).toBe('Claude Code is not logged in on this Mac');
  expect(screen.getByTestId('set-scribe-error').querySelector('.set-note')!.textContent).toBe('Log in once: claude auth login');
  expect(screen.getByTestId('set-scribe-error').querySelector('.set-note code')!.textContent).toBe('claude auth login');
  expect(within(screen.getByTestId('set-scribe-error')).getByTestId('said-copy')).toBeTruthy();
  expect(screen.getByTestId('set-scribe-error').querySelector('details')!.textContent).toBe('detailsclaude -p failed: Not logged in · Please run /login');
  // under its row, which says when, not beside it
  expect(screen.getByTestId('set-scribe-error').closest('.row')).toBeNull();
  expect(screen.getByTestId('set-scribe-error-at').textContent).toBe(new Date(1).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }));
  act(() => store.getState().setFleet({ ...fleet(), scribeError: { message: 'codex exec exited 1', at: 1 } }));
  expect(screen.getByTestId('set-scribe-error').querySelector('.said > div > span')!.textContent).toBe("Claude Code did not finish the scribe's last pass");
});

describe('the window', () => {
  // a box as wide and tall as its inline size, which is what the browser lays out within its clamps
  const sized = { offsetWidth: { get(this: HTMLElement) { return parseFloat(this.style.width) || 0; } }, offsetHeight: { get(this: HTMLElement) { return parseFloat(this.style.height) || 0; } } };
  const was = { w: Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetWidth')!, h: Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetHeight')! };
  beforeEach(() => { Object.defineProperties(HTMLElement.prototype, sized); Element.prototype.setPointerCapture ??= function () {}; });
  afterEach(() => { Object.defineProperty(HTMLElement.prototype, 'offsetWidth', was.w); Object.defineProperty(HTMLElement.prototype, 'offsetHeight', was.h); });

  test('starts at 760 by 600, grows by twice the drag of its corner as it stays centred, keeps the size on release and goes back on a double-click', () => {
    render(<SettingsCard />);
    const win = screen.getByTestId('settings');
    const grip = screen.getByTestId('settings-grip');
    expect([win.style.width, win.style.height]).toEqual(['760px', '600px']);
    fireEvent.pointerDown(grip, { pointerId: 1, clientX: 1000, clientY: 700 });
    fireEvent.pointerMove(grip, { pointerId: 1, clientX: 1030, clientY: 690, buttons: 1 });
    expect([win.style.width, win.style.height]).toEqual(['820px', '580px']);
    expect(store.getState().settings.settingsSize).toBeUndefined();
    fireEvent.pointerUp(grip, { pointerId: 1 });
    expect(store.getState().settings.settingsSize).toEqual({ w: 820, h: 580 });
    // a press that does not move keeps nothing
    act(() => store.getState().setSettings({ settingsSize: undefined }));
    fireEvent.pointerDown(grip, { pointerId: 1, clientX: 1000, clientY: 700 });
    fireEvent.pointerUp(grip, { pointerId: 1 });
    expect(store.getState().settings.settingsSize).toBeUndefined();
    act(() => store.getState().setSettings({ settingsSize: { w: 900, h: 500 } }));
    expect([win.style.width, win.style.height]).toEqual(['900px', '500px']);
    fireEvent.doubleClick(grip);
    expect(store.getState().settings.settingsSize).toBeUndefined();
    expect([win.style.width, win.style.height]).toEqual(['760px', '600px']);
  });
});

test('the panes are tabs that Up, Down, Home and End move through, and the panel is labelled by its tab', () => {
  render(<SettingsCard />);
  const tab = (p: string) => screen.getByTestId(`settings-tab-${p}`);
  const tabs = screen.getAllByRole('tab');
  expect(tabs.map((t) => t.tabIndex)).toEqual(tabs.map((t) => (t === tab('machine') ? 0 : -1)));
  tab('machine').focus();
  fireEvent.keyDown(tab('machine'), { key: 'ArrowDown' });
  expect([tab('browser').getAttribute('aria-selected'), document.activeElement]).toEqual(['true', tab('browser')]);
  expect(screen.getByRole('tabpanel').getAttribute('aria-labelledby')).toBe(tab('browser').id);
  expect(tab('browser').tabIndex).toBe(0);
  fireEvent.keyDown(tab('browser'), { key: 'End' });
  expect(document.activeElement).toBe(tabs.at(-1));
  expect(tabs.at(-1)!.getAttribute('aria-selected')).toBe('true');
  fireEvent.keyDown(document.activeElement!, { key: 'ArrowDown' });
  expect(document.activeElement).toBe(tab('machine'));
  fireEvent.keyDown(tab('machine'), { key: 'ArrowUp' });
  expect(document.activeElement).toBe(tabs.at(-1));
  fireEvent.keyDown(document.activeElement!, { key: 'Home' });
  expect([document.activeElement, tab('machine').getAttribute('aria-selected')]).toEqual([tab('machine'), 'true']);
});

describe('Phone', () => {
  const SERVING = { serving: true, url: 'https://mac.ts.net:8443', pair: 'https://mac.ts.net:8443/#p=x', port: 8443, logins: ['ada@github'], phones: [], qr: 'data:image/png;base64,AA' };
  const answer = (status: object, set?: () => Promise<unknown>) => call.mockImplementation((m: string) => (m === 'mobile.get' ? Promise.resolve(status) : m === 'mobile.set' && set ? set() : Promise.resolve({})));
  afterEach(() => { call.mockImplementation(() => Promise.resolve({})); vi.useRealTimers(); });

  test('is rows under Phone link: the switch, the address that copies the pairing link, who is connected and who can be, and the QR alone with how to use it', async () => {
    answer(SERVING);
    render(<SettingsCard />);
    show('phone');
    const url = await screen.findByTestId('set-mobile-url');
    expect(kickers()).toEqual(['Phone link']);
    expect([...document.querySelectorAll('.set-group .row > span')].map((r) => r.firstChild!.textContent)).toEqual(['serve this fleet', 'address', 'connected', 'who can connect']);
    expect(screen.getByTestId('set-mobile-here').textContent).toBe('nobody');
    expect(screen.getByTestId('set-mobile-logins').textContent).toBe('ada@github');
    // the address shows once: the QR beside its note has no link of its own
    expect(screen.queryByTestId('mobile-url')).toBeNull();
    expect(document.querySelector('.set-qr img.mob-qr')).not.toBeNull();
    expect(document.querySelector('.set-qr .set-note')!.textContent).toBe('Scan with your phone. Then: Share → Add to Home Screen, and open Svall from the new icon.');
    vi.useFakeTimers();
    fireEvent.click(url);
    expect(sent).toContainEqual({ type: 'copy', text: 'https://mac.ts.net:8443/#p=x' });
    expect(url.textContent).toBe('copied');
    act(() => { vi.advanceTimersByTime(1500); });
    expect(url.textContent).toBe('https://mac.ts.net:8443');
    expect(url.querySelector('svg')).not.toBeNull();
  });

  test('a screenshot\'s redaction greys the address, who is connected and who can be, as in the dock', async () => {
    answer({ ...SERVING, phones: [{ login: 'ada@github', since: Date.now() }] });
    render(<SettingsCard />);
    show('phone');
    await screen.findByTestId('set-mobile-url');
    act(() => store.getState().setPhoneRedact('data:image/png;base64,BB'));
    for (const id of ['set-mobile-url', 'set-mobile-here', 'set-mobile-logins']) {
      expect(screen.getByTestId(id).querySelector('.mob-mask'), id).not.toBeNull();
      expect(screen.getByTestId(id).textContent, id).not.toContain('ada@github');
      expect(screen.getByTestId(id).textContent, id).not.toContain('mac.ts.net');
    }
    expect(document.querySelector<HTMLImageElement>('.set-qr img')!.src).toBe('data:image/png;base64,BB');
  });

  test('a problem the pane says is not said again by a toast; one no pane says, as when the pane closed while it started, is, with its fix and Copy details', async () => {
    const off = { serving: false, url: '', port: 0, logins: [], phones: [] };
    const denied = { ...off, error: 'Tailscale on this Mac does not let Svall share this fleet', fix: 'Run once on this Mac: sudo tailscale set --operator=$USER', run: 'sudo tailscale set --operator=$USER', raw: 'Access denied' };
    let started!: (m: unknown) => void;
    answer(off, () => new Promise((r) => { started = r; }));
    const { unmount } = render(<SettingsCard />);
    show('phone');
    fireEvent.click(await screen.findByTestId('set-mobile'));
    await act(async () => { started(denied); });
    expect(await screen.findByTestId('mobile-problem')).toBeTruthy();
    expect(store.getState().toast).toBeUndefined();
    act(() => store.getState().setMobile(off));
    fireEvent.click(screen.getByTestId('set-mobile'));
    unmount();
    await act(async () => { started(denied); });
    expect(store.getState().toast).toMatchObject({ text: `${denied.error}.`, fix: denied.fix, run: denied.run, raw: denied.raw, tone: 'error' });
  });

  test('says nobody can connect yet with no login, and nothing of an address or a QR while off', async () => {
    answer({ serving: false, url: '', port: 0, logins: [], phones: [] });
    render(<SettingsCard />);
    show('phone');
    expect((await screen.findByTestId('set-mobile-logins')).textContent).toBe('nobody yet');
    expect(screen.queryByTestId('set-mobile-url')).toBeNull();
    expect(document.querySelector('.set-qr')).toBeNull();
  });

  test('says the first start can take a while only while the switch turns the link on', async () => {
    let started!: (m: unknown) => void;
    answer({ serving: false, url: '', port: 0, logins: [], phones: [] }, () => new Promise((r) => { started = r; }));
    render(<SettingsCard />);
    show('phone');
    await screen.findByTestId('set-mobile-logins');
    expect(screen.queryByTestId('set-mobile-starting')).toBeNull();
    fireEvent.click(screen.getByTestId('set-mobile'));
    expect(screen.getByTestId('set-mobile-starting').textContent).toBe('Starting; the first time can take a few minutes.');
    await act(async () => { started(SERVING); });
    expect(screen.queryByTestId('set-mobile-starting')).toBeNull();
  });

  test('a link that cannot start says so in Svall\'s words, with what to do and a tool\'s words behind details', async () => {
    answer({ serving: false, url: '', port: 0, logins: [], phones: [], error: 'Tailscale on this Mac does not let Svall share this fleet', fix: 'Run once: sudo tailscale set --operator=$USER', raw: 'Access denied: serve config denied' });
    render(<SettingsCard />);
    show('phone');
    const problem = await screen.findByTestId('mobile-problem');
    expect(screen.getByTestId('set-mobile-blocked').textContent).toBe('unavailable');
    expect(within(problem).getByText('Tailscale on this Mac does not let Svall share this fleet')).toBeTruthy();
    expect(within(problem).getByText('Run once: sudo tailscale set --operator=$USER').className).toBe('set-note');
    expect(problem.querySelector('details')!.textContent).toBe('detailsAccess denied: serve config denied');
    // under the rows, as the pane's last word
    expect(problem.closest('.rows')!.lastElementChild).toBe(problem);
  });
});

describe('Machines', () => {
  const HOME = 'bbbbbbbb-0000-4000-8000-000000000000';
  const W = 'cccccccc-0000-4000-8000-000000000000';
  afterEach(() => call.mockImplementation(() => Promise.resolve({})));
  const open = async (list: object[], registry: object[]) => {
    call.mockImplementation((m: string) => Promise.resolve(m === 'machines.list' ? { machines: list } : {}));
    act(() => { store.getState().setStatus('online'); store.getState().setMachines(registry as never); });
    render(<SettingsCard />);
    show('machines');
    await screen.findByTestId(`machine-${(list[0] as { name: string }).name}`);
  };
  const dot = (name: string) => screen.getByTestId(`machine-${name}`).querySelector('.machine-dot');
  const said = (name: string) => screen.getByTestId(`machine-${name}`).querySelector('.machine-said')?.textContent;

  test('is a group whose heading says what home and worker mean and offers Add machine, with a note when there is no other machine', () => {
    render(<SettingsCard />);
    show('machines');
    const kicker = document.querySelector('.set-group > .kicker')!;
    expect(kicker.firstChild!.textContent).toBe('Machines');
    expect(tipOf('machines')).toBe('The home holds the fleet and starts new robots. A worker runs robots moved to it.');
    expect(kicker.contains(screen.getByTestId('machine-add'))).toBe(true);
    act(() => store.getState().setMachines([]));
    const empty = screen.getByTestId('machines-empty');
    expect([empty.className, empty.textContent]).toEqual(['set-note', "No other machine yet. A Linux machine can run this fleet's robots while this Mac sleeps, or run the whole fleet."]);
    expect(screen.queryByText('another machine')).toBeNull();
  });

  test('a machine\'s dot says whether it answers, and its last line the one thing to know: since when it is away, an upgrade, its last check', async () => {
    const since = Date.UTC(2026, 10, 10, 9, 30);
    await open([
      { id: HOME, name: 'mac', role: 'home', reachable: true, robots: 2 },
      { id: W, name: 'vault', role: 'worker', reachable: false, since, robots: 1 },
      { id: 'dddddddd-0000-4000-8000-000000000000', name: 'box', role: 'worker', reachable: true, robots: 0 },
    ], [{ name: 'vault', id: W, ssh: 'ada@vault', platform: 'linux-x64' }, { name: 'box', id: 'dddddddd-0000-4000-8000-000000000000', ssh: 'ada@box', platform: 'linux-x64', check: { at: since, failed: 0, warned: 1, release: '0.9.4' } },
      { name: 'spare', id: 'eeeeeeee-0000-4000-8000-000000000000', ssh: 'ada@spare', platform: 'linux-x64' }]);
    expect([dot('mac')!.getAttribute('aria-label'), dot('vault')!.getAttribute('aria-label'), dot('box')!.getAttribute('aria-label')]).toEqual(['reachable', 'not reachable', 'reachable']);
    // a machine on this Mac's list but not in this fleet has no link to tell of
    expect(dot('spare')).toBeNull();
    const at = new Date(since).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
    expect(said('vault')).toBe(`not reachable since ${at}Removed it by hand? Forget, under ⋯, drops it from this list.`);
    expect(said('box')).toBe(`checked ${at} · 1 warning`);
    expect(screen.getByTestId('machine-box').querySelector('.machine-meta')!.textContent).toBe('ada@box · release 0.9.4');
    expect(said('spare')).toBe('not checked yet');
    // the home says nothing while all is well
    expect(said('mac')).toBeUndefined();
    act(() => store.getState().setFleet({ ...store.getState().fleet, machines: { [W]: { name: 'vault', reachable: false, since, mismatch: true } } } as never));
    await waitFor(() => expect(dot('vault')!.getAttribute('aria-label')).toBe('needs an upgrade'));
    expect(said('vault')).toBe('needs an upgrade');
  });

  test('a worker not joined yet has no dot, and says why in the home\'s words with what to check, a warning, ssh\'s words behind details', async () => {
    await open([
      { id: HOME, name: 'mac', role: 'home', reachable: true, robots: 2 },
      { id: W, name: 'atlas', role: 'worker', reachable: false, robots: 0, joining: 'atlas is not reachable from this Mac; check that it is on and on Tailscale', raw: 'ssh: connect to host atlas port 22: Operation timed out' },
    ], [{ name: 'atlas', id: W, ssh: 'ada@atlas', platform: 'linux-x64' }]);
    expect(dot('atlas')).toBeNull();
    const joining = screen.getByTestId('machine-joining-atlas');
    const said = joining.querySelector('.said')!;
    expect(said.getAttribute('data-mark')).toBe('warn');
    expect(said.querySelector('.said > div > span')!.textContent).toBe('atlas is not reachable from this Mac');
    expect(said.querySelector('.set-note')!.textContent).toBe('Check that it is on and on Tailscale');
    expect(said.querySelector('.modal-more-body')!.textContent).toBe('ssh: connect to host atlas port 22: Operation timed out');
  });

  test('what a check found opens the Check sheet, which checks again to list it; the home says its own once a check found something', async () => {
    const at = Date.UTC(2026, 10, 10, 9, 30);
    await open([
      { id: HOME, name: 'studio', role: 'home', reachable: true, robots: 2 },
      { id: W, name: 'box', role: 'worker', reachable: true, robots: 0 },
    ], [{ name: 'studio', id: HOME, ssh: 'ada@studio', platform: 'linux-x64', check: { at, failed: 1, warned: 0 } },
      { name: 'box', id: W, ssh: 'ada@box', platform: 'linux-x64', check: { at, failed: 0, warned: 2 } }]);
    const when = new Date(at).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
    expect(said('box')).toBe(`checked ${when} · 2 warnings`);
    expect(said('studio')).toBe(`checked ${when} · 1 check failed`);
    sent.length = 0;
    fireEvent.click(within(screen.getByTestId('machine-box')).getByRole('button', { name: '2 warnings' }));
    expect(store.getState().hostMachine).toBe('box');
    expect(sent).toContainEqual(expect.objectContaining({ type: 'host.start', op: 'doctor', args: { name: 'box' } }));
  });

  test('the registry\'s machines wait for the fleet\'s list, so no row shifts in or changes later', async () => {
    let answer!: (r: unknown) => void;
    call.mockImplementation((m: string) => (m === 'machines.list' ? new Promise((r) => { answer = r; }) : Promise.resolve({})));
    act(() => { store.getState().setStatus('online'); store.getState().setMachines([{ name: 'vault', id: W, ssh: 'ada@vault', platform: 'linux-x64' }] as never); });
    render(<SettingsCard />);
    show('machines');
    await act(async () => {});
    expect(screen.getByTestId('machines-reading').textContent).toBe('Reading the machines…');
    expect(screen.queryByTestId('machine-vault')).toBeNull();
    await act(async () => answer({ machines: [{ id: HOME, name: 'mac', role: 'home', reachable: true, robots: 1 }, { id: W, name: 'vault', role: 'worker', reachable: true, robots: 0 }] }));
    expect(screen.queryByTestId('machines-reading')).toBeNull();
    expect(screen.getByTestId('machine-vault').getAttribute('data-role')).toBe('worker');
  });

  test('both lists failing are one error with one Try again that reads both, and Add machine is off saying why', async () => {
    call.mockImplementation((m: string) => (m === 'machines.list' ? Promise.reject(new Error('the fleet did not answer')) : Promise.resolve({})));
    act(() => store.getState().setStatus('online'));
    render(<SettingsCard />);
    show('machines');
    act(() => store.getState().setMachines([], 'svall host list exited 1: bad registry'));
    await waitFor(() => expect(screen.getByTestId('machines-error').querySelector('.said > div > span')!.textContent).toBe('The machines could not be read'));
    expect(screen.getAllByTestId('machines-error')).toHaveLength(1);
    expect(screen.getByTestId('machines-error').querySelector('.modal-more-body')!.textContent).toBe('svall host list exited 1: bad registry\n\nthe fleet did not answer');
    const add = screen.getByTestId('machine-add') as HTMLButtonElement;
    expect([add.disabled, add.dataset.tip]).toEqual([true, "This Mac's list of machines could not be read"]);
    sent.length = 0;
    call.mockClear();
    fireEvent.click(screen.getByTestId('machines-reload'));
    expect(sent).toContainEqual({ type: 'host.list' });
    await waitFor(() => expect(call).toHaveBeenCalledWith('machines.list', {}));
  });

  test('a list that cannot be read is said, with Try again at the right', () => {
    render(<SettingsCard />);
    show('machines');
    act(() => store.getState().setMachines([], 'svall host list exited 1: ssh: connect to host'));
    const error = screen.getByTestId('machines-error');
    expect(within(error).getByText("This Mac's list of machines could not be read")).toBeTruthy();
    expect(error.querySelector('details')!.textContent).toBe('detailssvall host list exited 1: ssh: connect to host');
    expect(error.lastElementChild!.contains(screen.getByTestId('machines-reload'))).toBe(true);
    // a list that could not be read says nothing of there being no other machine
    expect(screen.queryByTestId('machines-empty')).toBeNull();
  });
});

const FAR_ME = 'aaaaaaaa-0000-4000-8000-000000000000';
const FAR_HOME = 'bbbbbbbb-0000-4000-8000-000000000000';
const CLAUDE = 'r:/home/ada/.claude';
const claude = {
  rootId: CLAUDE, root: '/home/ada/.claude', name: 'Claude', tier: 'global', islandIds: [], robotIds: [],
  groups: [{ kind: 'skills', items: [{ id: 's', name: 'review', reveal: '/x', target: 'folder', open: { rootId: CLAUDE, path: 'skills/review/SKILL.md' } }] }],
};
const tickRow = { key: 'claude:mcp:linear', status: 'warn', tick: { item: 'claude:mcp:linear', fields: ['env.KEY'], on: false, preview: ['env.KEY lin…90'] } };

function farWindow(answers: Record<string, (params: any) => unknown>, o: { follows?: boolean } = {}) {
  const follows = o.follows ?? true;
  call.mockImplementation((method: string, params: unknown) => {
    const answer = answers[method];
    return answer ? Promise.resolve().then(() => answer(params)) : Promise.resolve({});
  });
  act(() => {
    store.getState().setVia({ machine: FAR_ME as never, home: FAR_HOME as never, name: 'studio', ...(follows && { online: true as const }) });
    store.getState().setHome({ name: 'studio', state: follows ? 'connected' : 'unreachable', ...(follows && { master: { ssh: 'ada@studio', controlSocket: '/s' } }) });
    store.getState().setStatus('online');
  });
}
const SETUP = { 'home.setup': () => ({ rows: [tickRow] }), 'resources.get': () => ({ sources: [claude] }), 'fs.list': () => ({ entries: [{ name: 'style.md', kind: 'file' }] }) };

test('a far home\'s pane opens its files in the shelf, and one it has not as an unsaved buffer that only a save writes', async () => {
  try {
    farWindow({
      ...SETUP,
      'fs.list': (p: { path: string }) => ({ entries: p.path === 'rules' ? [{ name: 'style.md', kind: 'file' }, { name: 'deep', kind: 'dir' }] : [{ name: 'more.md', kind: 'file' }] }),
      'fs.read': () => { throw Object.assign(new Error('/home/ada/.claude is gone'), { code: 'not_found' }); },
      'fs.write': () => ({ mtimeMs: 5 }),
    });
    render(<SettingsCard />);
    show('setup');
    expect(screen.getByTestId('setup-lives').firstChild!.textContent).toBe('On studio');
    expect(screen.queryByTestId('setup-away')).toBeNull();
    expect((await screen.findByTestId('setup-open-skills')).getAttribute('aria-label')).toMatch(/^Open /);
    expect(screen.getByTestId('setup-files').textContent).toContain('skills · 1');
    await screen.findByTestId('setup-open-rules/style.md');
    await screen.findByTestId('setup-open-rules/deep/more.md');
    fireEvent.click(screen.getByTestId('setup-open-settings.json'));
    await waitFor(() => expect(store.getState().resourcesShown).toEqual({ rootId: CLAUDE, path: 'settings.json' }));
    expect(store.getState().resourcesOpen).toBe(true);
    expect(store.getState().settingsOpen).toBe(false);
    const seeded = getBuffer(CLAUDE, 'settings.json')!;
    expect([seeded.state.doc.toString(), seeded.mtimeMs, isDirty(seeded)]).toEqual(['{}\n', 0, false]);
    expect(call).not.toHaveBeenCalledWith('fs.write', expect.anything());
    // an untouched seed is no file, and a typed one is
    const files = { api: { call: call as never }, store: store as never };
    await saveFile(files, CLAUDE, 'settings.json');
    expect(call).not.toHaveBeenCalledWith('fs.write', expect.anything());
    seeded.state = seeded.state.update({ changes: { from: 0, insert: ' ' } }).state;
    await saveFile(files, CLAUDE, 'settings.json');
    expect(call).toHaveBeenCalledWith('fs.write', { id: CLAUDE, path: 'settings.json', text: ' {}\n', mtimeMs: 0, root: undefined });
    dropBuffer(CLAUDE, 'settings.json');
  } finally {
    call.mockImplementation(() => Promise.resolve({}));
  }
});

test('past six rules the rules fold behind one line, and rules that cannot be read are said in the group, not in a toast', async () => {
  try {
    const rules = Array.from({ length: 7 }, (_, i) => ({ name: `r${i}.md`, kind: 'file' }));
    farWindow({ ...SETUP, 'fs.list': () => ({ entries: rules }) });
    render(<SettingsCard />);
    show('setup');
    const fold = await screen.findByTestId('setup-rules-fold');
    expect([fold.textContent, fold.getAttribute('aria-expanded')]).toEqual(['7 rules', 'false']);
    expect(screen.queryByTestId('setup-open-rules/r0.md')).toBeNull();
    fireEvent.click(fold);
    expect(screen.getByTestId('setup-open-rules/r6.md')).toBeTruthy();
    cleanup();
    farWindow({ ...SETUP, 'fs.list': () => { throw new Error('ssh: connect to host studio port 22: timed out'); } });
    render(<SettingsCard />);
    show('setup');
    const failed = await screen.findByTestId('setup-rules-failed');
    expect([failed.className, failed.querySelector('.said')!.getAttribute('data-mark'), failed.querySelector('.said > div > span')!.textContent]).toEqual(['set-said', 'fail', 'The rules on studio could not be read']);
    expect(failed.querySelector('.modal-more-body')!.textContent).toBe('ssh: connect to host studio port 22: timed out');
    expect(store.getState().toast).toBeUndefined();
  } finally {
    call.mockImplementation(() => Promise.resolve({}));
  }
});

test('while the home\'s files are on their way the group says so, in the place they will take', () => {
  try {
    farWindow({ ...SETUP, 'resources.get': () => new Promise(() => {}) });
    render(<SettingsCard />);
    show('setup');
    const group = screen.getByTestId('setup-lives').parentElement!;
    expect(group.querySelector('.rows .move-spin')!.parentElement!.textContent).toBe("Reading studio's files…");
  } finally {
    call.mockImplementation(() => Promise.resolve({}));
  }
});

test('the pane\'s ticks go to this Mac\'s daemon, and the copy to the home, naming this Mac and what it replaced there', async () => {
  try {
    farWindow({
      ...SETUP,
      'home.setupConsent': () => ({ rows: [{ ...tickRow, tick: { ...tickRow.tick, on: true } }] }),
      'machines.copySetupFrom': () => ({ sent: 3, backup: '/home/ada/.svall/mirror-backup/2026-11-04' }),
    });
    render(<SettingsCard />);
    show('setup');
    const sw = await screen.findByTestId('setup-tick-claude:mcp:linear');
    expect(sw.getAttribute('aria-checked')).toBe('false');
    fireEvent.click(sw);
    await waitFor(() => expect(screen.getByTestId('setup-tick-claude:mcp:linear').getAttribute('aria-checked')).toBe('true'));
    expect(call).toHaveBeenCalledWith('home.setupConsent', { item: 'claude:mcp:linear', fields: ['env.KEY'], on: true });
    const copy = screen.getByTestId('setup-copy');
    expect(copy.closest('.row')!.firstChild!.textContent).toBe('this Mac → studio');
    expect(copy.textContent).toBe('Copy now');
    fireEvent.click(copy);
    expect(call).toHaveBeenCalledWith('machines.copySetupFrom', { machine: FAR_ME });
    const copied = await screen.findByTestId('setup-copied');
    expect(copied.querySelector('.said')!.getAttribute('data-mark')).toBe('ok');
    expect(copied.querySelector('.said > div > span')!.textContent).toBe('Copied to studio');
    expect(copied.querySelector('.set-note')!.textContent).toBe(`Kept in studio's backup from ${new Date(2026, 10, 4).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}: the files the copy replaced.`);
    expect(copied.querySelector('[data-tip]')!.getAttribute('data-tip')).toBe('/home/ada/.svall/mirror-backup/2026-11-04');
  } finally {
    call.mockImplementation(() => Promise.resolve({}));
  }
});

const twoKeys = { key: 'claude:mcp:two', status: 'warn', tick: { item: 'claude:mcp:two', fields: ['env.A', 'env.B'], on: false, preview: ['env.A a…1', 'env.B b…2'], ticked: ['env.A'] } };

test('a row of several keys has a switch for each and says when it is partly on, and each switch says only its own field', async () => {
  try {
    farWindow({
      ...SETUP,
      'home.setup': () => ({ rows: [twoKeys] }),
      'home.setupConsent': () => ({ rows: [{ ...twoKeys, tick: { ...twoKeys.tick, ticked: [] } }] }),
    });
    render(<SettingsCard />);
    show('setup');
    const a = await screen.findByTestId('setup-tick-claude:mcp:two#env.A');
    const b = screen.getByTestId('setup-tick-claude:mcp:two#env.B');
    expect([a.getAttribute('aria-checked'), b.getAttribute('aria-checked')]).toEqual(['true', 'false']);
    expect([a.getAttribute('aria-label'), b.getAttribute('aria-label')]).toEqual(["Send claude:mcp:two's A to studio", "Send claude:mcp:two's B to studio"]);
    expect(a.closest('.row')!.firstChild!.textContent).toBe("claude:mcp:two's A a…1");
    expect(a.closest('.row')!.classList.contains('set-sub')).toBe(true);
    // the item's own row names it once and says how many of its keys are on
    const partial = screen.getByTestId('setup-partial-claude:mcp:two');
    expect([partial.closest('.row')!.firstChild!.textContent, partial.textContent]).toEqual(['claude:mcp:two', '1 of 2 on']);
    expect(screen.queryByTestId('setup-tick-claude:mcp:two')).toBeNull();
    fireEvent.click(a);
    expect(call).toHaveBeenCalledWith('home.setupConsent', { item: 'claude:mcp:two', fields: ['env.A'], on: false });
    await waitFor(() => expect(screen.getByTestId('setup-partial-claude:mcp:two').textContent).toBe('0 of 2 on'));
  } finally {
    call.mockImplementation(() => Promise.resolve({}));
  }
});

test('an item that travels whole keeps one box', async () => {
  try {
    const whole = { key: 'claude:mcp:odd', status: 'warn', tick: { item: 'claude:mcp:odd', fields: ['command', 'sandbox'], on: false, preview: ['command', 'sandbox'] } };
    farWindow({ ...SETUP, 'home.setup': () => ({ rows: [whole] }) });
    render(<SettingsCard />);
    show('setup');
    fireEvent.click(await screen.findByTestId('setup-tick-claude:mcp:odd'));
    expect(call).toHaveBeenCalledWith('home.setupConsent', { item: 'claude:mcp:odd', fields: ['command', 'sandbox'], on: true });
  } finally {
    call.mockImplementation(() => Promise.resolve({}));
  }
});

test('a key unticked, and what was ticked whole before a move, are said by the pane\'s one sentence, no Copy runs by itself, and what a tick went over is named with the folder', async () => {
  try {
    const on = { ...tickRow, tick: { ...tickRow.tick, on: true, ticked: ['env.KEY'] } };
    farWindow({ ...SETUP, 'home.setup': () => ({ rows: [on], backup: '/b', replaced: ['linear'] }), 'home.setupConsent': () => ({ rows: [{ ...tickRow, tick: { ...tickRow.tick, ticked: [] } }], backup: '/b', replaced: ['linear'] }) });
    render(<SettingsCard />);
    show('setup');
    fireEvent.click(await screen.findByTestId('setup-tick-claude:mcp:linear'));
    expect(document.getElementById('set-tip-setup-keys')!.textContent).toBe('A key stays on this Mac unless you switch it on for studio; switched off, it leaves studio at the next copy. A server or file sent whole stays until you remove it on studio.');
    expect(call).not.toHaveBeenCalledWith('machines.copySetupFrom', expect.anything());
    expect((await screen.findByTestId('setup-replaced')).textContent).toBe("Also in it: this Mac's own linear.");
  } finally {
    call.mockImplementation(() => Promise.resolve({}));
  }
});

test('Copy waits for the rows and for each tick, and stays off with the failure shown until a check answers', async () => {
  try {
    let answerRows: ((r: unknown) => void) | undefined;
    farWindow({
      ...SETUP,
      'home.setup': () => new Promise((r) => { answerRows = r; }),
      'home.setupConsent': () => { throw new Error('the consent file cannot be written'); },
    });
    render(<SettingsCard />);
    show('setup');
    const copy = screen.getByTestId('setup-copy') as HTMLButtonElement;
    expect(copy.disabled).toBe(true);
    await waitFor(() => expect(answerRows).toBeDefined());
    act(() => answerRows!({ rows: [tickRow] }));
    await waitFor(() => expect(copy.disabled).toBe(false));
    fireEvent.click(screen.getByTestId('setup-tick-claude:mcp:linear'));
    expect(copy.disabled).toBe(true);
    expect((await screen.findByTestId('setup-failed')).textContent).toContain('the consent file cannot be written');
    expect(copy.disabled).toBe(true);
    answerRows = undefined;
    fireEvent.click(screen.getByTestId('setup-retry'));
    await waitFor(() => expect(answerRows).toBeDefined());
    act(() => answerRows!({ rows: [tickRow] }));
    await waitFor(() => expect(screen.queryByTestId('setup-failed')).toBeNull());
    expect(copy.disabled).toBe(false);
  } finally {
    call.mockImplementation(() => Promise.resolve({}));
  }
});

test('a push from the home that failed here is said under the home, what to expect under it and what went wrong behind details', async () => {
  try {
    farWindow({ ...SETUP, 'home.setup': () => ({ rows: [], pushFailed: "EACCES: permission denied, open '/Users/ada/.claude/settings.json'" }) });
    render(<SettingsCard />);
    show('setup');
    const failed = await screen.findByTestId('setup-push-failed');
    expect(failed.closest('.set-group')!.contains(screen.getByTestId('setup-lives'))).toBe(true);
    expect(within(failed).getByText('studio\'s agent setup has not reached this Mac yet')).toBeTruthy();
    expect(within(failed).getByText('Svall sends it again the next time this Mac links to studio').className).toBe('set-note');
    expect(failed.querySelector('.modal-more-body')!.textContent).toBe("EACCES: permission denied, open '/Users/ada/.claude/settings.json'");
  } finally {
    call.mockImplementation(() => Promise.resolve({}));
  }
});

test('until home.setup answers, a line says this Mac\'s agent setup is being read where its keys and backup will show', async () => {
  try {
    let answerRows: ((r: unknown) => void) | undefined;
    farWindow({ ...SETUP, 'home.setup': () => new Promise((r) => { answerRows = r; }) });
    render(<SettingsCard />);
    show('setup');
    const reading = screen.getByTestId('setup-reading');
    expect([reading.textContent, !!reading.querySelector('.move-spin')]).toEqual(["Reading this Mac's agent setup…", true]);
    await waitFor(() => expect(answerRows).toBeDefined());
    act(() => answerRows!({ rows: [tickRow], backup: '/Users/ada/.svall/mirror-backup/2026-11-04' }));
    await screen.findByTestId('setup-keys');
    expect(screen.getByTestId('setup-backup')).toBeTruthy();
    expect(screen.queryByTestId('setup-reading')).toBeNull();
  } finally {
    call.mockImplementation(() => Promise.resolve({}));
  }
});

test('a home.setup that fails says this Mac\'s setup could not be read, its words behind details, and leaves Copy off saying why', async () => {
  try {
    farWindow({ ...SETUP, 'home.setup': () => { throw new Error('this Mac\'s daemon did not answer'); } });
    render(<SettingsCard />);
    show('setup');
    const failed = await screen.findByTestId('setup-failed');
    expect(failed.querySelector('.said > div > span')!.textContent).toBe("This Mac's agent setup could not be read");
    expect(failed.querySelector('.modal-more-body')!.textContent).toBe("this Mac's daemon did not answer");
    expect(screen.queryByTestId('setup-reading')).toBeNull();
    const copy = screen.getByTestId('setup-copy') as HTMLButtonElement;
    expect([copy.disabled, copy.dataset.tip]).toEqual([true, "This Mac's agent setup could not be read"]);
  } finally {
    call.mockImplementation(() => Promise.resolve({}));
  }
});

test('the pane is four groups, and what a copy sends and a backup holds wait behind their Infos', async () => {
  try {
    farWindow({ ...SETUP, 'home.setup': () => ({ rows: [tickRow], backup: '/Users/ada/.svall/mirror-backup/2026-11-04' }) });
    render(<SettingsCard />);
    show('setup');
    await screen.findByTestId('setup-backup');
    expect([...document.querySelectorAll('.set-group > .kicker')].map((k) => k.firstChild!.textContent)).toEqual(['On studio', 'Copy from this Mac', 'Keys', 'Replaced on this Mac']);
    expect(document.getElementById('set-tip-setup-copy')!.textContent).toBe("Sends what changed on this Mac since the last copy; nothing is removed on studio except keys you switch off. The first copy replaces same-named files there and keeps the old ones in studio's backup folder.");
    expect(document.getElementById('set-tip-setup-backup')!.textContent).toContain('Put back what you want before you copy.');
    const folder = screen.getByTestId('setup-backup-show').closest('.row')!.firstChild as HTMLElement;
    const day = new Date(2026, 10, 4).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
    expect([folder.textContent, folder.getAttribute('data-tip')]).toEqual([`backup from ${day}`, '/Users/ada/.svall/mirror-backup/2026-11-04']);
    expect(document.querySelector('.set-win .desc, .set-win .opens')).toBeNull();
  } finally {
    call.mockImplementation(() => Promise.resolve({}));
  }
});

test('with no backup named the pane has no group for one', async () => {
  try {
    farWindow(SETUP);
    render(<SettingsCard />);
    show('setup');
    await screen.findByTestId('setup-tick-claude:mcp:linear');
    expect(screen.queryByTestId('setup-backup')).toBeNull();
  } finally {
    call.mockImplementation(() => Promise.resolve({}));
  }
});

test('a copy says what a tick went over on the home and what an untick left there', async () => {
  try {
    farWindow({
      ...SETUP,
      'machines.copySetupFrom': () => ({ sent: 1, backup: '/home/ada/.svall/mirror-backup/2026-11-04', replaced: ['linear'], left: ['odd'] }),
    });
    render(<SettingsCard />);
    show('setup');
    await screen.findByTestId('setup-tick-claude:mcp:linear');
    fireEvent.click(screen.getByTestId('setup-copy'));
    const copied = await screen.findByTestId('setup-copied');
    expect(copied.querySelector('.set-note')!.textContent).toBe(`Kept in studio's backup from ${new Date(2026, 10, 4).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}: linear. Left as edited on studio: odd.`);
  } finally {
    call.mockImplementation(() => Promise.resolve({}));
  }
});

test('a refused copy says why, and the pane names the folder the first push kept on this Mac', async () => {
  try {
    farWindow({
      ...SETUP,
      'home.setup': () => ({ rows: [], backup: '/Users/ada/.svall/mirror-backup/2026-11-04' }),
      'machines.copySetupFrom': () => { throw new Error('studio is not reachable'); },
    });
    render(<SettingsCard />);
    show('setup');
    expect((await screen.findByTestId('setup-backup')).textContent).toContain('Replaced on this Mac');
    fireEvent.click(screen.getByTestId('setup-backup-show'));
    expect(sent).toContainEqual({ type: 'openFolder', path: '/Users/ada/.svall/mirror-backup/2026-11-04', machine: FAR_ME });
    fireEvent.click(screen.getByTestId('setup-copy'));
    expect((await screen.findByTestId('setup-copy-failed')).textContent).toBe('studio is not reachable');
    // a refusal the daemon gave a fix says it under its sentence
    call.mockImplementation((m: string) => (m === 'machines.copySetupFrom'
      ? Promise.reject(Object.assign(new Error('Another copy is landing on studio'), { code: 'busy', data: { fix: 'Try again when it is done' } }))
      : Promise.resolve(m === 'home.setup' ? { rows: [] } : {})));
    await waitFor(() => expect((screen.getByTestId('setup-copy') as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByTestId('setup-copy'));
    // a copy refused as another lands is no failure: a quiet line, and Copy off saying why
    expect((await screen.findByTestId('setup-copy-landing')).textContent).toBe('Another copy is landing on studio…');
    expect(screen.queryByTestId('setup-copy-failed')).toBeNull();
    const copy = screen.getByTestId('setup-copy') as HTMLButtonElement;
    expect([copy.disabled, copy.dataset.tip]).toEqual([true, 'Another copy is landing on studio']);
  } finally {
    call.mockImplementation(() => Promise.resolve({}));
  }
});

test('in fallback the pane opens no file and takes no copy, and keeps this Mac\'s rows and backup', async () => {
  try {
    farWindow({ ...SETUP, 'home.setup': () => ({ rows: [tickRow], backup: '/Users/ada/.svall/mirror-backup/2026-11-04' }) }, { follows: false });
    render(<SettingsCard />);
    show('setup');
    expect(screen.getByTestId('setup-away').textContent).toBe('studio is not reachable; its files open once it is.');
    await screen.findByTestId('setup-tick-claude:mcp:linear');
    await screen.findByTestId('setup-backup');
    expect(screen.queryByTestId('setup-files')).toBeNull();
    expect((screen.getByTestId('setup-copy') as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByTestId('setup-copy').dataset.tip).toBe('studio is not reachable');
    expect(call).not.toHaveBeenCalledWith('resources.get', expect.anything());
  } finally {
    call.mockImplementation(() => Promise.resolve({}));
  }
});

test('a window on a worker the home dials has no route of its own, so it reads no file as the home\'s', async () => {
  try {
    farWindow(SETUP);
    act(() => store.getState().setHome({ name: 'studio', state: 'connected' }));
    render(<SettingsCard />);
    show('setup');
    expect(screen.getByTestId('setup-away').textContent).toBe('This window has no route to studio. Open Svall where it reaches studio to edit the setup.');
    expect((screen.getByTestId('setup-copy') as HTMLButtonElement).disabled).toBe(true);
  } finally {
    call.mockImplementation(() => Promise.resolve({}));
  }
});

test('what went wrong in the pane can be selected, and its button and a Copy that went well cannot', async () => {
  const style = document.head.appendChild(document.createElement('style'));
  style.textContent = fs.readFileSync(path.join(__dirname, '../../src/base.css'), 'utf8');
  const selectable = (el: Element) => getComputedStyle(el).getPropertyValue('user-select') === 'text';
  try {
    let copies = 0;
    farWindow({
      ...SETUP,
      'home.setup': () => ({ rows: [tickRow], pushFailed: 'config.toml cannot be parsed' }),
      'home.setupConsent': () => { throw new Error('the consent file cannot be written'); },
      'machines.copySetupFrom': () => {
        if (copies++) throw new Error('studio is not reachable');
        return { sent: 1 };
      },
    });
    render(<SettingsCard />);
    show('setup');
    expect(selectable(await screen.findByTestId('setup-push-failed'))).toBe(true);

    const copy = screen.getByTestId('setup-copy') as HTMLButtonElement;
    fireEvent.click(copy);
    expect(selectable(await screen.findByTestId('setup-copied'))).toBe(false);
    await waitFor(() => expect(copy.disabled).toBe(false));
    fireEvent.click(copy);
    expect(selectable(await screen.findByTestId('setup-copy-failed'))).toBe(true);
    await waitFor(() => expect(copy.disabled).toBe(false));

    fireEvent.click(screen.getByTestId('setup-tick-claude:mcp:linear'));
    const failed = await screen.findByTestId('setup-failed');
    expect(selectable(within(failed).getByText('the consent file cannot be written').closest('[data-error="true"]')!)).toBe(true);
    expect(screen.getByTestId('setup-retry').closest('[data-error="true"]')).toBeNull();
  } finally {
    style.remove();
    call.mockImplementation(() => Promise.resolve({}));
  }
});

test('a Mac home shows no Agent setup pane and asks nothing of it', () => {
  render(<SettingsCard />);
  expect(screen.queryByTestId('settings-tab-setup')).toBeNull();
  expect(call).not.toHaveBeenCalledWith('home.setup', expect.anything());
});

describe('Fleet config', () => {
  const MAC = '11111111-1111-4111-8111-111111111111' as MachineId;
  const STUDIO = '22222222-2222-4222-8222-222222222222' as MachineId;
  const button = () => screen.getByTestId('settings-fleet');
  const open = () => { render(<SettingsCard />); show('machine'); };

  test('on a Mac home opens in the text editor, by way of the shell', () => {
    call.mockClear();
    open();
    fireEvent.click(button());
    expect(sent).toContainEqual({ type: 'openConfig', which: 'fleet' });
    expect(call.mock.calls.filter(([m]) => m === 'fleet.config')).toEqual([]);
  });

  test('on a far home opens the home\'s fleet.json in the shelf\'s editor, and the Mac\'s stays shut', async () => {
    const rootId = 'r:/home/linus/.svall';
    call.mockImplementation(((m: string) => Promise.resolve(m === 'fleet.config' ? { rootId, path: 'fleet.json' } : m === 'fs.read' ? { text: '{}', mtimeMs: 1, root: '/home/linus/.svall' } : m === 'fs.write' ? { mtimeMs: 2 } : { serving: false, logins: [], phones: [] })) as never);
    act(() => { store.getState().setVia({ machine: MAC, home: STUDIO, name: 'studio', online: true }); store.getState().toggleSettings(true); });
    open();
    await act(async () => { fireEvent.click(button()); });
    expect(call).toHaveBeenCalledWith('fs.read', { id: rootId, path: 'fleet.json' });
    expect(store.getState().resourcesShown).toEqual({ rootId, path: 'fleet.json' });
    expect(store.getState().resourcesOpen).toBe(true);
    expect(store.getState().settingsOpen).toBe(false);
    expect(sent.filter((m) => m.type === 'openConfig')).toEqual([]);
    await act(async () => { await saveFile(deps(), rootId, 'fleet.json'); });
    expect(call).toHaveBeenCalledWith('fs.write', expect.objectContaining({ id: rootId, path: 'fleet.json' }));
    expect(store.getState().toast?.text).toBe('Saved on studio. Most of it takes effect when Svall\'s background service there next starts');
  });

  test('saying so on a save is for that file, on a far home', async () => {
    const rootId = 'r:/home/linus/.svall';
    call.mockImplementation(((m: string) => Promise.resolve(m === 'fleet.config' ? { rootId, path: 'fleet.json' } : m === 'fs.read' ? { text: '{}', mtimeMs: 1, root: '/home/linus/.svall' } : m === 'fs.write' ? { mtimeMs: 2 } : { serving: false, logins: [], phones: [] })) as never);
    act(() => store.getState().setVia({ machine: MAC, home: STUDIO, name: 'studio', online: true }));
    open();
    await act(async () => { fireEvent.click(button()); });
    await act(async () => { await openFile(deps(), rootId, 'other.json'); await saveFile(deps(), rootId, 'other.json'); });
    expect(store.getState().toast).toBeUndefined();
    act(() => store.getState().setVia(undefined));
    await act(async () => { await saveFile(deps(), rootId, 'fleet.json'); });
    expect(store.getState().toast).toBeUndefined();
  });

  test('a window its daemon serves opens nothing, names the home, and its Phone pane says there is no route', () => {
    act(() => store.getState().setVia({ machine: MAC, home: STUDIO, name: 'studio', online: true, served: true }));
    open();
    expect(button().hasAttribute('disabled')).toBe(true);
    expect(button().getAttribute('data-tip')).toBe('This window has no route to studio, where fleet.json is.');
    fireEvent.click(screen.getByTestId('settings-tab-phone'));
    expect(screen.getByTestId('set-mobile-away').textContent).toBe('This window has no route to studio. Open Svall where it reaches studio to change its phone link.');
  });

  test('a refusal is said where the button was', async () => {
    call.mockImplementation(((m: string) => (m === 'fleet.config' ? Promise.reject(new Error('the fleet\'s config is on its home')) : Promise.resolve({ serving: false, logins: [], phones: [] }))) as never);
    act(() => store.getState().setVia({ machine: MAC, home: STUDIO, name: 'studio', online: true }));
    open();
    await act(async () => { fireEvent.click(button()); });
    expect(store.getState().toast?.text).toBe('the fleet\'s config is on its home');
    expect(store.getState().resourcesShown).toBeUndefined();
  });

  test('while the home is out of reach it opens nothing, and this Mac\'s own file above all', () => {
    act(() => store.getState().setVia({ machine: MAC, home: STUDIO, name: 'studio' }));
    open();
    expect(button().hasAttribute('disabled')).toBe(true);
    expect(button().getAttribute('data-tip')).toBe('studio is not reachable; its fleet.json is there.');
    fireEvent.click(button());
    expect(sent.filter((m) => m.type === 'openConfig')).toEqual([]);
  });
});
