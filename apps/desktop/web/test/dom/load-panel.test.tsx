// @vitest-environment jsdom
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import type { LoadRobot, LoadSnapshot, MachineId, Result } from '@svall/protocol';
import { useApp } from '../../src/hooks.js';
import { call, freshStore, store } from './harness.js';

const MB = 2 ** 20;
const use = (cpu: number, mem = 100 * MB, procs = 3) => ({ cpu, mem, procs });
const robot = (cpu: number, extra: Partial<LoadRobot> = {}): LoadRobot => ({ ...use(cpu), shellOnly: false, sleepable: true, ...extra });
const ME = '11111111-1111-4111-8111-111111111111' as MachineId;
const GPU = '22222222-2222-4222-8222-222222222222' as MachineId;
const VAULT = '33333333-3333-4333-8333-333333333333' as MachineId;
const OLD = '44444444-4444-4444-8444-444444444444' as MachineId;
let snap: LoadSnapshot;
// this Mac's reading alone, unless a test gives the fleet's
let fleetLoad: Result<'load.get'> | undefined;
const reading = (): Result<'load.get'> => fleetLoad ?? { machines: [{ machine: ME, load: snap }] };
const answer = (method: string) => Promise.resolve(method === 'load.get' ? reading() : {});
const calls = () => call.mock.calls as [string, Record<string, unknown>][];
const reads = () => calls().filter(([m]) => m === 'load.get').length;
vi.mock('../../src/boot.js', async () => (await import('./harness.js')).bootModule());

const { LoadPanel } = await import('../../src/LoadPanel.js');
const { ConfirmSleep } = await import('../../src/Confirm.js');
const { useLoad } = await import('../../src/load.js');

beforeEach(() => {
  call.mockImplementation(answer);
  freshStore();
  fleetLoad = undefined;
  snap = { at: 0, cores: 8, total: use(61, 900 * MB, 14), app: use(30, 500 * MB, 5), robots: { c0: robot(5), c1: robot(20), c2: robot(1, { shellOnly: true }) } };
});

afterEach(() => { vi.useRealTimers(); });

const shown = async () => { render(<><LoadPanel /><ConfirmSleep /></>); await screen.findByTestId('load-app'); };
const row = (id: string) => screen.getByTestId(`load-row-${id}`);

test('the robots come by cpu and Svall itself last, a robot running only its shell left out', async () => {
  snap.codex = use(10);
  await shown();
  const order = screen.getAllByTestId(/^load-(app|codex|row-)/).map((el) => el.dataset.testid);
  expect(order).toEqual(['load-row-c1', 'load-codex', 'load-row-c0', 'load-app']);
  expect(screen.getByTestId('load-app').textContent).toContain('Svall itself');
  expect(screen.getByTestId('load-total-cpu').textContent).toBe('0.61 of 8 cores');
  expect(screen.getByTestId('load-robots').textContent).toBe('Robots 3');
  expect(screen.getByTestId('load-codex').textContent).toContain('Codex server (shared)');
  // the shared server is no robot's to end
  expect(within(screen.getByTestId('load-codex')).queryAllByRole('button')).toEqual([]);
});

test('an asleep robot still running a process can only be deleted, and so can one svalld cannot resume', async () => {
  snap.robots.c2 = robot(1, { sleepable: false });
  store.getState().applyPatch([{ op: 'remove', path: '/robots/c0/tmux' }]);
  await shown();
  expect(row('c0').textContent).toContain('asleep');
  expect(screen.queryByTestId('load-sleep-c0')).toBeNull();
  expect(screen.getByTestId('load-delete-c0')).toBeTruthy();
  expect(row('c1').textContent).not.toContain('asleep');
  expect(screen.getByTestId('load-sleep-c1')).toBeTruthy();
  expect(screen.queryByTestId('load-sleep-c2')).toBeNull();
  expect(screen.getByTestId('load-delete-c2')).toBeTruthy();
});

test('Sleep puts an idle robot to sleep at once, and asks first of a working one', async () => {
  store.getState().applyPatch([{ op: 'add', path: '/robots/c1/agent', value: { kind: 'claude', sessionId: 's', status: 'working', lastActivityAt: 1, transcriptPath: '/t' } }]);
  await shown();
  fireEvent.click(screen.getByTestId('load-sleep-c0'));
  expect(calls()).toContainEqual(['robot.sleep', { id: 'c0' }]);

  fireEvent.click(screen.getByTestId('load-sleep-c1'));
  expect(calls()).not.toContainEqual(['robot.sleep', { id: 'c1' }]);
  expect(store.getState().sleepingRobot).toBe('c1');
  expect(screen.getByText('c1 is working. Sleep anyway?')).toBeTruthy();
  // a reflex Enter keeps it
  expect(document.activeElement).toBe(screen.getByTestId('confirm-sleep-cancel'));
  fireEvent.click(screen.getByTestId('confirm-sleep-sleep'), { detail: 1 });
  expect(calls()).toContainEqual(['robot.sleep', { id: 'c1' }]);
  expect(store.getState().sleepingRobot).toBeUndefined();
});

test('Sleep asks first of a robot mid-turn in either terminal, a blocked one included', async () => {
  const agent = (status: string) => ({ kind: 'claude', sessionId: 's', status, lastActivityAt: 1, transcriptPath: '/t' });
  store.getState().applyPatch([
    { op: 'add', path: '/robots/c1/agent', value: agent('blocked') },
    { op: 'add', path: '/robots/c0/agent', value: agent('blocked') },
    { op: 'add', path: '/robots/c0/second', value: { tmux: { windowId: '@9', paneId: '%9' }, unread: false, agent: agent('working') } },
  ]);
  await shown();
  fireEvent.click(screen.getByTestId('load-sleep-c1'));
  expect(store.getState().sleepingRobot).toBe('c1');
  act(() => store.getState().setSleepingRobot(undefined));
  fireEvent.click(screen.getByTestId('load-sleep-c0'));
  expect(store.getState().sleepingRobot).toBe('c0');
  expect(screen.getByText('c0 is working. Sleep anyway?')).toBeTruthy();
  expect(calls().filter(([m]) => m === 'robot.sleep')).toEqual([]);
});

test('Delete asks as the side card\'s does, and the name opens the robot and puts the panel away', async () => {
  store.getState().toggleLoad(true);
  await shown();
  fireEvent.click(screen.getByTestId('load-delete-c1'));
  expect(store.getState().closingRobot).toBe('c1');
  act(() => store.getState().setClosingRobot(undefined));
  fireEvent.click(within(row('c0')).getByText('c0'));
  expect(store.getState()).toMatchObject({ card: 'c0', focusedId: 'c0', loadOpen: false });
});

test('a read waits on the one before it, however slow its reply', async () => {
  vi.useFakeTimers();
  let reply!: () => void;
  call.mockImplementation((method: string) => new Promise((resolve) => { reply = () => resolve(method === 'load.get' ? reading() : {}); }));
  render(<LoadPanel />);
  await act(() => vi.advanceTimersByTimeAsync(9000));
  expect(reads()).toBe(1);
  await act(async () => { reply(); await vi.advanceTimersByTimeAsync(4000); });
  expect(reads()).toBe(2);
});

test('a reading from before a pause is never shown once reading starts again', async () => {
  function Probe() {
    const at = useLoad(useApp((s) => s.active)).load?.machines[0].load?.at;
    return <i data-testid="probe">{at ?? 'none'}</i>;
  }
  snap.at = 7;
  render(<Probe />);
  await screen.findByText('7');
  call.mockImplementation(() => new Promise(() => {}));
  act(() => store.getState().setActive(false));
  act(() => store.getState().setActive(true));
  expect(screen.getByTestId('probe').textContent).toBe('none');
});

test('a daemon that cannot read the load says so, and a read that fails later keeps the last reading beside it', async () => {
  vi.useFakeTimers();
  call.mockImplementation(() => Promise.reject(new Error('ps: not found')));
  render(<LoadPanel />);
  await act(async () => {});
  expect(screen.getByTestId('load-error').textContent).toBe('ps: not found');
  expect(screen.queryByTestId('load-app')).toBeNull();

  call.mockImplementation(answer);
  await act(() => vi.advanceTimersByTimeAsync(4000));
  expect(screen.queryByTestId('load-error')).toBeNull();
  expect(screen.getByTestId('load-app')).toBeTruthy();

  call.mockImplementation(() => Promise.reject(new Error('ps: not found')));
  await act(() => vi.advanceTimersByTimeAsync(4000));
  expect(screen.getByTestId('load-error').textContent).toBe('ps: not found');
  expect(screen.getByTestId('load-app')).toBeTruthy();
});

test('each machine has a column of its own, named, with the robots it runs, and one that gave no reading says why', async () => {
  const f = store.getState().fleet;
  store.getState().setShell({ home: '/Users/ada/.svall', log: [], op: false, machine: ME });
  store.getState().setFleet({ ...f, machines: { [GPU]: { name: 'gpu-box', reachable: true, since: 0 }, [VAULT]: { name: 'vault', reachable: false, since: 0 }, [OLD]: { name: 'old', reachable: false, since: 0, mismatch: true } } });
  fleetLoad = { machines: [
    { machine: ME, load: { ...snap, robots: { c0: robot(5) } } },
    { machine: GPU, load: { ...snap, cores: 32, robots: { c1: robot(20) } } },
    { machine: VAULT },
    { machine: OLD },
  ] };
  render(<LoadPanel />);
  const col = async (id: MachineId) => within(await screen.findByTestId(`load-machine-${id}`));
  expect((await col(ME)).getByText('This Mac')).toBeTruthy();
  expect((await col(ME)).getByTestId('load-row-c0')).toBeTruthy();
  expect((await col(ME)).queryByTestId('load-row-c1')).toBeNull();
  expect((await col(GPU)).getByText('gpu-box')).toBeTruthy();
  expect((await col(GPU)).getByTestId('load-row-c1')).toBeTruthy();
  expect((await col(GPU)).getByTestId('load-total-cpu').textContent).toBe('0.61 of 32 cores');
  expect((await col(VAULT)).getByText('vault')).toBeTruthy();
  expect((await col(VAULT)).getByText('Out of reach')).toBeTruthy();
  expect((await col(OLD)).getByText('Runs a different build; upgrade it under Machines')).toBeTruthy();
});

test('a lone machine goes unnamed', async () => {
  await shown();
  expect(screen.queryByText('This Mac')).toBeNull();
});
