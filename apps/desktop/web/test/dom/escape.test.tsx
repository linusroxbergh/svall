// @vitest-environment jsdom
import './setup.js';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { setAppStore } from '../../src/hooks.js';
import { createAppStore, type AppStore } from '../../src/store/index.js';
import { fleet } from '../fixtures.js';

const call = vi.fn((_method: string, _params: unknown) => Promise.resolve({}));
const bridge = { present: false, send() {}, onMessage: () => () => {} };
let store: AppStore;
vi.mock('../../src/boot.js', () => ({
  app: { get store() { return store; }, bridge, api: () => ({ call }) },
  deps: () => ({ api: { call }, store, bridge }),
}));

const { NewCharacter } = await import('../../src/NewCharacter.js');
const { MissionPrompt } = await import('../../src/MissionPrompt.js');
const { Sidebar } = await import('../../src/Sidebar.js');
const { dispatchKey, installKeyHandlers } = await import('../../src/keyboard.js');

let off: () => void;
beforeEach(() => {
  call.mockClear();
  store = createAppStore();
  setAppStore(store);
  store.getState().setFleet(fleet());
  off = installKeyHandlers({ store, api: { call } as never, bridge });
});
afterEach(() => off());

test('Esc in the new-character dialog closes the dialog and leaves the map card open', () => {
  store.getState().focus('c0');
  store.getState().setNamingCharacter(true);
  render(<NewCharacter />);
  fireEvent.keyDown(screen.getByTestId('new-character-name'), { key: 'Escape' });
  expect(store.getState().namingCharacter).toBe(false);
  expect(store.getState().card).toBe('c0');
});

test('Esc in the mission prompt closes it and leaves the board side card open', () => {
  store.getState().setView('board');
  store.getState().setMissionPrompt(true);
  render(<MissionPrompt />);
  fireEvent.keyDown(screen.getByTestId('mission-prompt-text'), { key: 'Escape' });
  expect(store.getState().missionPrompt).toBe(false);
  expect(store.getState().sideCardCollapsed).toBe(false);
});

test('the new-character key sets a typed mission prompt aside for the next open, and Esc gives it up', async () => {
  const keys = { store, api: { call } as never, bridge };
  const text = () => (screen.getByTestId('mission-prompt-text') as HTMLTextAreaElement).value;
  store.getState().setMissionPrompt(true);
  render(<MissionPrompt />);
  fireEvent.change(screen.getByTestId('mission-prompt-text'), { target: { value: 'tidy the docs' } });
  await act(() => dispatchKey({ type: 'newCharacter' }, keys));
  expect(screen.queryByTestId('mission-prompt-text')).toBeNull();
  await act(() => dispatchKey({ type: 'missionControl' }, keys));
  expect(text()).toBe('tidy the docs');
  fireEvent.keyDown(screen.getByTestId('mission-prompt-text'), { key: 'Escape' });
  await act(() => dispatchKey({ type: 'missionControl' }, keys));
  expect(text()).toBe('');
});

test('Esc in the island rename gives up the rename and keeps the island selected', () => {
  store.getState().selectIsland('i_a');
  render(<Sidebar />);
  fireEvent.doubleClick(screen.getByTestId('sb-island-i_a'));
  const input = screen.getByTestId('island-name-input') as HTMLInputElement;
  fireEvent.change(input, { target: { value: 'half typed' } });
  fireEvent.keyDown(input, { key: 'Escape' });
  expect(screen.queryByTestId('island-name-input')).toBeNull();
  expect(store.getState().selectedIslandId).toBe('i_a');
  expect(call).not.toHaveBeenCalledWith('island.update', expect.anything());
});
