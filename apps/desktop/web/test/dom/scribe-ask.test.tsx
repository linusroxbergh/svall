// @vitest-environment jsdom
import './setup.js';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, expect, test, vi } from 'vitest';
import type { ToShell } from '../../src/bridge.js';
import { setAppStore } from '../../src/hooks.js';
import { createAppStore, type AppStore } from '../../src/store/index.js';
import { fleet } from '../fixtures.js';

const call = vi.fn((_method: string, _params?: unknown) => Promise.resolve({}));
const sent: ToShell[] = [];
const bridge = { present: true, send: (m: ToShell) => { sent.push(m); }, onMessage: () => () => {} };
let store: AppStore;
vi.mock('../../src/boot.js', () => ({ deps: () => ({ api: { call }, store, bridge }) }));

const { ScribeAsk } = await import('../../src/ScribeAsk.js');

beforeEach(() => {
  call.mockClear();
  sent.length = 0;
  window.__svallHome = undefined;
  store = createAppStore();
  setAppStore(store);
  store.getState().setFleet({ ...fleet(), scribeAsk: true });
});

test('a fresh private fleet is named first, with the command that opens it, then asked about the scribe', async () => {
  window.__svallHome = '/u/.svall';
  render(<ScribeAsk />);
  expect(screen.queryByTestId('scribe-ask')).toBeNull();
  fireEvent.change(screen.getByTestId('fleet-name-input'), { target: { value: 'home' } });
  expect(screen.getByTestId('fleet-name-ask').textContent).toContain('svall-dev home');
  fireEvent.click(screen.getByTestId('fleet-name-save'));
  await waitFor(() => expect(sent).toContainEqual({ type: 'retitle' }));
  expect(call).toHaveBeenCalledWith('fleet.rename', { name: 'home' });
  act(() => store.getState().setFleet({ ...fleet(), scribeAsk: true, name: 'home' }));
  expect(screen.getByTestId('scribe-ask')).toBeTruthy();
});

test('a name svalld refuses says why and stays on the step; Skip leaves the fleet private', async () => {
  window.__svallHome = '/u/.svall';
  call.mockImplementationOnce(() => Promise.reject(new Error('another fleet is called work')));
  render(<ScribeAsk />);
  const input = screen.getByTestId('fleet-name-input');
  expect(['autocapitalize', 'autocorrect', 'spellcheck', 'autocomplete'].map((a) => input.getAttribute(a))).toEqual(['off', 'off', 'false', 'off']);
  fireEvent.change(input, { target: { value: 'Work' } });
  expect((screen.getByTestId('fleet-name-save') as HTMLButtonElement).disabled).toBe(true);
  fireEvent.change(input, { target: { value: 'work' } });
  fireEvent.keyDown(input, { key: 'Enter' });
  expect(await screen.findByText('another fleet is called work')).toBeTruthy();
  fireEvent.click(screen.getByTestId('fleet-name-skip'));
  expect(screen.getByTestId('scribe-ask')).toBeTruthy();
  expect(call).toHaveBeenCalledTimes(1);
});

test('a fleet its directory names, or one already named, goes straight to the scribe', () => {
  window.__svallHome = '/u/.svall-work';
  const { unmount } = render(<ScribeAsk />);
  expect(screen.getByTestId('scribe-ask')).toBeTruthy();
  unmount();
  window.__svallHome = '/u/.svall';
  act(() => store.getState().setFleet({ ...fleet(), scribeAsk: true, name: 'home' }));
  render(<ScribeAsk />);
  expect(screen.getByTestId('scribe-ask')).toBeTruthy();
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

test('asks for the main agent when svalld finds both CLIs, and only then', () => {
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
