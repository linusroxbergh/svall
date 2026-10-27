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
test('every step that failed offers a way on: what the step said to do, or the run again', () => {
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
  sent.length = 0;
  fireEvent.click(screen.getByTestId('host-again-tmux'));
  expect(sent).toEqual([{ type: 'host.start', op: 'doctor', args: { name: 'trift' } }]);
});

test('a run ends in one line, with Done once nothing is left and Check again while something is', () => {
  render(<HostSetup />);
  act(() => {
    store.getState().setMachines([{ name: 'trift', id: 'm1', ssh: 'ada@trift', platform: 'linux-x64' }]);
    store.getState().toggleHost(true, 'trift');
    store.getState().hostStarted('upgrade', { name: 'trift' });
    store.getState().hostStep('upgrade', { step: 'probe', status: 'ok', detail: 'trift answers on release 1.2.3' });
    store.getState().hostDone('upgrade', 0);
  });
  expect(screen.getByTestId('host-outcome').textContent).toBe('trift is ready. Robots you move there keep working while this Mac sleeps.Done');
  expect(screen.queryByTestId('machine-enable')).toBeNull();
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
  expect(screen.getByTestId('host-outcome').textContent).toBe('trift needs 2 things before robots can move there.Check again');
  expect(screen.queryByTestId('host-done')).toBeNull();
  sent.length = 0;
  fireEvent.click(screen.getByTestId('host-check-again'));
  expect(sent).toEqual([{ type: 'host.start', op: 'doctor', args: { name: 'trift' } }]);
});

const MACHINE = '5d4d0b1c-2d3e-4f50-8617-9a0b1c2d3e4f';
const tick = (on: boolean) => ({ item: 'claude:mcp:linear', fields: ['env.LINEAR_API_KEY'], on, preview: ['env.LINEAR_API_KEY lin…90'] });
const unticked = {
  step: 'mirror:claude:mcp:linear', status: 'warn' as const, action: "copy linear's keys to trift", tick: tick(false),
  detail: 'mirrored without env.LINEAR_API_KEY lin…90; or set them in ~/.svall/mirror-overrides on trift',
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
  expect(screen.getByTestId('host-outcome').textContent).toBe('trift needs 1 thing before robots can move there.Check again');
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

test('ticking the last key of an add that exited 1 for it reads ready, with Done', async () => {
  call.mockImplementation(async (method: string) => (method === 'machines.consent'
    ? { rows: [{ key: 'claude:mcp:linear', status: 'ok', detail: 'keys copied to trift: env.LINEAR_API_KEY lin…90', tick: tick(true) }] } : {}));
  render(<HostSetup />);
  act(() => {
    store.getState().setMachines([{ name: 'trift', id: MACHINE, ssh: 'ada@trift', platform: 'linux-x64' }]);
    store.getState().toggleHost(true, 'trift');
    store.getState().hostStarted('add', { name: 'trift', ssh: 'ada@trift' });
    store.getState().hostStep('add', { step: 'ssh', status: 'ok', detail: 'ada@trift accepted an interactive login' });
    store.getState().hostStep('add', { step: 'registry', status: 'ok', detail: 'trift is in this Mac\'s list of machines' });
    store.getState().hostStep('add', unticked);
    store.getState().hostDone('add', 1);
  });
  expect(screen.getByTestId('host-outcome').textContent).toBe('trift needs 1 thing before robots can move there.Check again');
  await act(async () => { fireEvent.click(screen.getByTestId('host-tick-mirror:claude:mcp:linear')); });
  expect(screen.getByTestId('host-outcome').textContent).toBe('trift is ready. Robots you move there keep working while this Mac sleeps.Done');
});

test('a machine not yet in the list has its rows shown but nothing ticked, and the sheet keeps its title and outcome out of the scrolling rows', () => {
  checked([]);
  const box = screen.getByTestId('host-tick-mirror:claude:mcp:linear') as HTMLInputElement;
  expect([box.disabled, box.title]).toEqual([true, 'listed once the machine is added']);
  const body = document.querySelector('.host-body')!;
  expect(body.contains(screen.getByTestId('host-steps'))).toBe(true);
  expect(body.contains(screen.getByTestId('host-machine'))).toBe(false);
  expect(body.contains(screen.getByTestId('host-outcome'))).toBe(false);
  expect(screen.getByTestId('host-outcome').classList).toContain('host-foot');
});
