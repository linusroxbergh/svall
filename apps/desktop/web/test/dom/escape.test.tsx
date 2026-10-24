// @vitest-environment jsdom
import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { bridge, call, freshStore, store } from './harness.js';

vi.mock('../../src/boot.js', async () => (await import('./harness.js')).bootModule());

const { NewRobot } = await import('../../src/NewRobot.js');
const { MissionPrompt } = await import('../../src/MissionPrompt.js');
const { ConfirmClose } = await import('../../src/ConfirmClose.js');
const { ConfirmSleep } = await import('../../src/ConfirmSleep.js');
const { ConfirmDeleteIsland } = await import('../../src/ConfirmDeleteIsland.js');
const { Sidebar } = await import('../../src/Sidebar.js');
const { dispatchKey, installKeyHandlers } = await import('../../src/keyboard.js');

let off: () => void;
beforeEach(() => {
  freshStore();
  off = installKeyHandlers({ store, api: { call } as never, bridge });
});
afterEach(() => off());

test('Esc in the new-robot dialog closes the dialog and leaves the map card open', () => {
  store.getState().focus('c0');
  store.getState().setNamingRobot(true);
  render(<NewRobot />);
  fireEvent.keyDown(screen.getByTestId('new-robot-name'), { key: 'Escape' });
  expect(store.getState().namingRobot).toBe(false);
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

test.each([
  ['new-robot-close', () => store.getState().setNamingRobot(true), <NewRobot />, () => store.getState().namingRobot],
  ['mission-prompt-close', () => store.getState().setMissionPrompt(true), <MissionPrompt />, () => store.getState().missionPrompt],
  ['confirm-close-close', () => store.getState().setClosingRobot('c0'), <ConfirmClose />, () => store.getState().closingRobot],
  ['confirm-sleep-close', () => store.getState().setSleepingRobot('c0'), <ConfirmSleep />, () => store.getState().sleepingRobot],
  ['confirm-delete-island-close', () => store.getState().setDeletingIsland('i_a'), <ConfirmDeleteIsland />, () => store.getState().deletingIsland],
] as const)('the × at %s closes its dialog and does nothing else', (testid, open, dialog, shown) => {
  open();
  render(dialog);
  fireEvent.click(screen.getByTestId(testid));
  expect(shown()).toBeFalsy();
  expect(call).not.toHaveBeenCalled();
});

test('the new-robot key sets a typed mission prompt aside for the next open, and Esc gives it up', async () => {
  const keys = { store, api: { call } as never, bridge };
  const text = () => (screen.getByTestId('mission-prompt-text') as HTMLTextAreaElement).value;
  store.getState().setMissionPrompt(true);
  render(<MissionPrompt />);
  fireEvent.change(screen.getByTestId('mission-prompt-text'), { target: { value: 'tidy the docs' } });
  await act(() => dispatchKey({ type: 'newRobot' }, keys));
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
