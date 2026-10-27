// @vitest-environment jsdom
import { act, render, screen } from '@testing-library/react';
import { beforeEach, expect, test, vi } from 'vitest';
import type { MachineId } from '@svall/protocol';
import { fleet } from '../fixtures.js';
import { freshStore, store } from './harness.js';

vi.mock('../../src/boot.js', async () => (await import('./harness.js')).bootModule());

const { Sidebar } = await import('../../src/Sidebar.js');

const VAULT = '4b7a3c1e-2d5f-4e6a-9b8c-0f1e2d3c4b5a' as MachineId;

beforeEach(() => {
  freshStore();
  const f = fleet();
  f.machines = { [VAULT]: { name: 'linus-vault', reachable: true, since: 0 } };
  f.robots.c0.machine = VAULT;
  f.robots.c0.star = 0;
  store.getState().setFleet(f);
  render(<Sidebar />);
});

test('a robot on a worker names its machine under its name, in the tree and in Starred', () => {
  expect(screen.getAllByTestId('sb-machine-c0').map((e) => e.textContent)).toEqual(['on linus-vault', 'on linus-vault']);
  expect(screen.getByTestId('sb-robot-c0').contains(screen.getAllByTestId('sb-machine-c0')[1])).toBe(true);
  expect(screen.queryByTestId('sb-machine-c1')).toBeNull();
  act(() => store.getState().applyPatch([{ op: 'remove', path: '/robots/c0/machine' }]));
  expect(screen.queryByTestId('sb-machine-c0')).toBeNull();
});
