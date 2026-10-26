// @vitest-environment jsdom
import { act, render, screen } from '@testing-library/react';
import { beforeEach, expect, test, vi } from 'vitest';
import type { MachineId } from '@svall/protocol';
import { fleet } from '../fixtures.js';
import { call, freshStore, store } from './harness.js';

vi.mock('../../src/boot.js', async () => (await import('./harness.js')).bootModule());
vi.mock('../../src/TerminalArea.js', () => ({ TerminalArea: () => null }));

const { RobotPanes } = await import('../../src/RobotPanes.js');

const VAULT = '4b7a3c1e-2d5f-4e6a-9b8c-0f1e2d3c4b5a' as MachineId;

beforeEach(() => {
  freshStore();
  const f = fleet();
  f.machines = { [VAULT]: { name: 'linus-vault', reachable: true, since: 0 } };
  store.getState().setFleet(f);
});

test("a robot on a worker offers no Files or Changes pane, and one open from before says its files are there, reading nothing of this Mac's disk", () => {
  act(() => store.getState().applyPatch([{ op: 'add', path: '/robots/c0/machine', value: VAULT }]));
  act(() => store.getState().setPanes('c0', { left: 'files', right: 'changes' }));
  render(<RobotPanes id="c0" />);
  expect(screen.queryByTestId('pane-left-files')).toBeNull();
  expect(screen.queryByTestId('pane-left-changes')).toBeNull();
  expect(screen.getByTestId('pane-left-terminal')).toBeTruthy();
  expect(screen.queryByTestId('files')).toBeNull();
  expect(screen.getAllByTestId('pane-elsewhere').map((e) => e.textContent)).toEqual(["Its files are on linus-vault", "Its files are on linus-vault"]);
  expect(call.mock.calls.map(([m]) => m).filter((m) => /^(fs|repo)\./.test(m))).toEqual([]);
});

test('a robot on this Mac keeps its Files and Changes panes', () => {
  render(<RobotPanes id="c0" />);
  expect(screen.getByTestId('pane-left-files')).toBeTruthy();
  expect(screen.getByTestId('pane-left-changes')).toBeTruthy();
});
