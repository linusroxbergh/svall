// @vitest-environment jsdom
import './setup.js';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, expect, test, vi } from 'vitest';
import { setAppStore } from '../../src/hooks.js';
import { createAppStore, type AppStore } from '../../src/store/index.js';
import { fleet } from '../fixtures.js';

const call = vi.fn((_method: string, _params?: unknown) => Promise.resolve({}));
let store: AppStore;
vi.mock('../../src/boot.js', () => ({ deps: () => ({ api: { call }, store }) }));

const { ScribeAsk } = await import('../../src/ScribeAsk.js');

beforeEach(() => {
  call.mockClear();
  store = createAppStore();
  setAppStore(store);
  store.getState().setFleet({ ...fleet(), scribeAsk: true });
});

// Enter presses the focused button, so a reflex Enter must not opt in to spending usage
test('the scribe question opens with Keep off focused', () => {
  render(<ScribeAsk />);
  expect(document.activeElement).toBe(screen.getByTestId('scribe-ask-off'));
});

test('names the CLI the scribe runs on', () => {
  act(() => store.getState().setFleet({ ...fleet(), scribeAsk: true, scribeAgent: 'codex' }));
  render(<ScribeAsk />);
  expect(screen.getByTestId('scribe-ask').textContent).toContain('headless Codex call');
});

test('asks for the main agent when archid finds both CLIs, and only then', () => {
  act(() => store.getState().setFleet({ ...fleet(), scribeAsk: true, mainAgent: 'claude', agentsFound: ['claude', 'codex'] }));
  const { unmount } = render(<ScribeAsk />);
  const pick = screen.getByTestId('scribe-ask-agent') as HTMLSelectElement;
  expect(pick.value).toBe('claude');
  fireEvent.change(pick, { target: { value: 'codex' } });
  expect(call).toHaveBeenCalledWith('mainAgent.set', { agent: 'codex' });
  unmount();
  act(() => store.getState().setFleet({ ...fleet(), scribeAsk: true, agentsFound: ['codex'] }));
  render(<ScribeAsk />);
  expect(screen.queryByTestId('scribe-ask-agent')).toBeNull();
});

// the dialog's Escape means Keep off wherever focus sits, including the agent select
test('Escape on the agent select keeps the scribe off, same as elsewhere in the dialog', () => {
  act(() => store.getState().setFleet({ ...fleet(), scribeAsk: true, mainAgent: 'claude', agentsFound: ['claude', 'codex'] }));
  render(<ScribeAsk />);
  fireEvent.keyDown(screen.getByTestId('scribe-ask-agent'), { key: 'Escape' });
  expect(call).toHaveBeenCalledWith('scribe.set', { enabled: false });
});

// Enter on the select is left to the browser's own popup, not answered as a dialog press
test('Enter on the agent select answers nothing', () => {
  act(() => store.getState().setFleet({ ...fleet(), scribeAsk: true, mainAgent: 'claude', agentsFound: ['claude', 'codex'] }));
  render(<ScribeAsk />);
  fireEvent.keyDown(screen.getByTestId('scribe-ask-agent'), { key: 'Enter' });
  expect(call).not.toHaveBeenCalled();
});
