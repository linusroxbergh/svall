// @vitest-environment jsdom
import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, expect, test, vi } from 'vitest';
import { chr, fleet } from '../fixtures.js';
import { bridge, call, freshStore, store } from './harness.js';

window.matchMedia ??= ((q: string) => ({ matches: true, media: q, addEventListener() {}, removeEventListener() {} })) as never;
Element.prototype.setPointerCapture ??= function () {};
Element.prototype.hasPointerCapture ??= function () { return true; };

bridge.present = true;
vi.mock('../../src/boot.js', async () => (await import('./harness.js')).bootModule());
vi.mock('../../src/resources/Shelf.js', () => ({ ResourcesLayer: () => null }));

const { Map } = await import('../../src/map/Map.js');
const { ContextMenu } = await import('../../src/ContextMenu.js');

beforeEach(async () => {
  freshStore();
  const f = fleet();
  f.islands.home.position = { x: 0, y: 20 };
  f.characters.h0 = chr('h0', 'home', { x: 0, y: 0 });
  store.getState().setFleet(f);
  render(<><Map /><ContextMenu /></>);
  await act(async () => {});
});

// fireEvent returns false when a listener called preventDefault, which is what keeps WebKit's own menu away
const rightClick = (testid: string): boolean => !fireEvent.contextMenu(screen.getByTestId(testid), { clientX: 40, clientY: 90 });
const pick = () => fireEvent.click(screen.getByTestId('menu-delete'));
const entries = () => screen.getAllByRole('menuitem').map((el) => [el.textContent, el.getAttribute('aria-disabled') !== 'true']);
const menu = (deletable: boolean) => [['Delete', deletable], ['Reload', true]];

test('a character on the map offers Star and Delete, which opens the delete confirmation', () => {
  expect(rightClick('token-c0')).toBe(true);
  expect(entries()).toEqual([['Star', true], ...menu(true)]);
  pick();
  expect(store.getState().closingCharacter).toBe('c0');
  expect(call).not.toHaveBeenCalled();
});

test('a crew member on mission control offers Delete too', () => {
  rightClick('token-h0');
  pick();
  expect(store.getState().closingCharacter).toBe('h0');
});

test('an empty island offers Delete from its land and its label, which opens the island confirmation', () => {
  rightClick('island-i_e');
  expect(entries()).toEqual(menu(true));
  pick();
  expect(store.getState().deletingIsland).toBe('i_e');
  rightClick('island-label-i_e');
  expect(entries()).toEqual(menu(true));
});

test('an island with characters shows Delete greyed out, as the daemon refuses it', () => {
  rightClick('island-label-i_b');
  expect(entries()).toEqual(menu(false));
});

test('mission control keeps the default menu', () => {
  expect(rightClick('island-label-home')).toBe(false);
  expect(screen.queryByTestId('context-menu')).toBeNull();
});

test('a right press or a control press on a card selects nothing', () => {
  for (const press of [{ button: 2 }, { button: 0, ctrlKey: true }]) {
    fireEvent.pointerDown(screen.getByTestId('token-c0'), { pointerId: 1, ...press });
    fireEvent.pointerUp(screen.getByTestId('map'), { pointerId: 1, ...press });
  }
  expect(store.getState().selectedId).toBeUndefined();
  fireEvent.pointerDown(screen.getByTestId('token-c0'), { pointerId: 1 });
  fireEvent.pointerUp(screen.getByTestId('map'), { pointerId: 1 });
  expect(store.getState().selectedId).toBe('c0');
});

test('a right press puts away the hover card, so it stands under neither the menu nor the confirmation', async () => {
  vi.useFakeTimers();
  try {
    fireEvent.pointerEnter(screen.getByTestId('token-c0'));
    await act(async () => { vi.advanceTimersByTime(400); });
    expect(screen.queryByTestId('hover-card')).not.toBeNull();
    fireEvent.pointerDown(screen.getByTestId('token-c0'), { pointerId: 1, button: 2 });
    expect(screen.queryByTestId('hover-card')).toBeNull();
  } finally {
    vi.useRealTimers();
  }
});
