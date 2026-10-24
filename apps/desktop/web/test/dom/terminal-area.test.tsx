// @vitest-environment jsdom
import { act, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
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

test('a dormant robot wakes nothing while a handover rests the fleet', () => {
  act(() => store.getState().handoverEvent({ event: 'handover.status', data: { standing: 'committed', journals: {}, action: 'none', safe: [], reason: 'moving' } }));
  render(<TerminalArea id="c1" />);
  act(() => { vi.advanceTimersByTime(5000); });
  expect(screen.getByTestId('terminal-held')).toBeTruthy();
  expect(call).not.toHaveBeenCalled();
});

test('a terminal rested for a handover says the step it is at, and opens the sheet on a click', () => {
  act(() => {
    store.getState().handoverFollow('trift');
    for (const phase of ['begin', 'freeze', 'transfer'] as const) store.getState().handoverEvent({ event: 'handover.changed', data: { transactionId: 'tx', phase } });
  });
  render(<TerminalArea id="c1" />);
  expect(screen.getByTestId('terminal-held').textContent).toBe('Resting for the handover: Transferring files and sessions…');
  act(() => screen.getByTestId('terminal-held').click());
  expect(store.getState().handoverOpen).toBe(true);
});
