// @vitest-environment jsdom
import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, expect, test, vi } from 'vitest';
import { freshStore, sent, store } from './harness.js';

vi.mock('../../src/boot.js', async () => (await import('./harness.js')).bootModule());

const { Said } = await import('../../src/Said.js');

beforeEach(() => { freshStore(); });

const STUDIO = { name: 'studio', id: 'm1', ssh: 'ada@studio', platform: 'linux-x64' };
const terminal = () => screen.queryByRole('button', { name: 'Open terminal' });

test('a problem says its line, what to do under it, and what a tool said behind a shut details', () => {
  const { container } = render(<Said line="Tailscale is not running on studio" fix="Start it there: sudo systemctl start tailscaled" raw={'Command failed: tailscale status --json\ntailscale is stopped'} />);
  const [line, fix] = container.querySelectorAll('.said > div > span');
  expect(line.textContent).toBe('Tailscale is not running on studio');
  expect(fix.className).toBe('modal-sub');
  expect(fix.textContent).toBe('Start it there: sudo systemctl start tailscaled');
  const details = container.querySelector('.said details.modal-more')!;
  expect(details.hasAttribute('open')).toBe(false);
  expect(details.querySelector('summary')!.textContent).toBe('details');
  expect(details.querySelector('.modal-more-body.mono')!.textContent).toBe('Command failed: tailscale status --json\ntailscale is stopped');
});

test('a problem with nothing more to it is its line alone', () => {
  const { container } = render(<Said line="studio is not reachable" />);
  expect(container.querySelector('.said')!.textContent).toBe('studio is not reachable');
  expect(container.querySelector('details')).toBeNull();
});

test('in Settings, what to do is a note of the window', () => {
  const { container } = render(<Said line="The scribe stopped" fix="Check the scribe model" settings />);
  expect(container.querySelector('.set-note')!.textContent).toBe('Check the scribe model');
  expect(container.querySelector('.modal-sub')).toBeNull();
});

test('a command to run there opens a terminal on the machine with it typed', () => {
  act(() => store.getState().setMachines([STUDIO]));
  render(<Said line="Tailscale is not running on studio" run="sudo systemctl start tailscaled" on="studio" />);
  sent.length = 0;
  fireEvent.click(terminal()!);
  expect(sent).toContainEqual({ type: 'host.list' });
  expect(store.getState().hostMachine).toBe('studio');
  expect(store.getState().hostTerminal).toEqual({ run: 'sudo systemctl start tailscaled' });
});

test('no terminal on a machine this Mac has no ssh to, nor without a command or a machine', () => {
  act(() => store.getState().setMachines([STUDIO, { name: 'mini', id: 'm2', platform: 'darwin-arm64' }]));
  const { rerender } = render(<Said line="x" run="tailscale up" on="mini" />);
  expect(terminal()).toBeNull();
  rerender(<Said line="x" run="tailscale up" />);
  expect(terminal()).toBeNull();
  rerender(<Said line="x" on="studio" />);
  expect(terminal()).toBeNull();
  rerender(<Said line="x" run="tailscale up" on="studio" />);
  expect(terminal()).not.toBeNull();
});

test('before the list is read a terminal is offered, and a machine the list does not hold is not; either way the list is read again', () => {
  const { rerender } = render(<Said line="x" run="tailscale up" on="studio" />);
  expect(terminal()).not.toBeNull();
  expect(sent).toContainEqual({ type: 'host.list' });
  act(() => store.getState().setMachines([STUDIO]));
  sent.length = 0;
  rerender(<Said line="x" run="tailscale up" on="box" />);
  expect(terminal()).toBeNull();
  expect(sent).toContainEqual({ type: 'host.list' });
});
