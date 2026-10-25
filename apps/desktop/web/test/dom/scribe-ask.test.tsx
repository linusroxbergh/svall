// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, expect, test, vi } from 'vitest';
import { fleet } from '../fixtures.js';
import { bridge, call, freshStore, sent, store } from './harness.js';

bridge.present = true;
vi.mock('../../src/boot.js', async () => (await import('./harness.js')).bootModule());

const { PlacingAsk, ScribeAsk } = await import('../../src/ScribeAsk.js');

beforeEach(() => {
  window.__svallHome = undefined;
  freshStore();
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

test('names every agent svalld found when it asks which one runs', () => {
  act(() => store.getState().setFleet({ ...fleet(), scribeAsk: true, mainAgent: 'claude', agentsFound: ['claude', 'codex', 'opencode'] }));
  const { unmount } = render(<ScribeAsk />);
  expect(screen.getByText(/are installed/).textContent).toBe('Claude Code, Codex and OpenCode are installed. Mission control and the scribe run:');
  expect([...(screen.getByTestId('scribe-ask-agent') as HTMLSelectElement).options].map((o) => o.value)).toEqual(['claude', 'codex', 'opencode']);
  unmount();
  act(() => store.getState().setFleet({ ...fleet(), scribeAsk: true, mainAgent: 'claude', agentsFound: ['claude', 'codex'] }));
  render(<ScribeAsk />);
  expect(screen.getByText(/are installed/).textContent).toBe('Claude Code and Codex are installed. Mission control and the scribe run:');
});

// the dialog's Escape means Keep off wherever focus sits, including the agent select
test('Escape on the agent select keeps the scribe off, same as elsewhere in the dialog', () => {
  act(() => store.getState().setFleet({ ...fleet(), scribeAsk: true, mainAgent: 'claude', agentsFound: ['claude', 'codex'] }));
  render(<ScribeAsk />);
  fireEvent.keyDown(screen.getByTestId('scribe-ask-agent'), { key: 'Escape' });
  expect(call).toHaveBeenCalledWith('scribe.set', { enabled: false });
});

test('the × keeps the scribe off, as Escape does', () => {
  act(() => store.getState().setFleet({ ...fleet(), scribeAsk: true, mainAgent: 'claude', agentsFound: ['claude', 'codex'] }));
  render(<ScribeAsk />);
  fireEvent.click(screen.getByTestId('scribe-ask-close'));
  expect(call).toHaveBeenCalledWith('scribe.set', { enabled: false });
  expect(call).not.toHaveBeenCalledWith('scribe.set', { enabled: true });
});

// Enter on the select is left to the browser's own popup, not answered as a dialog press
test('Enter on the agent select answers nothing', () => {
  act(() => store.getState().setFleet({ ...fleet(), scribeAsk: true, mainAgent: 'claude', agentsFound: ['claude', 'codex'] }));
  render(<ScribeAsk />);
  fireEvent.keyDown(screen.getByTestId('scribe-ask-agent'), { key: 'Enter' });
  expect(call).not.toHaveBeenCalled();
});

test('the board asks about placing after the scribe, with Keep off focused, and Turn on brings a scribe that is off', () => {
  act(() => { store.getState().setView('board'); store.getState().setFleet({ ...fleet(), scribeAsk: true, placingAsk: true }); });
  const { rerender } = render(<PlacingAsk />);
  expect(screen.queryByTestId('placing-ask')).toBeNull();
  act(() => store.getState().setFleet({ ...fleet(), scribeOff: true, placingAsk: true }));
  rerender(<PlacingAsk />);
  expect(document.activeElement).toBe(screen.getByTestId('placing-ask-off'));
  expect(screen.getByTestId('placing-ask').textContent).toContain('Turning this on turns the scribe on too.');
  fireEvent.click(screen.getByTestId('placing-ask-on'));
  expect(call).toHaveBeenCalledWith('scribe.set', { enabled: true });
  expect(call).toHaveBeenCalledWith('placing.set', { enabled: true });
});

test('with the scribe on, the placing ask leaves it be; Escape keeps placing off', () => {
  act(() => { store.getState().setView('board'); store.getState().setFleet({ ...fleet(), placingAsk: true }); });
  render(<PlacingAsk />);
  expect(screen.getByTestId('placing-ask').textContent).not.toContain('turns the scribe on');
  fireEvent.keyDown(screen.getByTestId('placing-ask-off'), { key: 'Escape' });
  expect(call).toHaveBeenCalledWith('placing.set', { enabled: false });
  expect(call).not.toHaveBeenCalledWith('scribe.set', expect.anything());
});
