// @vitest-environment jsdom
import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, expect, test, vi } from 'vitest';
import { bridge, freshStore, sent, store } from './harness.js';

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

test('a problem carries a failure mark at its left, a warning its own, and none inside a row that has one', () => {
  const { container, rerender } = render(<Said line="studio is not reachable" />);
  expect(container.querySelector('.said > .said-mark + div')!.textContent).toBe('studio is not reachable');
  expect(container.querySelector('.said')!.getAttribute('data-mark')).toBe('fail');
  rerender(<Said line="studio is not reachable" mark="warn" />);
  expect(container.querySelector('.said')!.getAttribute('data-mark')).toBe('warn');
  rerender(<Said line="studio is not reachable" mark={false} />);
  expect(container.querySelector('.said-mark')).toBeNull();
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

test('a command on a machine this Mac has no route to, and no fix that quotes it, waits behind details before what the tool said', () => {
  act(() => store.getState().setMachines([STUDIO, { name: 'mini', id: 'm2', platform: 'darwin-arm64' }]));
  const { container } = render(<Said line="Tailscale names no login for mini" fix="Set mobile.logins in fleet.json, then restart Svall's background service" run="svall restart" on="mini" raw="no owner" />);
  expect(container.querySelector('.modal-more-body')!.textContent).toBe('svall restart\n\nno owner');
  expect(screen.queryByTestId('said-copy')).toBeNull();
});

test('a command that runs on this Mac stands whole in mono with Copy beside it, which copies it and says so for a moment; a tool\'s words stay behind details', () => {
  vi.useFakeTimers();
  bridge.present = true;
  try {
    const { container, rerender } = render(<Said line="Tailscale on this Mac does not let Svall share this fleet" fix="Run once on this Mac: sudo tailscale set --operator=$USER" run="sudo tailscale set --operator=$USER" raw="Access denied" />);
    expect(container.querySelector('.modal-sub code.said-run')!.textContent).toBe('sudo tailscale set --operator=$USER');
    // ending the fix, it stands on a line of its own, as a command the fix does not quote does
    expect(container.querySelector('.modal-sub code.said-run')!.hasAttribute('data-own-line')).toBe(true);
    expect(container.querySelector('.modal-sub')!.textContent).toBe('Run once on this Mac: sudo tailscale set --operator=$USER');
    expect(container.querySelector('.modal-more-body')!.textContent).toBe('Access denied');
    expect(terminal()).toBeNull();
    const copy = screen.getByTestId('said-copy');
    sent.length = 0;
    fireEvent.click(copy);
    expect(sent).toContainEqual({ type: 'copy', text: 'sudo tailscale set --operator=$USER' });
    expect(copy.textContent).toBe('Copied');
    act(() => { vi.advanceTimersByTime(1500); });
    expect(copy.textContent).toBe('Copy');
    // a fix that does not quote it has the command on a line of its own, never inside the prose
    rerender(<Said line="x" fix="Set mobile.logins, then restart Svall's background service" run="svall restart" />);
    expect(container.querySelector('.said > div > code.said-run')!.textContent).toBe('svall restart');
    expect(container.querySelector('details')).toBeNull();
  } finally { vi.useRealTimers(); bridge.present = false; }
});
