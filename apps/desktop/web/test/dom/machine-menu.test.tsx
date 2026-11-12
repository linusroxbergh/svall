// @vitest-environment jsdom
import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, expect, test, vi } from 'vitest';
import type { MachineId } from '@svall/protocol';
import { chr, fleet } from '../fixtures.js';
import { freshStore, store } from './harness.js';

vi.mock('../../src/boot.js', async () => (await import('./harness.js')).bootModule());

const { MachineActions } = await import('../../src/HostSetup.js');

const VAULT = '4b7a3c1e-2d5f-4e6a-9b8c-0f1e2d3c4b5a' as MachineId;

function setup(reachable: boolean | undefined, placed: number, mismatch?: true, role: { home?: boolean; worker?: boolean } = {}) {
  freshStore();
  const f = fleet();
  if (reachable !== undefined) f.machines = { [VAULT]: { name: 'vault', reachable, since: 0, mismatch } };
  for (let i = 0; i < placed; i++) f.robots[`c${i}`] = chr(`c${i}`, 'i_b', { x: 1, y: 1 }, { name: `r${i}`, machine: VAULT });
  store.getState().setFleet(f);
  act(() => store.getState().setMachines([{ name: 'vault', id: VAULT, ssh: 'ada@vault', platform: 'linux-x64' }]));
  render(<MachineActions name="vault" {...role} />);
}
const more = () => screen.getByTestId('machine-more');
// as a key press reaches the page: at what has focus, through the window's capture and back up to it
const key = (k: string) => act(() => { (document.activeElement ?? document.body).dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true })); });

beforeEach(() => document.body.replaceChildren());

test('opening the menu focuses its first item; arrows step; Escape and an outside press close it, Escape returning focus to the button', () => {
  setup(undefined, 0);
  fireEvent.click(more());
  expect(screen.getByTestId('machine-terminal').textContent).toBe('Open terminal');
  // what takes the machine away stands apart
  expect(screen.getByTestId('machine-remove').previousElementSibling!.getAttribute('role')).toBe('separator');
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

test('Remove is held back while a fleet on this account dials the machine as its home, and says what clears it', () => {
  setup(undefined, 0);
  act(() => store.getState().setMachines(store.getState().machines!.map((m) => ({ ...m, dialedBy: '/Users/ada/.svall-fartest' }))));
  fireEvent.click(more());
  expect((screen.getByTestId('machine-remove') as HTMLButtonElement).disabled).toBe(true);
  expect(screen.getByTestId('machine-remove').getAttribute('data-tip')).toBe('It is the home of another fleet on this Mac; bring that fleet back first.');
});

test('Forget says why it is held back too, what clears it, and an unreadable worker.json reads apart', () => {
  setup(undefined, 0);
  act(() => store.getState().setMachines(store.getState().machines!.map((m) => ({ ...m, dialedBy: '/Users/ada/.svall-fartest' }))));
  fireEvent.click(more());
  const forget = () => screen.getByTestId('machine-forget') as HTMLButtonElement;
  expect(forget().disabled).toBe(true);
  expect(forget().getAttribute('data-tip')).toBe('It is the home of another fleet on this Mac; bring that fleet back first.');
  act(() => store.getState().setMachines(store.getState().machines!.map(({ dialedBy: _d, ...m }) => ({ ...m, unreadWorker: '/Users/ada/.svall-x/worker.json' }))));
  expect(forget().disabled).toBe(true);
  for (const b of [forget(), screen.getByTestId('machine-remove')]) {
    expect(b.getAttribute('data-tip')).toBe('Cannot read /Users/ada/.svall-x/worker.json, which may name this machine; fix it');
  }
});

test('Remove names how many robots hold it back; Forget is offered only for a machine that does not answer', () => {
  setup(undefined, 1);
  fireEvent.click(more());
  expect((screen.getByTestId('machine-remove') as HTMLButtonElement).disabled).toBe(true);
  expect(screen.getByTestId('machine-remove').getAttribute('data-tip')).toBe('1 robot is placed there; move it back first');
  expect(screen.getByTestId('machine-forget')).toBeTruthy();
});

test('several robots, and a reachable machine', () => {
  setup(true, 2);
  fireEvent.click(more());
  expect(screen.getByTestId('machine-remove').getAttribute('data-tip')).toBe('2 robots are placed there; move them back first');
  expect(screen.queryByTestId('machine-forget')).toBeNull();
});

test('a machine that is down is offered Forget', () => {
  setup(false, 0);
  fireEvent.click(more());
  expect(screen.getByTestId('machine-forget')).toBeTruthy();
});

test('a machine on another build answers, so it is not offered Forget', () => {
  setup(false, 0, true);
  fireEvent.click(more());
  expect(screen.getByTestId('machine-remove')).toBeTruthy();
  expect(screen.queryByTestId('machine-forget')).toBeNull();
});

test('a worker its Mac home dials offers to become the home; a machine that is no such worker does not', () => {
  setup(true, 0, undefined, { worker: true });
  fireEvent.click(more());
  expect(screen.getByTestId('machine-make-home').textContent).toBe("Make vault this fleet's home…");
  fireEvent.click(screen.getByTestId('machine-make-home'));
  expect(store.getState().homeSheet).toEqual({ to: VAULT, name: 'vault', back: false });
  document.body.replaceChildren();
  setup(true, 0);
  fireEvent.click(more());
  expect(screen.queryByTestId('machine-make-home')).toBeNull();
  expect(screen.queryByTestId('machine-bring-back')).toBeNull();
});

test('the far home offers to bring the fleet back, keeps Check, Upgrade and its terminal, and has no Remove or Forget', () => {
  setup(false, 0, undefined, { home: true });
  fireEvent.click(more());
  expect(screen.getByTestId('machine-upgrade')).toBeTruthy();
  expect(screen.getByTestId('machine-terminal')).toBeTruthy();
  expect(screen.queryByTestId('machine-remove')).toBeNull();
  expect(screen.queryByTestId('machine-forget')).toBeNull();
  fireEvent.click(screen.getByTestId('machine-bring-back'));
  expect(store.getState().homeSheet).toEqual({ to: VAULT, name: 'vault', back: true });
});

test('Open terminal is off for a machine this Mac has no ssh route to, and says so', () => {
  freshStore();
  store.getState().setFleet(fleet());
  act(() => store.getState().setMachines([]));
  render(<MachineActions name="studio" menuOnly />);
  fireEvent.click(more());
  const terminal = screen.getByTestId('machine-terminal');
  expect([terminal.hasAttribute('disabled'), terminal.getAttribute('data-tip')]).toEqual([true, 'This Mac has no ssh route to studio']);
});
