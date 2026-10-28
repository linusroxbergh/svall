// @vitest-environment jsdom
import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, expect, test, vi } from 'vitest';
import { ApiError } from '../../src/api.js';
import { call, freshStore, sent, store } from './harness.js';

vi.mock('../../src/boot.js', async () => (await import('./harness.js')).bootModule());

const { HostSetup } = await import('../../src/HostSetup.js');

beforeEach(() => {
  freshStore();
  call.mockImplementation(() => Promise.resolve({}));
  store.getState().setShell({ home: '/Users/ada/.svall', log: [], op: false });
});

test('opened to add a machine, the panel asks its name and ssh, and the run it starts is that machine\'s', () => {
  render(<HostSetup />);
  act(() => store.getState().toggleHost(true));
  for (const id of ['host-name', 'host-ssh']) {
    expect(['autocapitalize', 'autocorrect', 'spellcheck', 'autocomplete'].map((a) => screen.getByTestId(id).getAttribute(a)), id).toEqual(['off', 'off', 'false', 'off']);
  }
  fireEvent.change(screen.getByTestId('host-name'), { target: { value: 'studio' } });
  fireEvent.change(screen.getByTestId('host-ssh'), { target: { value: 'ada@studio' } });
  fireEvent.click(screen.getByTestId('host-add'));
  expect(sent).toContainEqual({ type: 'host.start', op: 'add', args: { name: 'studio', ssh: 'ada@studio' } });
  expect(screen.queryByTestId('host-name')).toBeNull();
  expect(screen.getByTestId('host-machine').textContent).toBe('studio');
});

test('opened on a machine, the panel names it once and acts on it without asking its name', () => {
  render(<HostSetup />);
  act(() => store.getState().toggleHost(true, 'trift'));
  expect(screen.queryByTestId('host-name')).toBeNull();
  expect(screen.queryByTestId('host-ssh')).toBeNull();
  expect(screen.getByTestId('host-machine').textContent).toBe('trift');
  fireEvent.click(screen.getByTestId('machine-more'));
  fireEvent.click(screen.getByTestId('machine-upgrade'));
  expect(sent).toContainEqual({ type: 'host.start', op: 'upgrade', args: { name: 'trift' } });
  // one run at a time
  expect((screen.getByTestId('machine-doctor') as HTMLButtonElement).disabled).toBe(true);
});
test('a step that failed shows what to do; a step of a run other than a check offers the run again, a check row leaves that to Check', () => {
  render(<HostSetup />);
  act(() => {
    store.getState().toggleHost(true, 'trift');
    store.getState().hostStarted('doctor', { name: 'trift' });
    store.getState().hostStep('doctor', { step: 'tmux', status: 'fail', detail: 'tmux is not installed' });
    store.getState().hostStep('doctor', { step: 'linger', status: 'fail', detail: 'off', action: 'ssh ada@trift, then loginctl enable-linger ada' });
    store.getState().hostDone('doctor', 1);
  });
  expect(screen.getByTestId('host-action-linger').textContent).toBe('ssh ada@trift, then loginctl enable-linger ada');
  expect(screen.queryByTestId('host-again-linger')).toBeNull();
  expect(screen.queryByTestId('host-again-tmux')).toBeNull();
  act(() => {
    store.getState().hostStarted('upgrade', { name: 'trift' });
    store.getState().hostStep('upgrade', { step: 'install', status: 'fail', detail: 'install exited 1' });
    store.getState().hostDone('upgrade', 1);
  });
  sent.length = 0;
  fireEvent.click(screen.getByTestId('host-again-install'));
  expect(sent).toEqual([{ type: 'host.start', op: 'upgrade', args: { name: 'trift' } }]);
});

test('a running check shows the step under way and what needs the user as found, the fine checks and the agent setup each folded behind one line', () => {
  render(<HostSetup />);
  act(() => {
    store.getState().setMachines([{ name: 'trift', id: 'm1', ssh: 'ada@trift', platform: 'linux-x64' }]);
    store.getState().toggleHost(true, 'trift');
    store.getState().hostStarted('doctor', { name: 'trift' });
    store.getState().hostStep('doctor', { step: 'master', status: 'start' });
    store.getState().hostStep('doctor', { step: 'master', status: 'ok', detail: 'connected to ada@trift' });
    store.getState().hostStep('doctor', { step: 'doctor', status: 'start' });
  });
  const rows = () => screen.queryAllByTestId(/^host-step-/).map((e) => e.getAttribute('data-testid'));
  expect(screen.getByTestId('host-now').textContent).toBe("Machine's own checks…");
  expect(screen.getByTestId('host-fine').textContent).toBe('1 check fine');
  expect(rows()).toEqual([]);
  act(() => {
    store.getState().hostStep('doctor', { step: 'doctor', status: 'ok', detail: 'answered' });
    store.getState().hostStep('doctor', { step: 'systemd', status: 'ok', detail: 'active' });
    store.getState().hostStep('doctor', { step: 'opencode', status: 'warn', detail: 'opencode v2.1.4, not signed in: opencode auth login', run: 'opencode auth login' });
    store.getState().hostStep('doctor', { step: 'mirror:var:X', status: 'warn', detail: 'd', action: 'set X on trift', run: 'svall worker env X', gap: { name: 'X', what: 'not set' } });
    store.getState().hostDone('doctor', 0);
  });
  expect(screen.queryByTestId('host-now')).toBeNull();
  expect(rows()).toEqual(['host-step-opencode']);
  // the command its terminal types is behind details
  expect(screen.getByTestId('host-step-opencode').querySelector('.host-said')?.firstChild?.textContent).toBe('opencode v2.1.4, not signed in');
  expect(screen.getByTestId('host-details-opencode').textContent).toBe('detailsopencode auth login');
  expect(screen.getByTestId('host-fine').textContent).toBe('3 checks fine');
  fireEvent.click(screen.getByTestId('host-fine'));
  expect(rows()).toEqual(['host-step-master', 'host-step-doctor', 'host-step-systemd', 'host-step-opencode']);
  fireEvent.click(screen.getByTestId('host-setup-fold'));
  expect(rows()).toContain('host-step-mirror:var:X');
});

test('a run ends in one line and Done, whether or not something is left', () => {
  render(<HostSetup />);
  act(() => {
    store.getState().setMachines([{ name: 'trift', id: 'm1', ssh: 'ada@trift', platform: 'linux-x64' }]);
    store.getState().toggleHost(true, 'trift');
    store.getState().hostStarted('upgrade', { name: 'trift' });
    store.getState().hostStep('upgrade', { step: 'probe', status: 'ok', detail: 'trift answers on release 1.2.3' });
    store.getState().hostDone('upgrade', 0);
  });
  expect(screen.getByTestId('host-outcome').textContent).toBe('trift is ready. Robots you move there keep working while this Mac sleeps.Done');
  expect(screen.queryByTestId('host-check-again')).toBeNull();
  fireEvent.click(screen.getByTestId('host-done'));
  expect(store.getState().hostOpen).toBe(false);

  act(() => {
    store.getState().toggleHost(true, 'trift');
    store.getState().hostStarted('doctor', { name: 'trift' });
    store.getState().hostStep('doctor', { step: 'claude', status: 'warn', detail: 'not logged in', action: 'ssh ada@trift, then claude auth login' });
    store.getState().hostStep('doctor', { step: 'systemd', status: 'fail', detail: 'inactive' });
    store.getState().hostDone('doctor', 1);
  });
  expect(screen.getByTestId('host-outcome').textContent).toBe('trift has 2 things to fix.Done');
  expect(screen.queryByTestId('host-again-systemd')).toBeNull();
  sent.length = 0;
  fireEvent.click(screen.getByTestId('machine-doctor'));
  expect(sent).toEqual([{ type: 'host.start', op: 'doctor', args: { name: 'trift' } }]);
});

const MACHINE = '5d4d0b1c-2d3e-4f50-8617-9a0b1c2d3e4f';
const tick = (on: boolean) => ({ item: 'claude:mcp:linear', fields: ['env.LINEAR_API_KEY'], on, preview: ['env.LINEAR_API_KEY lin…90'] });
const unticked = {
  step: 'mirror:claude:mcp:linear', status: 'warn' as const, action: "copy linear's keys to trift", tick: tick(false),
  detail: 'mirrored without env.LINEAR_API_KEY lin…90; or set them in ~/.svall/mirror-overrides on trift', gap: { name: 'linear', what: 'keys not copied (env.LINEAR_API_KEY)' },
};
// a check of trift whose report has one server to copy the keys of, a variable and the check after it
function checked(machines = [{ name: 'trift', id: MACHINE, ssh: 'ada@trift', platform: 'linux-x64' }]) {
  render(<HostSetup />);
  act(() => {
    store.getState().setMachines(machines);
    store.getState().toggleHost(true, 'trift');
    store.getState().hostStarted('doctor', { name: 'trift' });
    store.getState().hostStep('doctor', { step: 'ssh', status: 'ok', detail: 'ada@trift accepted an interactive login' });
    store.getState().hostStep('doctor', unticked);
    store.getState().hostStep('doctor', { step: 'mirror:var:X', status: 'ok', detail: 'X is set on trift' });
    store.getState().hostStep('doctor', { step: 'probe', status: 'ok', detail: 'trift answers' });
    store.getState().hostDone('doctor', 0);
  });
  // the agent setup is folded until opened
  fireEvent.click(screen.getByTestId('host-setup-fold'));
}

test('a mirror row is one sentence, a tick and its details; the tick asks svalld and the rows it answers stand in place', async () => {
  call.mockImplementation(async (method: string) => (method === 'machines.consent'
    ? { rows: [{ key: 'claude:mcp:linear', status: 'ok', detail: 'keys copied to trift: env.LINEAR_API_KEY lin…90', tick: tick(true) }] } : {}));
  checked();
  const row = screen.getByTestId('host-step-mirror:claude:mcp:linear');
  expect(row.querySelector('.host-name')?.textContent).toBe('Claude MCP linear');
  expect(screen.getByTestId('host-action-mirror:claude:mcp:linear').textContent).toBe("copy linear's keys to trift");
  expect(screen.getByTestId('host-details-mirror:claude:mcp:linear').textContent)
    .toBe('detailsmirrored without env.LINEAR_API_KEY lin…90; or set them in ~/.svall/mirror-overrides on trift');
  expect(screen.getByTestId('host-outcome').textContent).toBe('trift is ready. 1 part of your agent setup will not work there yet.Done');
  const box = screen.getByTestId('host-tick-mirror:claude:mcp:linear') as HTMLInputElement;
  expect([box.type, box.checked, box.disabled]).toEqual(['checkbox', false, false]);
  // what ticking does is the sentence beside the box
  expect(document.getElementById(box.getAttribute('aria-describedby')!)?.textContent).toBe("copy linear's keys to trift");

  await act(async () => { fireEvent.click(box); });
  expect(call).toHaveBeenCalledWith('machines.consent', { machine: MACHINE, item: 'claude:mcp:linear', fields: ['env.LINEAR_API_KEY'], on: true });
  expect(store.getState().host?.steps.map((s) => s.step)).toEqual(['ssh', 'mirror:claude:mcp:linear', 'probe']);
  expect(screen.getByTestId('host-step-mirror:claude:mcp:linear').getAttribute('data-status')).toBe('ok');
  expect((screen.getByTestId('host-tick-mirror:claude:mcp:linear') as HTMLInputElement).checked).toBe(true);
  expect(screen.queryByTestId('host-details-mirror:claude:mcp:linear')).toBeNull();
  expect(screen.getByTestId('host-outcome').textContent).toBe('trift is ready. Robots you move there keep working while this Mac sleeps.Done');
});

test('a tick the worker did not take says why on its row, and the rows are read again as svalld kept them', async () => {
  call.mockImplementation(async (method: string) => {
    if (method === 'machines.consent') throw new ApiError('not_mirrored', `the change is saved, but machine ${MACHINE} did not take it: token=s3cr3t`);
    return { rows: [{ key: 'claude:mcp:linear', status: 'warn', action: 'check trift again', detail: 'pushed; not yet on trift', tick: tick(true) }] };
  });
  checked();
  await act(async () => { fireEvent.click(screen.getByTestId('host-tick-mirror:claude:mcp:linear')); });
  expect(call.mock.calls.map(([method, params]) => [method, params])).toEqual([
    ['machines.consent', { machine: MACHINE, item: 'claude:mcp:linear', fields: ['env.LINEAR_API_KEY'], on: true }],
    ['machines.setup', { machine: MACHINE }],
  ]);
  const failed = screen.getByTestId('host-tick-failed-mirror:claude:mcp:linear');
  expect([failed.textContent, failed.getAttribute('role')]).toEqual(['the change is saved, but trift did not take it: token=…', 'status']);
  expect(screen.getByTestId('host-action-mirror:claude:mcp:linear').textContent).toBe('check trift again');
  expect((screen.getByTestId('host-tick-mirror:claude:mcp:linear') as HTMLInputElement).checked).toBe(true);
});

test('a tick under way keeps the box where focus is, showing what was asked, and takes no second change', async () => {
  let answer: (v: unknown) => void = () => {};
  call.mockImplementation((method: string) => (method === 'machines.consent' ? new Promise((resolve) => { answer = resolve; }) : Promise.resolve({})));
  checked();
  const box = () => screen.getByTestId('host-tick-mirror:claude:mcp:linear') as HTMLInputElement;
  box().focus();
  await act(async () => { fireEvent.click(box()); });
  expect([box().checked, box().disabled, box().getAttribute('aria-disabled'), document.activeElement === box()]).toEqual([true, false, 'true', true]);
  // the row says what is under way, and its box is described by that
  expect(screen.getByTestId('host-pushing-mirror:claude:mcp:linear').textContent).toBe('pushing to trift…');
  expect(document.getElementById(box().getAttribute('aria-describedby')!)?.textContent).toBe('pushing to trift…');
  await act(async () => { fireEvent.click(box()); });
  expect(call.mock.calls.filter(([method]) => method === 'machines.consent')).toHaveLength(1);
  expect(box().checked).toBe(true);
  await act(async () => { answer({ rows: [{ key: 'claude:mcp:linear', status: 'ok', detail: 'keys copied to trift', tick: tick(true) }] }); });
  expect([box().checked, box().getAttribute('aria-disabled')]).toEqual([true, null]);
  expect(screen.queryByTestId('host-pushing-mirror:claude:mcp:linear')).toBeNull();
});

test('a consent answer goes to the run its tick was made in, not to a later run of the machine of another kind', async () => {
  let answer: (v: unknown) => void = () => {};
  call.mockImplementation((method: string) => (method === 'machines.consent' ? new Promise((resolve) => { answer = resolve; }) : Promise.resolve({})));
  checked();
  await act(async () => { fireEvent.click(screen.getByTestId('host-tick-mirror:claude:mcp:linear')); });
  act(() => {
    store.getState().hostStarted('upgrade', { name: 'trift' });
    store.getState().hostStep('upgrade', { step: 'probe', status: 'ok', detail: 'trift answers on release 1.2.3' });
    store.getState().hostDone('upgrade', 0);
  });
  await act(async () => { answer({ rows: [{ key: 'claude:mcp:linear', status: 'ok', detail: 'keys copied to trift', tick: tick(true) }] }); });
  expect(store.getState().host?.steps.map((s) => s.step)).toEqual(['probe']);
});

test('a machine not yet in the list has its rows shown but nothing ticked, and the sheet keeps its title and outcome out of the scrolling rows', () => {
  checked([]);
  const box = screen.getByTestId('host-tick-mirror:claude:mcp:linear') as HTMLInputElement;
  expect([box.disabled, box.getAttribute('data-tip')]).toEqual([true, 'listed once the machine is added']);
  const body = document.querySelector('.host-body')!;
  expect(body.contains(screen.getByTestId('host-steps'))).toBe(true);
  expect(body.contains(screen.getByTestId('host-machine'))).toBe(false);
  expect(body.contains(screen.getByTestId('host-outcome'))).toBe(false);
  expect(screen.getByTestId('host-outcome').classList).toContain('host-foot');
});

test('a check row whose fix is an agent update runs it there from the row and checks again; one that fails says why on the row', async () => {
  let finish!: (e?: Error) => void;
  call.mockImplementation((method: string) => (method === 'machines.updateAgents' ? new Promise((resolve, reject) => { finish = (e) => (e ? reject(e) : resolve({})); }) : Promise.resolve({})));
  render(<HostSetup />);
  act(() => {
    store.getState().setMachines([{ name: 'trift', id: MACHINE, ssh: 'ada@trift', platform: 'linux-x64' }]);
    store.getState().toggleHost(true, 'trift');
    store.getState().hostStarted('doctor', { name: 'trift' });
    store.getState().hostStep('doctor', { step: 'versions', status: 'warn', detail: 'claude 1.2.3 there, behind 1.2.4 on this Mac', action: 'ssh ada@trift, then claude update && codex update', run: 'claude update && codex update' });
    store.getState().hostStep('doctor', { step: 'claude', status: 'warn', detail: '1.2.3, not logged in', action: 'ssh ada@trift, then claude auth login', run: 'claude auth login' });
    store.getState().hostDone('doctor', 1);
  });
  // a login is the user's own, in a terminal there
  expect(screen.getByTestId('host-terminal-claude').textContent).toBe('Open terminal');
  await act(async () => { fireEvent.click(screen.getByTestId('host-update-versions')); });
  expect(call).toHaveBeenCalledWith('machines.updateAgents', { machine: MACHINE, kinds: ['claude', 'codex'] });
  expect(screen.getByTestId('host-updating-versions').textContent).toBe('updating on trift…');

  await act(async () => finish(new Error('codex update exited 1: no network')));
  expect(screen.getByTestId('host-tick-failed-versions').textContent).toBe('codex update exited 1: no network');
  expect(sent.filter((m) => m.type === 'host.start')).toEqual([]);

  await act(async () => { fireEvent.click(screen.getByTestId('host-update-versions')); });
  await act(async () => finish());
  expect(sent.filter((m) => m.type === 'host.start')).toEqual([{ type: 'host.start', op: 'doctor', args: { name: 'trift' } }]);
});

test('a check that finds the machine on another release offers its upgrade on that row', () => {
  render(<HostSetup />);
  act(() => {
    store.getState().setMachines([{ name: 'trift', id: MACHINE, ssh: 'ada@trift', platform: 'linux-x64' }]);
    store.getState().toggleHost(true, 'trift');
    store.getState().hostStarted('doctor', { name: 'trift' });
    store.getState().hostStep('doctor', { step: 'release', status: 'fail', detail: '0.20.0 (signed), protocol 3; this controller runs 0.21.0 (signed), protocol 3' });
    store.getState().hostDone('doctor', 1);
  });
  expect(screen.queryByTestId('host-again-release')).toBeNull();
  fireEvent.click(screen.getByTestId('host-upgrade'));
  expect(sent.at(-1)).toEqual({ type: 'host.start', op: 'upgrade', args: { name: 'trift' } });
});

test('a check row keeps what is wrong in its sentence and puts only the command behind details', () => {
  render(<HostSetup />);
  act(() => {
    store.getState().setMachines([{ name: 'trift', id: MACHINE, ssh: 'ada@trift', platform: 'linux-x64' }]);
    store.getState().toggleHost(true, 'trift');
    store.getState().hostStarted('doctor', { name: 'trift' });
    store.getState().hostStep('doctor', {
      step: 'linger', status: 'warn', detail: 'off for ada: the fleet stops when you log out; ssh ada@trift, then sudo loginctl enable-linger ada', run: 'sudo loginctl enable-linger ada',
    });
    store.getState().hostDone('doctor', 0);
  });
  expect(screen.getByTestId('host-step-linger').querySelector('.host-said')?.firstChild?.textContent).toBe('off for ada: the fleet stops when you log out');
  expect(screen.getByTestId('host-details-linger').textContent).toBe('detailsssh ada@trift, then sudo loginctl enable-linger ada');
});

test('a machine on a newer release than this Mac is not offered an upgrade there', () => {
  render(<HostSetup />);
  act(() => {
    store.getState().setMachines([{ name: 'trift', id: MACHINE, ssh: 'ada@trift', platform: 'linux-x64' }]);
    store.getState().toggleHost(true, 'trift');
    store.getState().hostStarted('doctor', { name: 'trift' });
    store.getState().hostStep('doctor', { step: 'release', status: 'fail', detail: '0.22.0 (signed), protocol 3; this controller runs 0.21.0 (signed), protocol 3', action: 'update svall on this Mac' });
    store.getState().hostDone('doctor', 1);
  });
  expect(screen.queryByTestId('host-upgrade')).toBeNull();
  expect(screen.getByTestId('host-action-release').textContent).toBe('update svall on this Mac');
});

test('an agent update keeps its row through the fine checks opening, and leaves a run started meanwhile alone', async () => {
  let finish!: () => void;
  call.mockImplementation((method: string) => (method === 'machines.updateAgents' ? new Promise((resolve) => { finish = () => resolve({}); }) : Promise.resolve({})));
  render(<HostSetup />);
  act(() => {
    store.getState().setMachines([{ name: 'trift', id: MACHINE, ssh: 'ada@trift', platform: 'linux-x64' }]);
    store.getState().toggleHost(true, 'trift');
    store.getState().hostStarted('doctor', { name: 'trift' });
    store.getState().hostStep('doctor', { step: 'release', status: 'ok', detail: '0.21.0' });
    store.getState().hostStep('doctor', { step: 'versions', status: 'warn', detail: 'claude 1.2.3 there, behind 1.2.4 on this Mac', run: 'claude update' });
    store.getState().hostDone('doctor', 1);
  });
  await act(async () => { fireEvent.click(screen.getByTestId('host-update-versions')); });
  fireEvent.click(screen.getByTestId('host-fine'));
  expect(screen.getByTestId('host-updating-versions').textContent).toBe('updating on trift…');

  act(() => { store.getState().hostStarted('upgrade', { name: 'trift' }); });
  await act(async () => finish());
  expect(store.getState().host?.op).toBe('upgrade');
  expect(sent.filter((m) => m.type === 'host.start')).toEqual([]);
});
