// @vitest-environment jsdom
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, expect, test, vi } from 'vitest';
import { call, freshStore, store } from './harness.js';

vi.mock('../../src/boot.js', async () => (await import('./harness.js')).bootModule());

const { Sidebar } = await import('../../src/Sidebar.js');
const { ContextMenu } = await import('../../src/ContextMenu.js');

beforeEach(() => {
  freshStore();
  render(<><Sidebar /><ContextMenu /></>);
});

const star = (id: string, n: number) => act(() => store.getState().applyPatch([{ op: 'add', path: `/characters/${id}/star`, value: n }]));
const starredRows = () => within(screen.getByTestId('sb-starred')).queryAllByTestId(/^sb-star-c/).map((el) => el.getAttribute('data-testid'));

test('the Starred section shows only once a character is starred', () => {
  expect(screen.queryByTestId('sb-starred')).toBeNull();
  star('c1', 0);
  expect(screen.getByTestId('sb-starred')).toBeTruthy();
});

test('starred characters stand above the islands in star order, each with its island', () => {
  star('c1', 1);
  star('c2', 0);
  expect(starredRows()).toEqual(['sb-star-c2', 'sb-star-c1']);
  expect(screen.getByTestId('sb-star-c2').textContent).toContain('alpha');
  const list = screen.getByTestId('sidebar').querySelector('.sb-list')!;
  expect(list.firstElementChild).toBe(screen.getByTestId('sb-starred'));
  expect(screen.getByTestId('sb-char-c1')).toBeTruthy();
});

test('the star on a tree row stars the character, and on a starred row unstars it', () => {
  fireEvent.click(screen.getByTestId('sb-char-star-c0'));
  expect(call).toHaveBeenCalledWith('char.star', { id: 'c0' });
  expect(screen.getByTestId('sb-char-star-c0').getAttribute('aria-pressed')).toBe('false');
  star('c0', 0);
  expect(screen.getByTestId('sb-char-star-c0').getAttribute('aria-pressed')).toBe('true');
  fireEvent.click(screen.getByTestId('sb-star-toggle-c0'));
  expect(call).toHaveBeenLastCalledWith('char.unstar', { id: 'c0' });
});

test('a star click does not select the row', () => {
  fireEvent.click(screen.getByTestId('sb-char-star-c0'));
  expect(store.getState().selectedId).toBeUndefined();
});

test('a starred row selects its character, and the tree row shows it selected too', () => {
  star('c2', 0);
  fireEvent.click(screen.getByTestId('sb-star-c2'));
  expect(store.getState().selectedId).toBe('c2');
  expect(screen.getByTestId('sb-star-c2').getAttribute('data-selected')).toBe('true');
  expect(screen.getByTestId('sb-char-c2').getAttribute('data-selected')).toBe('true');
});

test('folding Starred hides its rows, keeps its count and what wants the user, and is remembered', () => {
  star('c1', 0);
  star('c2', 1);
  act(() => store.getState().applyPatch([{ op: 'replace', path: '/characters/c2/unread', value: true }]));
  fireEvent.click(screen.getByTestId('sb-starred-toggle'));
  expect(starredRows()).toEqual([]);
  expect(screen.getByTestId('sb-starred').textContent).toContain('2');
  expect(screen.getByTestId('sb-starred-attention').textContent).toBe('1');
  expect(store.getState().sections['sidebar.starred']?.shut).toBe(true);
});

test('the character menu offers Star, or Unstar once starred', () => {
  fireEvent.contextMenu(screen.getByTestId('sb-char-c0'), { clientX: 40, clientY: 90 });
  fireEvent.click(screen.getByTestId('menu-star'));
  expect(call).toHaveBeenCalledWith('char.star', { id: 'c0' });
  star('c0', 0);
  fireEvent.contextMenu(screen.getByTestId('sb-char-c0'), { clientX: 40, clientY: 90 });
  fireEvent.click(screen.getByTestId('menu-unstar'));
  expect(call).toHaveBeenLastCalledWith('char.unstar', { id: 'c0' });
});

test('a Star picked after the character was starred elsewhere sends nothing', () => {
  fireEvent.contextMenu(screen.getByTestId('sb-char-c0'), { clientX: 40, clientY: 90 });
  star('c0', 0);
  fireEvent.click(screen.getByTestId('menu-star'));
  expect(call).not.toHaveBeenCalledWith('char.star', expect.anything());
});

test('a Finder file over a starred character outlines its starred row, and a reorder over its tree row does not', () => {
  star('c2', 0);
  const row = screen.getByTestId('sb-star-c2');
  expect(row.getAttribute('data-drop')).toBe('char:c2');
  act(() => store.getState().setDropHover({ kind: 'char', id: 'c2' }));
  expect(row.getAttribute('data-drop-hover')).toBe('true');
  act(() => store.getState().setDropHover({ kind: 'char', id: 'c2', after: true }));
  expect(row.getAttribute('data-drop-hover')).toBe('false');
});
