// @vitest-environment jsdom
import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, expect, test, vi } from 'vitest';
import type { MachineId } from '@svall/protocol';
import { chr, fleet } from '../fixtures.js';
import { freshStore, store } from './harness.js';

vi.mock('../../src/boot.js', async () => (await import('./harness.js')).bootModule());

const { MachineActions } = await import('../../src/HostSetup.js');

const VAULT = '4b7a3c1e-2d5f-4e6a-9b8c-0f1e2d3c4b5a' as MachineId;

function setup(reachable: boolean | undefined, placed: number) {
  freshStore();
  const f = fleet();
  if (reachable !== undefined) f.machines = { [VAULT]: { name: 'vault', reachable, since: 0 } };
  for (let i = 0; i < placed; i++) f.robots[`c${i}`] = chr(`c${i}`, 'i_b', { x: 1, y: 1 }, { name: `r${i}`, machine: VAULT });
  store.getState().setFleet(f);
  act(() => store.getState().setMachines([{ name: 'vault', id: VAULT, ssh: 'ada@vault', platform: 'linux-x64' }]));
  render(<MachineActions name="vault" />);
}
const more = () => screen.getByTestId('machine-more');
// as a key press reaches the page: at what has focus, through the window's capture and back up to it
const key = (k: string) => act(() => { (document.activeElement ?? document.body).dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true })); });

beforeEach(() => document.body.replaceChildren());

test('opening the menu focuses its first item; arrows step; Escape and an outside press close it, Escape returning focus to the button', () => {
  setup(undefined, 0);
  fireEvent.click(more());
  expect(document.activeElement).toBe(screen.getByTestId('machine-upgrade'));
  key('ArrowDown');
  expect(document.activeElement).toBe(screen.getByTestId('machine-terminal'));
  key('ArrowUp'); key('ArrowUp');
  expect(document.activeElement).toBe(screen.getByTestId('machine-forget'));
  const outer = vi.fn();
  window.addEventListener('keydown', outer);
  key('Escape');
  window.removeEventListener('keydown', outer);
  expect(outer).not.toHaveBeenCalled();
  expect(screen.queryByTestId('machine-upgrade')).toBeNull();
  expect(document.activeElement).toBe(more());
  fireEvent.click(more());
  fireEvent.pointerDown(document.body);
  expect(screen.queryByTestId('machine-upgrade')).toBeNull();
  fireEvent.click(more());
  key('Tab');
  expect(screen.queryByTestId('machine-upgrade')).toBeNull();
});

test('Remove names how many robots hold it back; Forget is offered only for a machine that is not reachable', () => {
  setup(undefined, 1);
  fireEvent.click(more());
  expect((screen.getByTestId('machine-remove') as HTMLButtonElement).disabled).toBe(true);
  expect(screen.getByTestId('machine-remove').title).toBe('1 robot is placed there; move it back first');
  expect(screen.getByTestId('machine-forget')).toBeTruthy();
});

test('several robots, and a reachable machine', () => {
  setup(true, 2);
  fireEvent.click(more());
  expect(screen.getByTestId('machine-remove').title).toBe('2 robots are placed there; move them back first');
  expect(screen.queryByTestId('machine-forget')).toBeNull();
});
