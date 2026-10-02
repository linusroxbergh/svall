// @vitest-environment jsdom
import './setup.js';
import { act, fireEvent, render, screen } from '@testing-library/react';
import type { PushStatus } from '@svall/protocol';
import { beforeEach, expect, test, vi } from 'vitest';
import { setAppStore } from '../../src/hooks.js';
import type { PushState } from '../../src/mobile/push.js';
import { createAppStore, type AppStore } from '../../src/store/index.js';
import { fleet } from '../fixtures.js';

const calls: [string, Record<string, unknown>][] = [];
let refuse: string | undefined;
const call = (method: string, params: Record<string, unknown>) => {
  calls.push([method, params]);
  if (method === 'resources.get') return Promise.resolve({ sources: [] });
  return refuse ? Promise.reject(new Error(refuse)) : Promise.resolve({});
};
const api = { call };
let store: AppStore;
vi.mock('../../src/mobile/boot.js', () => ({ phone: { api: () => api, get store() { return store; } } }));

const push = vi.hoisted(() => ({
  readPush: vi.fn<() => Promise<PushState>>(),
  enablePush: vi.fn<(a: unknown, key: string) => Promise<PushState>>(),
  setPushStatuses: vi.fn<(a: unknown, s: PushStatus[]) => Promise<PushState>>(),
  disablePush: vi.fn<() => Promise<PushState>>(),
}));
vi.mock('../../src/mobile/push.js', () => push);

const { Settings } = await import('../../src/mobile/Settings.js');
const { IslandSheet } = await import('../../src/mobile/IslandSheet.js');
const { CloseCharacter } = await import('../../src/mobile/CloseCharacter.js');
const { NewIsland } = await import('../../src/mobile/NewIsland.js');

beforeEach(() => {
  calls.length = 0;
  refuse = undefined;
  for (const f of Object.values(push)) f.mockReset();
  store = createAppStore();
  setAppStore(store);
  store.getState().setFleet(fleet());
});

const settings = async (state: PushState) => {
  push.readPush.mockResolvedValue(state);
  await act(async () => { render(<Settings onClose={() => {}} />); });
};

test('a phone not notified is offered it, with the key read when the sheet opened', async () => {
  push.enablePush.mockResolvedValue({ kind: 'on', endpoint: 'e', statuses: ['blocked', 'done'] });
  await settings({ kind: 'off', publicKey: 'K' });
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Notify this phone' })); });
  expect(push.enablePush).toHaveBeenCalledWith(api, 'K');
  expect(screen.getByRole('button', { name: 'Stop notifying this phone' })).toBeTruthy();
});

test('a phone notified chooses which turns it hears about', async () => {
  push.setPushStatuses.mockResolvedValue({ kind: 'on', endpoint: 'e', statuses: ['blocked', 'done'] });
  await settings({ kind: 'on', endpoint: 'e', statuses: ['blocked'] });
  expect((screen.getByLabelText('when an agent needs you') as HTMLInputElement).checked).toBe(true);
  expect((screen.getByLabelText('when an agent finishes') as HTMLInputElement).checked).toBe(false);
  await act(async () => { fireEvent.click(screen.getByLabelText('when an agent finishes')); });
  expect(push.setPushStatuses).toHaveBeenCalledWith(api, ['blocked', 'done']);
});

test('a phone that cannot be notified from here is told what would do it', async () => {
  await settings({ kind: 'install' });
  expect(screen.getByText(/Add to Home Screen/)).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Notify this phone' })).toBeNull();
});

test('a sheet opened while svalld is away reads again once it is back', async () => {
  push.readPush.mockRejectedValueOnce(new Error('svalld offline'));
  await settings({ kind: 'off', publicKey: 'K' });
  expect(screen.getByText('svalld offline')).toBeTruthy();
  await act(async () => { store.getState().setStatus('online'); });
  expect(screen.queryByText('svalld offline')).toBeNull();
  expect(screen.getByRole('button', { name: 'Notify this phone' })).toBeTruthy();
});

test('a refusal to notify is told in the sheet', async () => {
  push.enablePush.mockRejectedValue(new Error('permission refused'));
  await settings({ kind: 'off', publicKey: 'K' });
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Notify this phone' })); });
  expect(screen.getByText('permission refused')).toBeTruthy();
});

test('an island with crew on it is not deleted until they move', async () => {
  await act(async () => { render(<IslandSheet islandId="i_b" onClose={() => {}} onNewCharacter={() => {}} />); });
  expect(screen.getByText('Move its crew away before deleting it.')).toBeTruthy();
  expect((screen.getByRole('button', { name: 'Delete island' }) as HTMLButtonElement).disabled).toBe(true);
});

test('an empty island is deleted on a second tap', async () => {
  const onClose = vi.fn();
  await act(async () => { render(<IslandSheet islandId="i_e" onClose={onClose} onNewCharacter={() => {}} />); });
  fireEvent.click(screen.getByRole('button', { name: 'Delete island' }));
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Delete empty and its docs?' })); });
  expect(calls.filter(([m]) => m === 'island.delete')).toEqual([['island.delete', { id: 'i_e' }]]);
  expect(onClose).toHaveBeenCalled();
});

test('mission control is never offered for deleting', async () => {
  await act(async () => { render(<IslandSheet islandId="home" onClose={() => {}} onNewCharacter={() => {}} />); });
  expect(screen.queryByRole('button', { name: 'Delete island' })).toBeNull();
});

test('closing a character from the list says what goes with it, and closes it', async () => {
  const onClose = vi.fn();
  render(<CloseCharacter id="c0" onClose={onClose} />);
  expect(screen.getByText('Closing kills its terminal and deletes its docs.')).toBeTruthy();
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Close c0' })); });
  expect(calls).toEqual([['char.close', { id: 'c0' }]]);
  expect(onClose).toHaveBeenCalled();
});

test('a close the fleet refuses is told beside the button, which works again', async () => {
  refuse = 'svalld offline';
  const onClose = vi.fn();
  render(<CloseCharacter id="c0" onClose={onClose} />);
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Close c0' })); });
  expect(screen.getByText('svalld offline')).toBeTruthy();
  expect(onClose).not.toHaveBeenCalled();
  expect((screen.getByRole('button', { name: 'Close c0' }) as HTMLButtonElement).disabled).toBe(false);
});

test('a new island takes the name typed, trimmed', async () => {
  const onClose = vi.fn();
  render(<NewIsland onClose={onClose} />);
  expect((screen.getByRole('button', { name: 'Create' }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.change(screen.getByLabelText('Name'), { target: { value: '  reviews ' } });
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Create' })); });
  expect(calls).toEqual([['island.create', { name: 'reviews' }]]);
  expect(onClose).toHaveBeenCalled();
});

test('a new island the fleet refuses keeps the sheet up with the reason', async () => {
  refuse = 'an island named reviews exists';
  const onClose = vi.fn();
  render(<NewIsland onClose={onClose} />);
  fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'reviews' } });
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Create' })); });
  expect(screen.getByText('an island named reviews exists')).toBeTruthy();
  expect(onClose).not.toHaveBeenCalled();
});
