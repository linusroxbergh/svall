// @vitest-environment jsdom
import './setup.js';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, expect, test, vi } from 'vitest';
import type { MachineId } from '@svall/protocol';
import { setAppStore } from '../../src/hooks.js';
import { createAppStore, type AppStore } from '../../src/store/index.js';
import { readDraft } from '../../src/mobile/draft.js';
import { fleet } from '../fixtures.js';

const calls: [string, Record<string, unknown>][] = [];
let runSent: boolean | undefined;
const call = (method: string, params: Record<string, unknown>) => {
  calls.push([method, params]);
  if (method === 'robot.create') return Promise.resolve({ id: 'n1', runSent });
  return Promise.resolve({});
};
let store: AppStore;
vi.mock('../../src/mobile/boot.js', () => ({ phone: { api: () => ({ call, fire: call }), get store() { return store; } } }));
const { MissionBar } = await import('../../src/mobile/MissionBar.js');
const { IslandSheet } = await import('../../src/mobile/IslandSheet.js');

beforeEach(() => {
  calls.length = 0;
  runSent = undefined;
  sessionStorage.clear();
  store = createAppStore();
  setAppStore(store);
  store.getState().setFleet(fleet());
  store.getState().setStatus('online');
});

test('a prompt typed under the fleet starts a home robot and opens it', async () => {
  const onOpen = vi.fn();
  render(<MissionBar onOpen={onOpen} />);
  const field = screen.getByLabelText('Mission control') as HTMLTextAreaElement;
  fireEvent.change(field, { target: { value: 'plan the day' } });
  await act(async () => { fireEvent.submit(field.closest('form')!); });
  expect(calls).toEqual([['robot.create', { islandId: 'home', cwd: '/mc', command: fleet().home.command, run: 'plan the day' }]]);
  expect(onOpen).toHaveBeenCalledWith('n1');
  expect(field.value).toBe('');
  expect(readDraft('n1')).toBe('');
});

test('a worker standing in for the Mac offers no mission control', () => {
  store.getState().setVia({ machine: '4b7a3c1e-2d5f-4e6a-9b8c-0f1e2d3c4b5a' as MachineId, home: '0c1d2e3f-4a5b-4c6d-8e7f-9a0b1c2d3e4f' as MachineId });
  render(<MissionBar onOpen={() => {}} />);
  expect(screen.queryByRole('textbox', { name: 'Mission control' })).toBeNull();
});

test('a prompt the new robot did not take waits in its composer', async () => {
  runSent = false;
  const onOpen = vi.fn();
  render(<MissionBar onOpen={onOpen} />);
  const field = screen.getByLabelText('Mission control');
  fireEvent.change(field, { target: { value: 'plan the day' } });
  await act(async () => { fireEvent.submit(field.closest('form')!); });
  expect(onOpen).toHaveBeenCalledWith('n1');
  expect(readDraft('n1')).toBe('plan the day');
});

test("the home island's sheet carries its buttons, and one starts the skill", async () => {
  const onOpen = vi.fn();
  render(<IslandSheet islandId="home" onClose={() => {}} onNewRobot={() => {}} onOpen={onOpen} />);
  expect(screen.getAllByRole('button', { name: /^(update info|status|retro)$/ })).toHaveLength(3);
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'retro' })); });
  expect(calls.find(([m]) => m === 'robot.create')).toEqual(['robot.create', { islandId: 'home', cwd: '/mc', command: fleet().home.command, name: 'retro', run: '/svall-retro' }]);
  expect(onOpen).toHaveBeenCalledWith('n1');
});
