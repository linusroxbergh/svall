// @vitest-environment jsdom
import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, expect, test, vi } from 'vitest';
import type { ToShell } from '../../src/bridge.js';
import { chr, fleet } from '../fixtures.js';
import { bridge, call, freshStore, sent, shell, store } from './harness.js';

window.matchMedia ??= ((q: string) => ({ matches: true, media: q, addEventListener() {}, removeEventListener() {} })) as never;
Element.prototype.setPointerCapture ??= function () {};
Element.prototype.hasPointerCapture ??= function () { return true; };

bridge.present = true;
vi.mock('../../src/boot.js', async () => (await import('./harness.js')).bootModule());
vi.mock('../../src/resources/Shelf.js', () => ({ ResourcesLayer: () => null }));

const { Map } = await import('../../src/map/Map.js');

beforeEach(async () => {
  freshStore();
  const f = fleet();
  f.islands.home.position = { x: 0, y: 20 };
  f.characters.h0 = chr('h0', 'home', { x: 0, y: 0 });
  store.getState().setFleet(f);
  render(<Map />);
  await act(async () => {});
});

// fireEvent returns false when a listener called preventDefault, which is what keeps WebKit's own menu away
const rightClick = (testid: string): boolean => !fireEvent.contextMenu(screen.getByTestId(testid), { clientX: 40, clientY: 90 });
const menu = (enabled: boolean): ToShell[] => [{ type: 'menu', x: 40, y: 90, items: [{ id: '0', title: 'Delete', enabled }] }];

test('a character on the map offers Delete, which opens the delete confirmation', () => {
  expect(rightClick('token-c0')).toBe(true);
  expect(sent).toEqual(menu(true));
  shell({ type: 'menu.pick', id: '0' });
  expect(store.getState().closingCharacter).toBe('c0');
  expect(call).not.toHaveBeenCalled();
});

test('a crew member on mission control offers Delete too', () => {
  rightClick('token-h0');
  shell({ type: 'menu.pick', id: '0' });
  expect(store.getState().closingCharacter).toBe('h0');
});

test('an empty island offers Delete from its land and its label, which opens the island confirmation', () => {
  rightClick('island-i_e');
  expect(sent).toEqual(menu(true));
  shell({ type: 'menu.pick', id: '0' });
  expect(store.getState().deletingIsland).toBe('i_e');
  sent.length = 0;
  rightClick('island-label-i_e');
  expect(sent).toEqual(menu(true));
});

test('an island with characters shows Delete greyed out, as the daemon refuses it', () => {
  rightClick('island-label-i_b');
  expect(sent).toEqual(menu(false));
});

test('mission control keeps the default menu', () => {
  expect(rightClick('island-label-home')).toBe(false);
  expect(sent).toEqual([]);
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
