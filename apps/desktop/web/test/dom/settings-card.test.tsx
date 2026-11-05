// @vitest-environment jsdom
import fs from 'node:fs';
import path from 'node:path';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, test, vi } from 'vitest';
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
test('the Tailscale link in the phone tip opens in the default browser', () => {
  render(<SettingsCard />);
  show('phone');
  const link = screen.getByRole('link', { name: 'Tailscale' });
  expect(fireEvent.click(link)).toBe(false);
  expect(sent).toContainEqual({ type: 'openUrl', url: 'https://tailscale.com/download' });
});

test('the phone tip asks for Tailscale on the home: this Mac on the home, and by its name in a window on a worker', () => {
  render(<SettingsCard />);
  show('phone');
  const tip = screen.getByRole('link', { name: 'Tailscale' }).parentElement!;
  expect(tip.textContent).toContain('Needs Tailscale on this Mac and the phone.');
  act(() => store.getState().setVia({ machine: '4b7a3c1e-2d5f-4e6a-9b8c-0f1e2d3c4b5a' as MachineId, home: '0c1d2e3f-4a5b-4c6d-8e7f-9a0b1c2d3e4f' as MachineId, name: 'studio', online: true }));
  expect(tip.textContent).toContain('Needs Tailscale on studio and the phone.');
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

test('Machines asks the fleet again after a list that failed', async () => {
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
    });
    render(<SettingsCard />);
    show('machines');
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(screen.queryByTestId('machine-studio')).toBeNull();
    fails = false;
    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
    expect(screen.queryByTestId('machine-studio')).not.toBeNull();
  } finally {
    vi.useRealTimers();
    call.mockImplementation(() => Promise.resolve({}));
  }
});

test('a window standing in for its home offers no Phone pane, and no Add machine', async () => {
  try {
    act(() => {
      store.getState().setVia({ machine: 'aaaaaaaa-0000-4000-8000-000000000000' as never, home: 'bbbbbbbb-0000-4000-8000-000000000000' as never, name: 'studio' });
      store.getState().setStatus('online');
    });
    render(<SettingsCard />);
    expect(screen.queryByTestId('set-tab-phone')).toBeNull();
    show('machines');
    expect(screen.queryByTestId('machine-add')).toBeNull();
  } finally {
    call.mockImplementation(() => Promise.resolve({}));
  }
});

test('Machines names each machine\'s role from the fleet, the home first and a worker that dials in too, and a far home takes no Add machine', async () => {
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
    });
    render(<SettingsCard />);
    show('machines');
    await screen.findByTestId('machine-studio');
    act(() => store.getState().setMachines([{ id: HOME, name: 'studio', ssh: 'ada@studio', platform: 'linux-x64' }] as never));
    const rows = [...screen.getByTestId('machines').querySelectorAll('.machine')];
    expect(rows.map((r) => r.getAttribute('data-role'))).toEqual(['home', 'worker', 'worker', 'worker']);
    expect(screen.getByTestId('machine-studio').textContent).toContain('home · ada@studio · 7 robots');
    expect(screen.getByTestId('machine-mac').textContent).toContain('this Mac');
    expect(screen.getByTestId('machine-mac').textContent).toContain('worker · 3 robots');
    expect(screen.getByTestId('machine-laptop').textContent).toContain('dials in');
    // no route in this Mac's registry says nothing of who opens the link
    expect(screen.getByTestId('machine-vault').textContent).not.toContain('dials in');
    expect(screen.queryByTestId('machine-add')).toBeNull();
    // the far home has its Check and ⋯ from this window; a worker of it is that home's to manage
    expect(screen.getByTestId('machine-studio').querySelector('[data-testid="machine-doctor"]')).not.toBeNull();
    expect(screen.getByTestId('machine-mac').querySelector('[data-testid="machine-doctor"]')).toBeNull();
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
    expect(screen.getByTestId('setup-lives').textContent).toContain('lives on studio');
    expect(screen.queryByTestId('setup-away')).toBeNull();
    expect((await screen.findByTestId('setup-open-skills')).getAttribute('aria-label')).toMatch(/^Open /);
    expect(screen.getByTestId('setup-files').textContent).toContain('1 skill');
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

test('the pane\'s ticks go to this Mac\'s daemon, and the copy to the home, naming this Mac and what it replaced there', async () => {
  try {
    farWindow({
      ...SETUP,
      'home.setupConsent': () => ({ rows: [{ ...tickRow, tick: { ...tickRow.tick, on: true } }] }),
      'machines.copySetupFrom': () => ({ sent: 3, backup: '/home/ada/.svall/mirror-backup/2026-11-04' }),
    });
    render(<SettingsCard />);
    show('setup');
    const box = await screen.findByTestId('setup-tick-claude:mcp:linear') as HTMLInputElement;
    expect(box.checked).toBe(false);
    fireEvent.click(box);
    await waitFor(() => expect((screen.getByTestId('setup-tick-claude:mcp:linear') as HTMLInputElement).checked).toBe(true));
    expect(call).toHaveBeenCalledWith('home.setupConsent', { item: 'claude:mcp:linear', fields: ['env.KEY'], on: true });
    const copy = screen.getByTestId('setup-copy');
    expect(copy.textContent).toBe('Copy my agent setup from this Mac to studio');
    fireEvent.click(copy);
    expect(call).toHaveBeenCalledWith('machines.copySetupFrom', { machine: FAR_ME });
    expect((await screen.findByTestId('setup-copied')).textContent).toBe('Copied to studio. What it replaced there is in /home/ada/.svall/mirror-backup/2026-11-04.');
  } finally {
    call.mockImplementation(() => Promise.resolve({}));
  }
});

const twoKeys = { key: 'claude:mcp:two', status: 'warn', tick: { item: 'claude:mcp:two', fields: ['env.A', 'env.B'], on: false, preview: ['env.A a…1', 'env.B b…2'], ticked: ['env.A'] } };

test('a row of several keys has a box for each and says when it is partly ticked, and each box says only its own field', async () => {
  try {
    farWindow({
      ...SETUP,
      'home.setup': () => ({ rows: [twoKeys] }),
      'home.setupConsent': () => ({ rows: [{ ...twoKeys, tick: { ...twoKeys.tick, ticked: [] } }] }),
    });
    render(<SettingsCard />);
    show('setup');
    const a = await screen.findByTestId('setup-tick-claude:mcp:two#env.A') as HTMLInputElement;
    const b = screen.getByTestId('setup-tick-claude:mcp:two#env.B') as HTMLInputElement;
    expect([a.checked, b.checked]).toEqual([true, false]);
    expect(screen.getByTestId('setup-partial-claude:mcp:two').textContent).toContain('1 of 2 keys go');
    expect(screen.queryByTestId('setup-tick-claude:mcp:two')).toBeNull();
    fireEvent.click(a);
    expect(call).toHaveBeenCalledWith('home.setupConsent', { item: 'claude:mcp:two', fields: ['env.A'], on: false });
    await waitFor(() => expect(screen.queryByTestId('setup-partial-claude:mcp:two')).toBeNull());
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

test('a key unticked is said by the pane\'s one sentence, no Copy runs by itself, and what a tick went over is named with the folder', async () => {
  try {
    const on = { ...tickRow, tick: { ...tickRow.tick, on: true, ticked: ['env.KEY'] } };
    farWindow({ ...SETUP, 'home.setup': () => ({ rows: [on], backup: '/b', replaced: ['linear'] }), 'home.setupConsent': () => ({ rows: [{ ...tickRow, tick: { ...tickRow.tick, ticked: [] } }], backup: '/b', replaced: ['linear'] }) });
    render(<SettingsCard />);
    show('setup');
    fireEvent.click(await screen.findByTestId('setup-tick-claude:mcp:linear'));
    expect(screen.getByTestId('setup-keys').textContent).toContain('A key you untick stays on studio until the next Copy');
    expect(call).not.toHaveBeenCalledWith('machines.copySetupFrom', expect.anything());
    expect((await screen.findByTestId('setup-replaced')).textContent).toContain('for linear: that is in this folder');
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

test('a push from the home that failed here is said', async () => {
  try {
    farWindow({ ...SETUP, 'home.setup': () => ({ rows: [], pushFailed: 'config.toml cannot be parsed' }) });
    render(<SettingsCard />);
    show('setup');
    expect((await screen.findByTestId('setup-push-failed')).textContent).toContain('studio\'s last push here did not land: config.toml cannot be parsed');
  } finally {
    call.mockImplementation(() => Promise.resolve({}));
  }
});

test('a home.setup that fails shows why and leaves Copy off', async () => {
  try {
    farWindow({ ...SETUP, 'home.setup': () => { throw new Error('this Mac\'s daemon did not answer'); } });
    render(<SettingsCard />);
    show('setup');
    expect((await screen.findByTestId('setup-failed')).textContent).toContain('did not answer');
    expect((screen.getByTestId('setup-copy') as HTMLButtonElement).disabled).toBe(true);
  } finally {
    call.mockImplementation(() => Promise.resolve({}));
  }
});

test('the pane says what a Copy sends: with a backup named, to put back what is wanted first; only what changed; the first Copy\'s exception', async () => {
  try {
    farWindow({ ...SETUP, 'home.setup': () => ({ rows: [tickRow], backup: '/Users/ada/.svall/mirror-backup/2026-11-04' }) });
    render(<SettingsCard />);
    show('setup');
    await screen.findByTestId('setup-backup');
    const says = screen.getByTestId('setup-copy-says').textContent;
    expect(says).toContain('replaced same-named files on this Mac');
    expect(says).toContain('Put back what you want from there first');
    expect(says).toContain('only what changed on this Mac since the last one');
    expect(says).toContain('The first Copy has no last one');
    expect(says).toContain('removes nothing on studio');
    expect(screen.getByTestId('setup-keys').textContent).toContain('anything written in them included');
  } finally {
    call.mockImplementation(() => Promise.resolve({}));
  }
});

test('with no backup named the pane does not speak of one', async () => {
  try {
    farWindow(SETUP);
    render(<SettingsCard />);
    show('setup');
    await screen.findByTestId('setup-tick-claude:mcp:linear');
    expect(screen.getByTestId('setup-copy-says').textContent).not.toContain('Put back');
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
    const said = (await screen.findByTestId('setup-copied')).textContent;
    expect(said).toContain('A tick went over what studio held itself for linear: that is in its backup folder.');
    expect(said).toContain('odd stays as you edited it, with any key the mirror copied in it; remove it yourself.');
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
    expect((await screen.findByTestId('setup-backup')).textContent).toContain('/Users/ada/.svall/mirror-backup/2026-11-04');
    fireEvent.click(screen.getByTestId('setup-backup-show'));
    expect(sent).toContainEqual({ type: 'openFolder', path: '/Users/ada/.svall/mirror-backup/2026-11-04', machine: FAR_ME });
    fireEvent.click(screen.getByTestId('setup-copy'));
    expect((await screen.findByTestId('setup-copy-failed')).textContent).toBe('studio is not reachable');
  } finally {
    call.mockImplementation(() => Promise.resolve({}));
  }
});

test('in fallback the pane opens no file and takes no copy, and keeps this Mac\'s rows and backup', async () => {
  try {
    farWindow({ ...SETUP, 'home.setup': () => ({ rows: [tickRow], backup: '/Users/ada/.svall/mirror-backup/2026-11-04' }) }, { follows: false });
    render(<SettingsCard />);
    show('setup');
    expect(screen.getByTestId('setup-away').textContent).toContain('while this window reaches studio');
    await screen.findByTestId('setup-tick-claude:mcp:linear');
    await screen.findByTestId('setup-backup');
    expect(screen.queryByTestId('setup-files')).toBeNull();
    expect((screen.getByTestId('setup-copy') as HTMLButtonElement).disabled).toBe(true);
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
    expect(screen.getByTestId('setup-away').textContent).toContain('studio reaches this Mac over its own link');
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
    expect(selectable(within(failed).getByText('the consent file cannot be written'))).toBe(true);
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
    expect(store.getState().toast?.text).toBe('Saved on studio. Most of it takes effect when its daemon next starts');
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

  test('a window its daemon serves opens nothing, names the home, and has no phone tab', () => {
    act(() => store.getState().setVia({ machine: MAC, home: STUDIO, name: 'studio', online: true, served: true }));
    open();
    expect(button().hasAttribute('disabled')).toBe(true);
    expect(button().getAttribute('data-tip')).toBe('This window has no route to studio, where its fleet.json is');
    expect(screen.queryByTestId('settings-tab-phone')).toBeNull();
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
    expect(button().getAttribute('data-tip')).toBe('studio is not reachable, and its fleet.json is there');
    fireEvent.click(button());
    expect(sent.filter((m) => m.type === 'openConfig')).toEqual([]);
  });
});
