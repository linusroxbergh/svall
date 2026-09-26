// @vitest-environment jsdom
import './setup.js';
import { act, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { setAppStore } from '../../src/hooks.js';
import { createAppStore, type AppStore } from '../../src/store/index.js';
import { fleet } from '../fixtures.js';

const call = vi.fn((_method: string, _params?: unknown) => Promise.resolve({}));
const manager = { show: vi.fn(() => Promise.resolve()), move: vi.fn(), hide: vi.fn() };
let store: AppStore;
vi.mock('../../src/boot.js', () => ({
  app: { get store() { return store; }, bridge: { present: true, send: () => {}, onMessage: () => () => {} }, manager: () => manager },
  deps: () => ({ api: { call }, store }),
}));

const { TerminalArea } = await import('../../src/TerminalArea.js');

beforeEach(() => {
  vi.useFakeTimers();
  call.mockClear();
  store = createAppStore();
  setAppStore(store);
  const f = fleet();
  delete f.characters.c1.tmux;
  store.getState().setFleet(f);
});

afterEach(() => { vi.useRealTimers(); });

test('opening a dormant character wakes it once it has stayed in view a moment', () => {
  render(<TerminalArea id="c1" />);
  expect(screen.getByTestId('resuming')).toBeTruthy();
  expect(screen.queryByTestId('revive')).toBeNull();
  expect(call).not.toHaveBeenCalled();
  act(() => { vi.advanceTimersByTime(1000); });
  expect(call).toHaveBeenCalledWith('char.revive', { id: 'c1' });
});

test('passing by a dormant character wakes nothing', () => {
  const { unmount } = render(<TerminalArea id="c1" />);
  act(() => { vi.advanceTimersByTime(500); });
  unmount();
  act(() => { vi.advanceTimersByTime(1000); });
  expect(call).not.toHaveBeenCalled();
});

test('a character that goes dormant while open waits for the button', () => {
  render(<TerminalArea id="c0" />);
  const f = fleet();
  delete f.characters.c0.tmux;
  act(() => store.getState().setFleet(f));
  act(() => { vi.advanceTimersByTime(1000); });
  expect(screen.getByTestId('revive')).toBeTruthy();
  expect(call).not.toHaveBeenCalled();
});

test('a wake the fleet refuses says why and leaves the button', async () => {
  call.mockRejectedValueOnce(new Error('no session to resume'));
  render(<TerminalArea id="c1" />);
  await act(async () => { vi.advanceTimersByTime(1000); });
  expect(screen.getByTestId('revive')).toBeTruthy();
  expect(store.getState().toast?.text).toBe('no session to resume');
});
