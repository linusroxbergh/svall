// @vitest-environment jsdom
import './setup.js';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, expect, test, vi } from 'vitest';
import type { FleetEntry } from '@svall/protocol';
import type { ToShell } from '../../src/bridge.js';
import { setAppStore } from '../../src/hooks.js';
import { createAppStore, type AppStore } from '../../src/store/index.js';
import { fleet } from '../fixtures.js';

const FLEETS: FleetEntry[] = [
  { home: '/u/.svall', name: 'home', current: true, running: true, windowOpen: true },
  { home: '/u/.svall-work', name: 'work', current: false, running: true, windowOpen: true },
  { home: '/u/.svall-side', name: 'side', current: false, running: false, windowOpen: false },
];
let startFails: string | undefined;
const call = vi.fn(async (method: string, params?: { home?: string; name?: string }) => {
  if (method === 'fleets.list') return { fleets: FLEETS };
  if (method === 'fleets.start') { if (startFails) throw new Error(startFails); return { home: params?.home }; }
  if (method === 'fleets.create') return { home: `/u/.svall-${params?.name}` };
  return {};
});
const sent: ToShell[] = [];
const bridge = { present: true, send: (m: ToShell) => { sent.push(m); }, onMessage: () => () => {} };
let store: AppStore;
vi.mock('../../src/boot.js', () => ({
  app: { get store() { return store; }, bridge, api: () => ({ call }) },
  deps: () => ({ api: { call }, store, bridge }),
}));

const { FleetPicker } = await import('../../src/FleetPicker.js');

beforeEach(() => {
  call.mockClear();
  sent.length = 0;
  startFails = undefined;
  store = createAppStore();
  setAppStore(store);
  store.getState().setFleet(fleet());
  store.getState().setStatus('online');
});

const rows = () => screen.findAllByTestId(/^fleet-row-/);

test('lists each fleet, tags this window\'s and the ones open elsewhere, and says how to open one from a terminal', async () => {
  store.getState().setFleetPicker('menu');
  render(<FleetPicker />);
  expect((await rows()).map((r) => r.textContent)).toEqual(['homethis window', 'workopen', 'side']);
  expect(screen.getByTestId('fleet-picker').textContent).toContain('svall-dev <name>');
});

test('from the menu, a fleet is started and opened and this window stays', async () => {
  store.getState().setFleetPicker('menu');
  render(<FleetPicker />);
  await rows();
  fireEvent.click(screen.getByTestId('fleet-row-side'));
  await waitFor(() => expect(sent).toContainEqual({ type: 'openFleet', home: '/u/.svall-side', quit: false }));
  expect(call).toHaveBeenCalledWith('fleets.start', { home: '/u/.svall-side' });
  expect(store.getState().fleetPicker).toBeUndefined();
});

test('on a bare launch, another fleet takes this window\'s place, and this fleet or Esc keeps it', async () => {
  store.getState().setFleetPicker('bare');
  const { unmount } = render(<FleetPicker />);
  await rows();
  fireEvent.click(screen.getByTestId('fleet-row-work'));
  await waitFor(() => expect(sent).toContainEqual({ type: 'openFleet', home: '/u/.svall-work', quit: true }));
  unmount();
  act(() => store.getState().setFleetPicker('bare'));
  render(<FleetPicker />);
  fireEvent.click((await rows())[0]);
  expect(store.getState().fleetPicker).toBeUndefined();
  act(() => store.getState().setFleetPicker('bare'));
  fireEvent.keyDown((await rows())[0], { key: 'Escape' });
  expect(store.getState().fleetPicker).toBeUndefined();
});

test('a fleet that will not start says why and where its log is, nothing opens, and the rows are listed again', async () => {
  startFails = 'svalld did not start; see /u/.svall-side/svalld.log (no answer on 127.0.0.1:47811)';
  store.getState().setFleetPicker('menu');
  render(<FleetPicker />);
  await rows();
  fireEvent.click(screen.getByTestId('fleet-row-side'));
  expect((await screen.findByTestId('fleet-error-side')).textContent).toBe(startFails);
  expect(sent).toEqual([]);
  expect(store.getState().fleetPicker).toBe('menu');
  await waitFor(() => expect(call.mock.calls.filter(([m]) => m === 'fleets.list')).toHaveLength(2));
});

test('a pick still starting when the picker is dismissed opens nothing, and the picker opens fresh', async () => {
  let started!: () => void;
  call.mockImplementationOnce(async () => ({ fleets: FLEETS }));
  call.mockImplementationOnce(async (_m, p) => { await new Promise<void>((r) => { started = r; }); return { home: p?.home }; });
  store.getState().setFleetPicker('bare');
  render(<FleetPicker />);
  await rows();
  fireEvent.change(screen.getByTestId('fleet-new-name'), { target: { value: 'half' } });
  fireEvent.click(screen.getByTestId('fleet-row-side'));
  fireEvent.keyDown(screen.getByTestId('fleet-row-side'), { key: 'Escape' });
  expect(store.getState().fleetPicker).toBeUndefined();
  await act(async () => { started(); });
  expect(sent).toEqual([]);
  act(() => store.getState().setFleetPicker('bare'));
  await rows();
  expect((screen.getByTestId('fleet-new-name') as HTMLInputElement).value).toBe('');
});

test('a new fleet\'s name is checked as it is typed, then the fleet is made and opened', async () => {
  store.getState().setFleetPicker('menu');
  render(<FleetPicker />);
  await rows();
  const input = screen.getByTestId('fleet-new-name');
  expect(['autocapitalize', 'autocorrect', 'spellcheck', 'autocomplete'].map((a) => input.getAttribute(a))).toEqual(['off', 'off', 'false', 'off']);
  fireEvent.change(input, { target: { value: 'work' } });
  expect(screen.getByTestId('fleet-new-problem').textContent).toBe('another fleet is called work');
  expect((screen.getByTestId('fleet-new-create') as HTMLButtonElement).disabled).toBe(true);
  fireEvent.change(input, { target: { value: 'Lab' } });
  expect(screen.getByTestId('fleet-new-problem').textContent).toMatch(/lowercase/);
  fireEvent.change(input, { target: { value: 'lab' } });
  expect(screen.queryByTestId('fleet-new-problem')).toBeNull();
  fireEvent.keyDown(input, { key: 'Enter' });
  await waitFor(() => expect(sent).toContainEqual({ type: 'openFleet', home: '/u/.svall-lab', quit: false }));
  expect(call).toHaveBeenCalledWith('fleets.create', { name: 'lab' });
});

test('with svalld offline, the fleets cannot be listed or made, and the picker says why', () => {
  store.getState().setStatus('offline');
  store.getState().setFleetPicker('menu');
  render(<FleetPicker />);
  expect(screen.getByTestId('fleet-picker-offline')).toBeTruthy();
  expect((screen.getByTestId('fleet-new-name') as HTMLInputElement).disabled).toBe(true);
  expect(call).not.toHaveBeenCalled();
});
