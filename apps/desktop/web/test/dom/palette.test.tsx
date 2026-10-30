// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { bridge, call, freshStore, store } from './harness.js';

vi.mock('../../src/boot.js', async () => (await import('./harness.js')).bootModule());

const { CommandPalette } = await import('../../src/CommandPalette.js');
const { dispatchKey, installKeyHandlers } = await import('../../src/keyboard.js');

let off: () => void;
beforeEach(() => {
  freshStore();
  off = installKeyHandlers({ store, api: { call } as never, bridge });
});
afterEach(() => off());

const labels = () => screen.queryAllByTestId('palette-row').map((r) => r.textContent);
const query = () => screen.getByTestId('palette-query');

test('Cmd+Shift+P opens the palette and closes it again, closing any other dialog first', async () => {
  store.getState().setMissionPrompt(true);
  await dispatchKey({ type: 'palette' }, { store, api: { call } as never, bridge });
  expect(store.getState().palette).toBe(true);
  expect(store.getState().missionPrompt).toBe(false);
  fireEvent.keyDown(document.body, { key: 'p', metaKey: true, shiftKey: true });
  expect(store.getState().palette).toBe(false);
});

test('lists every command with the key it answers to now, and leaves out itself and Quit', () => {
  store.getState().setSettings({ bindings: { newRobot: 'cmd+shift+n', nextRobot: null } });
  store.getState().setPalette(true);
  render(<CommandPalette />);
  expect(labels()).toContain('New robot⌘⇧N');
  expect(labels()).toContain('Next robot');
  expect(labels()).toContain('Keyboard shortcuts');
  expect(labels().some((l) => l?.startsWith('Commands') || l?.startsWith('Quit'))).toBe(false);
});

test('typed words narrow the list in any order, and the arrows and Enter run the one picked', () => {
  store.getState().setPalette(true);
  render(<CommandPalette />);
  fireEvent.change(query(), { target: { value: 'pane files' } });
  expect(labels()).toEqual(['Files pane⌘3']);
  fireEvent.change(query(), { target: { value: 'robot' } });
  expect(labels()).toEqual(['New robot⌘T', 'Previous robot⌘K', 'Next robot⌘J']);
  fireEvent.keyDown(query(), { key: 'ArrowDown' });
  fireEvent.keyDown(query(), { key: 'ArrowDown' });
  fireEvent.keyDown(query(), { key: 'ArrowDown' });
  fireEvent.keyDown(query(), { key: 'Enter' });
  expect(store.getState().palette).toBe(false);
  expect(store.getState().namingRobot).toBe(true);
});

test('Esc closes the palette and leaves the card under it open; nothing matching says so', () => {
  store.getState().focus('c0');
  store.getState().setPalette(true);
  render(<CommandPalette />);
  fireEvent.change(query(), { target: { value: 'zzz' } });
  expect(screen.getByTestId('palette-none')).toBeTruthy();
  fireEvent.keyDown(query(), { key: 'Escape' });
  expect(store.getState().palette).toBe(false);
  expect(store.getState().card).toBe('c0');
});

test('a click runs the command', () => {
  store.getState().setPalette(true);
  render(<CommandPalette />);
  fireEvent.change(query(), { target: { value: 'settings' } });
  fireEvent.click(screen.getByTestId('palette-row'));
  expect(store.getState().palette).toBe(false);
  expect(store.getState().settingsOpen).toBe(true);
});
