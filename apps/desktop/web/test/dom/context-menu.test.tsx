// @vitest-environment jsdom
import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { bridge, freshStore, sent, shell, store } from './harness.js';

bridge.present = true;
vi.mock('../../src/boot.js', async () => (await import('./harness.js')).bootModule());

const { ContextMenu } = await import('../../src/ContextMenu.js');

const rename = vi.fn();
const remove = vi.fn();

beforeEach(() => {
  freshStore();
  rename.mockClear();
  remove.mockClear();
  render(<ContextMenu />);
  // jsdom lays nothing out, and a hole that measures as nothing is left out
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({ left: 40, top: 90, width: 150, height: 90 } as DOMRect);
  vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(150);
  vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(90);
});
afterEach(() => { vi.restoreAllMocks(); });

const open = (x = 40, y = 90, deletable = true) =>
  act(() => store.getState().openMenu({ x, y, items: [{ title: 'Rename', run: rename }, { title: 'Delete', danger: true, run: deletable ? remove : undefined }] }));
const key = (k: string) => act(() => { fireEvent.keyDown(window, { key: k }); });
const shown = () => screen.queryByTestId('context-menu');
const cutouts = () => sent.filter((m) => m.type === 'shell.cutout');

test('the menu lists the entries with Reload under a separator, and a pick closes it before it runs', () => {
  open();
  expect(screen.getAllByRole('menuitem').map((el) => el.textContent)).toEqual(['Rename', 'Delete', 'Reload']);
  expect(screen.getByRole('separator').nextElementSibling).toBe(screen.getByTestId('menu-reload'));
  expect(screen.getByTestId('menu-delete').dataset.danger).toBe('true');
  remove.mockImplementation(() => expect(store.getState().menu).toBeUndefined());
  fireEvent.click(screen.getByTestId('menu-delete'));
  expect(remove).toHaveBeenCalledOnce();
  expect(shown()).toBeNull();
});

test('a greyed entry stays put when pressed, and the menu stays open', () => {
  open(40, 90, false);
  expect(screen.getByTestId('menu-delete').getAttribute('aria-disabled')).toBe('true');
  fireEvent.click(screen.getByTestId('menu-delete'));
  expect(remove).not.toHaveBeenCalled();
  expect(shown()).not.toBeNull();
});

test('the menu takes the keys from a terminal and holds a hole in the surfaces until it closes', () => {
  open();
  expect(sent).toContainEqual({ type: 'term.focus' });
  expect(cutouts().at(-1)).toEqual({ type: 'shell.cutout', rects: [{ x: 40, y: 90, width: 150, height: 90 }], passive: [] });
  fireEvent.pointerDown(document.body);
  expect(shown()).toBeNull();
  expect(cutouts().at(-1)).toEqual({ type: 'shell.cutout', rects: [], passive: [] });
});

test('the arrows walk past a greyed entry and Enter picks, while the keys reach nothing behind the menu', () => {
  const behind = vi.fn();
  window.addEventListener('keydown', behind);
  try {
    open(40, 90, false);
    key('Enter');
    expect(shown()).not.toBeNull();
    key('ArrowUp');
    expect(screen.getByTestId('menu-reload').dataset.active).toBe('true');
    key('ArrowUp');
    expect(screen.getByTestId('menu-rename').dataset.active).toBe('true');
    key('ArrowDown');
    expect(screen.getByTestId('menu-reload').dataset.active).toBe('true');
    key('ArrowUp');
    key('Enter');
    expect(rename).toHaveBeenCalledOnce();
    expect(shown()).toBeNull();
    expect(behind).not.toHaveBeenCalled();
  } finally {
    window.removeEventListener('keydown', behind);
  }
});

test('Escape closes the menu unpicked and hands the keys back to the terminal on show', () => {
  act(() => { store.getState().setView('board'); store.getState().focus('c0'); });
  open();
  sent.length = 0;
  key('Escape');
  expect(shown()).toBeNull();
  expect(rename).not.toHaveBeenCalled();
  expect(sent).toContainEqual({ type: 'term.focus', id: 'c0' });
});

test('a press on a surface, a scroll and a press elsewhere on the page each close it unpicked', () => {
  for (const away of [() => shell({ type: 'shell.pressedAway' }), () => fireEvent.wheel(document.body), () => fireEvent.pointerDown(document.body)]) {
    open();
    act(away);
    expect(shown()).toBeNull();
  }
  open();
  fireEvent.pointerDown(screen.getByTestId('menu-rename'));
  fireEvent.wheel(screen.getByTestId('context-menu'));
  expect(shown()).not.toBeNull();
  expect(rename).not.toHaveBeenCalled();
  expect(remove).not.toHaveBeenCalled();
});

test('the menu opens down and right of the pointer, and flips where the window has no room', () => {
  open(40, 90);
  const box = screen.getByTestId('context-menu');
  expect([box.style.left, box.style.top]).toEqual(['40px', '90px']);
  open(window.innerWidth - 20, window.innerHeight - 20);
  expect(box.style.left).toBe(`${window.innerWidth - 150 - 8}px`);
  expect(box.style.top).toBe(`${window.innerHeight - 20 - 90}px`);
});
