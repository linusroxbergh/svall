// @vitest-environment jsdom
import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, expect, test, vi } from 'vitest';
import { bridge, call, freshStore, sent, store } from './harness.js';

vi.mock('../../src/boot.js', async () => (await import('./harness.js')).bootModule());

const { Sidebar } = await import('../../src/Sidebar.js');
const { ContextMenu } = await import('../../src/ContextMenu.js');

beforeEach(() => {
  bridge.present = true;
  freshStore();
  render(<><Sidebar /><ContextMenu /></>);
});

// fireEvent returns false when a listener called preventDefault, which is what keeps WebKit's own menu away
const rightClick = (testid: string): boolean => !fireEvent.contextMenu(screen.getByTestId(testid), { clientX: 40, clientY: 90 });

const pick = (title: string) => fireEvent.click(screen.getByTestId(`menu-${title}`));
const entries = () => screen.getAllByRole('menuitem').map((el) => [el.textContent, el.getAttribute('aria-disabled') !== 'true']);
const menu = (deletable: boolean) => [['Rename', true], ['Delete', deletable], ['Reload', true]];

test('a character row opens the app menu at the pointer, and Delete opens the delete confirmation', () => {
  expect(rightClick('sb-char-c0')).toBe(true);
  expect(entries()).toEqual(menu(true));
  pick('delete');
  expect(store.getState().closingCharacter).toBe('c0');
  expect(call).not.toHaveBeenCalled();
});

test('an empty island offers Delete, which opens the island confirmation', () => {
  rightClick('sb-island-i_e');
  expect(entries()).toEqual(menu(true));
  pick('delete');
  expect(store.getState().deletingIsland).toBe('i_e');
});

test('an island with characters shows Delete greyed out, as the daemon refuses it', () => {
  rightClick('sb-island-i_b');
  expect(entries()).toEqual(menu(false));
});

test('Rename takes the keys from any terminal into a name field on the character row, and Enter saves the new name', () => {
  rightClick('sb-char-c0');
  expect(sent).toContainEqual({ type: 'term.focus' });
  pick('rename');
  const field = screen.getByTestId('char-name-input') as HTMLInputElement;
  expect(document.activeElement).toBe(field);
  fireEvent.change(field, { target: { value: '  auth fix ' } });
  fireEvent.keyDown(field, { key: 'Enter' });
  expect(call).toHaveBeenCalledWith('char.update', { id: 'c0', name: 'auth fix' });
  expect(screen.queryByTestId('char-name-input')).toBeNull();
});

test('Escape, or a name left as it was, leaves the character unrenamed', () => {
  rightClick('sb-char-c0');
  pick('rename');
  fireEvent.change(screen.getByTestId('char-name-input'), { target: { value: 'other' } });
  fireEvent.keyDown(screen.getByTestId('char-name-input'), { key: 'Escape' });
  expect(screen.queryByTestId('char-name-input')).toBeNull();
  rightClick('sb-char-c0');
  pick('rename');
  fireEvent.blur(screen.getByTestId('char-name-input'));
  expect(call).not.toHaveBeenCalled();
});

test('Rename puts an island row into its name field', () => {
  rightClick('sb-island-i_b');
  pick('rename');
  const field = screen.getByTestId('island-name-input');
  fireEvent.change(field, { target: { value: 'gamma' } });
  fireEvent.blur(field);
  expect(call).toHaveBeenCalledWith('island.update', { id: 'i_b', name: 'gamma' });
});

test('mission control and a row being renamed keep the default menu', () => {
  expect(rightClick('sb-island-home')).toBe(false);
  fireEvent.doubleClick(screen.getByTestId('sb-island-i_a'));
  expect(rightClick('island-name-input')).toBe(false);
  rightClick('sb-char-c0');
  pick('rename');
  expect(rightClick('char-name-input')).toBe(false);
  expect(screen.queryByTestId('context-menu')).toBeNull();
});

test('a page without the shell draws the same menu', () => {
  bridge.present = false;
  expect(rightClick('sb-char-c2')).toBe(true);
  expect(entries()).toEqual(menu(true));
});

test('a second right-click replaces the menu, and a pick answers that one', () => {
  rightClick('sb-island-i_e');
  rightClick('sb-char-c2');
  expect(screen.getAllByTestId('context-menu')).toHaveLength(1);
  pick('delete');
  expect(store.getState().closingCharacter).toBe('c2');
  expect(store.getState().deletingIsland).toBeUndefined();
});

test('the sidebar holds its animation still while the app is in the background', () => {
  const paused = () => screen.getByTestId('sidebar').getAttribute('data-paused');
  expect(paused()).toBe('false');
  act(() => store.getState().setActive(false));
  expect(paused()).toBe('true');
});
