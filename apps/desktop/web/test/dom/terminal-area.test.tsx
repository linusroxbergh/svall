// @vitest-environment jsdom
import { act, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import type { MachineId, Robot } from '@svall/protocol';
import { fleet } from '../fixtures.js';
import { bridge, call, freshStore, store } from './harness.js';

bridge.present = true;
vi.mock('../../src/boot.js', async () => (await import('./harness.js')).bootModule());

const { TerminalArea } = await import('../../src/TerminalArea.js');

beforeEach(() => {
  vi.useFakeTimers();
  freshStore();
  const f = fleet();
  delete f.robots.c1.tmux;
  store.getState().setFleet(f);
});

afterEach(() => { vi.useRealTimers(); });

test('opening a dormant robot wakes it once it has stayed in view a moment', () => {
  render(<TerminalArea id="c1" />);
  expect(screen.getByTestId('resuming')).toBeTruthy();
  expect(screen.queryByTestId('revive')).toBeNull();
  expect(call).not.toHaveBeenCalled();
  act(() => { vi.advanceTimersByTime(1000); });
  expect(call).toHaveBeenCalledWith('robot.revive', { id: 'c1' });
});

test('passing by a dormant robot wakes nothing', () => {
  const { unmount } = render(<TerminalArea id="c1" />);
  act(() => { vi.advanceTimersByTime(500); });
  unmount();
  act(() => { vi.advanceTimersByTime(1000); });
  expect(call).not.toHaveBeenCalled();
});

test('a robot that goes dormant while open waits for the button', () => {
  render(<TerminalArea id="c0" />);
  const f = fleet();
  delete f.robots.c0.tmux;
  act(() => store.getState().setFleet(f));
  act(() => { vi.advanceTimersByTime(1000); });
  expect(screen.getByTestId('revive')).toBeTruthy();
  expect(call).not.toHaveBeenCalled();
});

const closedForIdleness = () => {
  const f = fleet();
  f.robots.c0.agent = { kind: 'claude', sessionId: 's', status: 'idle', lastActivityAt: 0 };
  render(<TerminalArea id="c0" />);
  delete f.robots.c0.tmux;
  f.robots.c0.revive = { command: 'claude --resume s' };
  act(() => store.getState().setFleet(f));
};

test('a robot closed for idleness while open resumes rather than asking', () => {
  closedForIdleness();
  expect(screen.getByTestId('resuming').textContent).toBe('Resuming the session…');
  act(() => { vi.advanceTimersByTime(1000); });
  expect(call).toHaveBeenCalledWith('robot.revive', { id: 'c0' });
});

test('one closed for idleness while the app is away waits for it to come back', () => {
  act(() => store.getState().setActive(false));
  closedForIdleness();
  act(() => { vi.advanceTimersByTime(5000); });
  expect(call).not.toHaveBeenCalled();
  act(() => store.getState().setActive(true));
  act(() => { vi.advanceTimersByTime(1000); });
  expect(call).toHaveBeenCalledWith('robot.revive', { id: 'c0' });
});

test('a robot with no session to resume says it is starting its terminal', () => {
  render(<TerminalArea id="c1" />);
  expect(screen.getByTestId('resuming').textContent).toBe('Starting the terminal…');
});

test('a wake the fleet refuses says why and leaves the button', async () => {
  call.mockRejectedValueOnce(new Error('no session to resume'));
  render(<TerminalArea id="c1" />);
  await act(async () => { vi.advanceTimersByTime(1000); });
  expect(screen.getByTestId('revive')).toBeTruthy();
  expect(store.getState().toast?.text).toBe('no session to resume');
});

test('one a handover could not resume says why and waits for the button while the fleet asks for handover', () => {
  act(() => store.getState().setShell({ home: '/h', log: [], op: false, handoverEnabled: true }));
  const f = fleet();
  delete f.robots.c1.tmux;
  f.robots.c1.resumeError = 'codex exited back to its shell';
  act(() => store.getState().setFleet(f));
  render(<TerminalArea id="c1" />);
  act(() => { vi.advanceTimersByTime(1000); });
  expect(screen.getByTestId('resume-error').textContent).toBe('codex exited back to its shell');
  expect(screen.getByTestId('revive')).toBeTruthy();
  expect(call).not.toHaveBeenCalled();
});

test('starting afresh from a failed resume asks first, and says where the old session stays once it has started', async () => {
  act(() => store.getState().setShell({ home: '/h', log: [], op: false, handoverEnabled: true }));
  const f = fleet();
  delete f.robots.c1.tmux;
  f.robots.c1.agent = { kind: 'claude', sessionId: 'old-1', transcriptPath: '/h/.claude/projects/-w/old-1.jsonl', status: 'idle', lastActivityAt: 0 };
  f.robots.c1.resumeError = 'claude exited back to its shell';
  act(() => store.getState().setFleet(f));
  render(<TerminalArea id="c1" />);
  act(() => { screen.getByTestId('fresh').click(); });
  expect(call).not.toHaveBeenCalled();
  expect(screen.getByTestId('fresh-ask').textContent).toBe('Start a new Claude Code session here from a summary of old-1? The old session stays where it is.');
  act(() => { screen.getByTestId('fresh-cancel').click(); });
  expect(screen.queryByTestId('fresh-ask')).toBeNull();

  act(() => { screen.getByTestId('fresh').click(); });
  await act(async () => { screen.getByTestId('fresh-go').click(); });
  expect(call).toHaveBeenCalledWith('robot.fresh', { id: 'c1' });
  expect(store.getState().toast).toEqual({ text: 'c1 started fresh; old session old-1 kept at /h/.claude/projects/-w/old-1.jsonl', tone: 'ok' });
});

const VAULT = '4b7a3c1e-2d5f-4e6a-9b8c-0f1e2d3c4b5a' as MachineId;
const placed = (reachable: boolean, more: Partial<Robot> = {}) => {
  const f = fleet();
  f.machines = { [VAULT]: { name: 'linus-vault', reachable, since: 0 } };
  Object.assign(f.robots.c1, { machine: VAULT, ...more });
  act(() => store.getState().setFleet(f));
};

test('a robot on a worker out of reach says so in place of its terminal, and attaches or wakes nothing', () => {
  placed(false);
  render(<TerminalArea id="c1" />);
  act(() => { vi.advanceTimersByTime(5000); });
  expect(screen.getByTestId('terminal-unreachable').textContent).toBe('linus-vault is not reachable');
  expect(screen.queryByTestId('surface')).toBeNull();
  expect(call.mock.calls).toEqual([['term.lastScreen', { id: 'c1' }]]);
});

test('an unreachable robot shows the sentence and the last screen term.lastScreen answers, scrolled to its end', async () => {
  // capture-pane's lines, as tmux.capture joins them
  call.mockResolvedValueOnce({ text: '$ make test\r\nok', at: 1 });
  const tall = vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockReturnValue(900);
  placed(false);
  render(<TerminalArea id="c1" />);
  await act(async () => {});
  tall.mockRestore();
  expect(screen.getByTestId('terminal-unreachable').textContent).toBe('linus-vault is not reachable');
  expect(screen.getByTestId('terminal-last-screen').textContent).toBe('$ make test\nok');
  expect(screen.getByTestId('terminal-last-screen').scrollTop).toBe(900);
  // a scroller the keyboard reaches, as WKWebView does not make one focusable
  expect(screen.getByLabelText('Last screen the worker sent').tabIndex).toBe(0);
  // back in reach, the terminal stands in for it
  placed(true);
  expect(screen.queryByTestId('terminal-last-screen')).toBeNull();
  expect(call.mock.calls).toEqual([['term.lastScreen', { id: 'c1' }]]);
});

test('a robot on a worker linked on another build names the upgrade in place of its terminal', () => {
  const f = fleet();
  f.machines = { [VAULT]: { name: 'linus-vault', reachable: false, since: 0, mismatch: true } };
  Object.assign(f.robots.c1, { machine: VAULT });
  act(() => store.getState().setFleet(f));
  render(<TerminalArea id="c1" />);
  expect(screen.getByTestId('terminal-unreachable').textContent).toBe('linus-vault runs a different build; upgrade it under Machines');
});

test('a moving robot says where it goes, and Retry runs on a move whose activate failed', async () => {
  placed(true, { moving: { id: 'mv_0123456789', to: VAULT, phase: 'prepare' } });
  render(<TerminalArea id="c1" />);
  act(() => { vi.advanceTimersByTime(5000); });
  expect(screen.getByTestId('terminal-moving').textContent).toBe('moving to linus-vault…');
  expect(screen.queryByTestId('move-retry')).toBeNull();
  expect(call).not.toHaveBeenCalled();

  placed(true, { moving: { id: 'mv_0123456789', to: VAULT, phase: 'activate', error: 'claude exited back to its shell' } });
  expect(screen.getByTestId('move-error').textContent).toBe('claude exited back to its shell');
  await act(async () => screen.getByTestId('move-retry').click());
  expect(call).toHaveBeenCalledWith('robot.moveRetry', { moveId: 'mv_0123456789' });
});

test('a robot on its way back says it is moving to this Mac', () => {
  placed(true, { moving: { id: 'mv_0123456789', to: '9d0e1f2a-3b4c-4d5e-8f6a-7b8c9d0e1f2a' as MachineId, phase: 'rest' } });
  render(<TerminalArea id="c1" />);
  expect(screen.getByTestId('terminal-moving').textContent).toBe('moving to this Mac…');
});
