// @vitest-environment jsdom
import { act, render, screen } from '@testing-library/react';
import { beforeEach, expect, test, vi } from 'vitest';
import type { MachineId } from '@svall/protocol';
import { fleet } from '../fixtures.js';
import { call, freshStore, store } from './harness.js';

vi.mock('../../src/boot.js', async () => (await import('./harness.js')).bootModule());
vi.mock('../../src/TerminalArea.js', () => ({ TerminalArea: () => null }));
// each mount of the Files view, which watches the robot's folder where it runs
const mounts = vi.hoisted(() => [] as string[]);
vi.mock('../../src/ide/FilesArea.js', async () => {
  const { useEffect } = await import('react');
  return { FilesArea: ({ id }: { id: string }) => { useEffect(() => { mounts.push(id); }, [id]); return null; } };
});

const { RobotPanes } = await import('../../src/RobotPanes.js');

const VAULT = '4b7a3c1e-2d5f-4e6a-9b8c-0f1e2d3c4b5a' as MachineId;

beforeEach(() => {
  freshStore();
  const f = fleet();
  f.machines = { [VAULT]: { name: 'linus-vault', reachable: true, since: 0 } };
  store.getState().setFleet(f);
});

test('a robot on a worker offers Files and Changes, and while its machine is unreachable they say so, asking it nothing', () => {
  act(() => store.getState().applyPatch([{ op: 'add', path: '/robots/c0/machine', value: VAULT }]));
  const { unmount } = render(<RobotPanes id="c0" />);
  expect(screen.getByTestId('pane-left-files')).toBeTruthy();
  expect(screen.getByTestId('pane-left-changes')).toBeTruthy();
  unmount();

  act(() => store.getState().applyPatch([{ op: 'replace', path: `/machines/${VAULT}/reachable`, value: false }]));
  act(() => store.getState().setPanes('c0', { left: 'files', right: 'changes' }));
  render(<RobotPanes id="c0" />);
  expect(screen.getByTestId('pane-left-files')).toBeTruthy();
  expect(screen.queryByTestId('files')).toBeNull();
  expect(screen.getAllByTestId('pane-elsewhere').map((e) => e.textContent)).toEqual(['linus-vault is not reachable', 'linus-vault is not reachable']);
  expect(call.mock.calls.map(([m]) => m).filter((m) => /^(fs|repo)\./.test(m))).toEqual([]);
});

test('a move mounts the Files view anew, to watch the folder on the machine the robot runs on now', () => {
  mounts.length = 0;
  act(() => store.getState().setPanes('c0', { left: 'files' }));
  render(<RobotPanes id="c0" />);
  expect(mounts).toEqual(['c0']);
  act(() => store.getState().applyPatch([{ op: 'add', path: '/robots/c0/machine', value: VAULT }]));
  expect(mounts).toEqual(['c0', 'c0']);
});

test('a robot on this Mac keeps its Files and Changes panes', () => {
  render(<RobotPanes id="c0" />);
  expect(screen.getByTestId('pane-left-files')).toBeTruthy();
  expect(screen.getByTestId('pane-left-changes')).toBeTruthy();
});
