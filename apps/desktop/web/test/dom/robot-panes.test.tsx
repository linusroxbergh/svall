// @vitest-environment jsdom
import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, expect, test, vi } from 'vitest';
import type { MachineId } from '@svall/protocol';
import { fleet } from '../fixtures.js';
import { call, freshStore, retryHome, sent, store } from './harness.js';

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
// what stands in a pane: its line, then what it says under it and its button
const away = (el: Element) => [...el.querySelector('.away-says')!.children].map((e) => e.textContent);

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
  const said = ['linus-vault is not reachable', 'Its terminal and files show again when it answers.', 'Check linus-vault'];
  expect(screen.getAllByTestId('pane-elsewhere').map(away)).toEqual([said, said]);
  expect(call.mock.calls.map(([m]) => m).filter((m) => /^(fs|repo)\./.test(m))).toEqual([]);
  // the check is the card's: the Machines panel opens on a check of the machine
  fireEvent.click(screen.getAllByTestId('away-check')[0]);
  expect(sent.at(-1)).toEqual({ type: 'host.start', op: 'doctor', args: { name: 'linus-vault' } });
  expect([store.getState().hostOpen, store.getState().hostMachine]).toEqual([true, 'linus-vault']);
});

test('on this Mac\'s copy of the fleet, a far robot\'s Files say how old the copy is and try the home again', () => {
  const MAC = '11111111-1111-4111-8111-111111111111' as MachineId;
  const STUDIO = '22222222-2222-4222-8222-222222222222' as MachineId;
  const at = new Date(2026, 10, 10, 9, 30).getTime();
  act(() => {
    store.getState().applyPatch([{ op: 'add', path: `/machines/${STUDIO}`, value: { name: 'studio', reachable: true, since: 0, snapshot: { version: 1, at } } }]);
    store.getState().setVia({ machine: MAC, home: STUDIO, name: 'studio' });
    store.getState().setHome({ name: 'studio', state: 'unreachable' } as never);
    store.getState().setPanes('c0', { left: 'files' });
  });
  render(<RobotPanes id="c0" />);
  const time = new Date(at).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
  expect(away(screen.getByTestId('pane-elsewhere'))).toEqual(['studio is not reachable', `Showing the fleet as of ${time}.`, 'Try again']);
  fireEvent.click(screen.getByTestId('away-retry'));
  expect(retryHome).toHaveBeenCalled();
});

test('while its machine runs a different build, Files and Changes say so as the terminal does', () => {
  act(() => store.getState().applyPatch([{ op: 'add', path: '/robots/c0/machine', value: VAULT }]));
  act(() => store.getState().applyPatch([{ op: 'replace', path: `/machines/${VAULT}`, value: { name: 'linus-vault', reachable: false, since: 0, mismatch: true } }]));
  act(() => store.getState().setPanes('c0', { left: 'files', right: 'changes' }));
  render(<RobotPanes id="c0" />);
  expect(screen.getAllByTestId('pane-elsewhere').map((e) => away(e)[0])).toEqual(['linus-vault runs a different build; upgrade it under Machines', 'linus-vault runs a different build; upgrade it under Machines']);
});

test('a robot on a worker says under each pane\'s head where it runs, and one here says nothing', () => {
  act(() => store.getState().setPanes('c0', { left: 'terminal', right: 'files' }));
  const { unmount } = render(<RobotPanes id="c0" />);
  expect(screen.queryAllByTestId(/^pane-(left|right)-machine$/)).toEqual([]);
  unmount();
  act(() => store.getState().applyPatch([{ op: 'add', path: '/robots/c0/machine', value: VAULT }]));
  render(<RobotPanes id="c0" />);
  expect(screen.getAllByTestId(/^pane-(left|right)-machine$/).map((e) => e.textContent)).toEqual(['Runs on linus-vault', 'Runs on linus-vault']);
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

test('a robot elsewhere offers a terminal there from each pane\'s line, and one here offers none', async () => {
  const MAC = '11111111-1111-4111-8111-111111111111' as MachineId;
  const STUDIO = '22222222-2222-4222-8222-222222222222' as MachineId;
  act(() => { store.getState().setVia({ machine: MAC, home: STUDIO, name: 'studio', online: true }); store.getState().setPanes('c0', { left: 'terminal', right: 'files' }); });
  const { rerender } = render(<RobotPanes id="c0" />);
  expect(screen.getByTestId('pane-left-machine').textContent).toBe('Runs on studio');
  expect(screen.getByTestId('pane-right-terminal-there').textContent).toBe('Shell on studio');
  fireEvent.click(screen.getByTestId('pane-right-terminal-there'));
  expect(store.getState().hostTerminal).toEqual({ run: "cd '/tmp'" });
  expect(store.getState().hostMachine).toBe('studio');
  act(() => store.getState().applyPatch([{ op: 'add', path: '/robots/c0/machine', value: MAC }]));
  rerender(<RobotPanes id="c0" />);
  expect(screen.queryByTestId('pane-left-machine')).toBeNull();
  expect(screen.queryByTestId('pane-left-terminal-there')).toBeNull();
});
