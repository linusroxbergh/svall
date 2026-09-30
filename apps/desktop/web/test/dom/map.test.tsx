// @vitest-environment jsdom
import './setup.js';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, expect, test, vi } from 'vitest';
import { setAppStore } from '../../src/hooks.js';
import { fitWithHome } from '../../src/map/home.js';
import { crewOf, mapIslands } from '../../src/map/layout.js';
import { createAppStore, type AppStore } from '../../src/store/index.js';
import { theme } from '../../src/theme.js';
import { fleet, isl } from '../fixtures.js';

// reduced motion: a refit lands at once, so nothing waits on animation frames
window.matchMedia ??= ((q: string) => ({ matches: true, media: q, addEventListener() {}, removeEventListener() {} })) as never;
Element.prototype.setPointerCapture ??= function () {};
Element.prototype.hasPointerCapture ??= function () { return true; };

const call = vi.fn((method: string, _params?: unknown) => Promise.resolve(method === 'island.create' ? { id: 'i_new' } : {}));
const bridge = { present: false, send() {}, onMessage: () => () => {} };
let store: AppStore;
vi.mock('../../src/boot.js', () => ({
  app: { get store() { return store; }, bridge, api: () => ({ call }), manager: () => ({ move() {}, show: () => Promise.resolve(), hide() {} }), browser: () => ({ move() {} }) },
  deps: () => ({ api: { call }, store, bridge }),
}));
vi.mock('../../src/resources/Shelf.js', () => ({ ResourcesLayer: () => null }));

const { Map } = await import('../../src/map/Map.js');
const { DBL_CLICK_MS } = await import('../../src/map/interactions.js');

beforeEach(() => {
  call.mockClear();
  store = createAppStore();
  setAppStore(store);
  const f = fleet();
  // mission control well below the islands, so a drag to the right is always legal
  f.islands.home.position = { x: 0, y: 20 };
  store.getState().setFleet(f);
});

const methods = () => call.mock.calls.map((c) => c[0]);
const press = (el: Element) => {
  fireEvent.pointerDown(el, { pointerId: 1 });
  fireEvent.pointerUp(screen.getByTestId('map'), { pointerId: 1 });
  fireEvent.click(el);
};

test('a double click on a map button makes no island, even right after a press on the water', async () => {
  render(<Map />);
  await act(async () => {});
  press(document.querySelector('.map-sea')!);
  const crew = screen.getByTestId('home-new');
  press(crew);
  press(crew);
  fireEvent.doubleClick(crew);
  expect(methods()).not.toContain('island.create');
});

test('a double click on open water makes an island there', async () => {
  render(<Map />);
  await act(async () => {});
  const sea = document.querySelector('.map-sea')!;
  press(sea);
  press(sea);
  fireEvent.doubleClick(sea);
  expect(methods()).toContain('island.create');
});

test('mission control puts arrange beside its name, as bright as the buttons that start an agent', async () => {
  render(<Map />);
  await act(async () => {});
  const row = [...screen.getByTestId('home-row').children].map((el) => el.getAttribute('data-testid'));
  expect(row.slice(0, 5)).toEqual(['home-toggle', 'island-label-home', 'home-arrange', 'home-action-update info', 'home-action-status']);
  expect(screen.getByTestId('home-arrange').className).toBe('hact');
});

test('the arrange key arranges the fleet once, to the shape of the map', async () => {
  // jsdom lays nothing out; arrange measures the map
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get: () => 1200 });
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get: () => 800 });
  try {
    render(<Map />);
    await act(async () => {});
    call.mockClear();
    await act(async () => { store.getState().askArrange(); });
    const arranged = call.mock.calls.filter((c) => c[0] === 'island.arrange');
    expect(arranged).toHaveLength(1);
    expect((arranged[0][1] as { aspect: number }).aspect).toBeGreaterThan(1);
    expect(store.getState().arrangeAsk).toBe(false);
  } finally {
    delete (HTMLElement.prototype as { clientWidth?: number }).clientWidth;
    delete (HTMLElement.prototype as { clientHeight?: number }).clientHeight;
  }
});

test('the fleet arranges each time the map gets room back from its card, and on a return from the board', async () => {
  let width = 1200;
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get: () => width });
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get: () => 800 });
  const arranges = () => methods().filter((m) => m === 'island.arrange').length;
  store.getState().setStatus('online');
  try {
    const { unmount } = render(<Map />);
    await act(async () => {});
    expect(arranges()).toBe(0);
    await act(async () => { store.getState().focus('c0'); });
    await act(async () => { store.getState().toggleCardSize(); });
    expect(arranges()).toBe(0);
    await act(async () => { store.getState().toggleCardSize(); });
    expect(arranges()).toBe(1);
    await act(async () => { store.getState().closeCard(); });
    expect(arranges()).toBe(2);

    unmount();
    await act(async () => { store.getState().setView('board'); store.getState().setView('map'); });
    render(<Map />);
    await act(async () => {});
    expect(arranges()).toBe(3);
    expect(store.getState().arrangeAsk).toBe(false);

    // a map squeezed too narrow keeps the fleet where it stands
    width = 300;
    await act(async () => { store.getState().focus('c0'); });
    await act(async () => { store.getState().closeCard(); });
    expect(arranges()).toBe(3);
  } finally {
    delete (HTMLElement.prototype as { clientWidth?: number }).clientWidth;
    delete (HTMLElement.prototype as { clientHeight?: number }).clientHeight;
  }
});

test('a click on the sea that closes the card arranges once the click sequence is over, and never while svalld is offline', async () => {
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get: () => 1200 });
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get: () => 800 });
  const arranges = () => methods().filter((m) => m === 'island.arrange').length;
  store.getState().setStatus('online');
  try {
    render(<Map />);
    await act(async () => {});
    await act(async () => { store.getState().focus('c0'); });
    press(document.querySelector('.map-sea')!);
    expect(store.getState().card).toBeUndefined();
    // the fleet stands still under a press that may yet become a double click
    expect(arranges()).toBe(0);
    await act(async () => { await new Promise((r) => setTimeout(r, DBL_CLICK_MS + 50)); });
    expect(arranges()).toBe(1);

    act(() => store.getState().setStatus('offline'));
    await act(async () => { store.getState().focus('c0'); });
    await act(async () => { store.getState().closeCard(); });
    expect(arranges()).toBe(1);
  } finally {
    delete (HTMLElement.prototype as { clientWidth?: number }).clientWidth;
    delete (HTMLElement.prototype as { clientHeight?: number }).clientHeight;
  }
});

test('a side panel opened inside a click sequence refits the map once the sequence is over', async () => {
  let width = 1200;
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get: () => width });
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get: () => 800 });
  try {
    render(<Map />);
    await act(async () => {});
    const world = () => document.querySelector<HTMLElement>('.map-world')!.style.transform;
    const before = world();
    press(document.querySelector('.map-sea')!);
    width = 700;
    act(() => store.getState().toggleSideCard(true));
    // the world stands still under a press that may yet become a double click
    expect(world()).toBe(before);
    await act(async () => { await new Promise((r) => setTimeout(r, DBL_CLICK_MS + 50)); });
    expect(world()).not.toBe(before);
  } finally {
    delete (HTMLElement.prototype as { clientWidth?: number }).clientWidth;
    delete (HTMLElement.prototype as { clientHeight?: number }).clientHeight;
  }
});

test('mission control unfolds at the size its fit kept room for, though the map stands still', async () => {
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get: () => 1280 });
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get: () => 800 });
  // two islands far apart and clear of mission control, folded or not: the map fits their width and rests the same either way
  const f = { ...fleet(), characters: {} };
  f.islands = { i_w: isl('i_w', 'w', 0, { size: { w: 7, h: 5 } }), i_e: isl('i_e', 'e', 46, { position: { x: 46, y: 10 }, size: { w: 7, h: 5 } }),
    home: { ...f.islands.home, position: { x: 0, y: 20 }, collapsed: true } };
  store.getState().setFleet(f);
  try {
    render(<Map />);
    await act(async () => {});
    const world = () => document.querySelector<HTMLElement>('.map-world')!.style.transform;
    const before = world();
    const open = { ...f, islands: { ...f.islands, home: { ...f.islands.home, collapsed: false } } };
    await act(async () => { store.getState().setFleet(open); });
    expect(world()).toBe(before);
    const { most } = fitWithHome(mapIslands(open), crewOf(open), { w: 1280, h: 800 }, open.islands.home, { w: 0, h: theme.home.row });
    expect(most).toBeLessThan(1);
    expect(document.querySelector<HTMLElement>('.home .island')!.style.transform).toBe(`scale(${most})`);
  } finally {
    delete (HTMLElement.prototype as { clientWidth?: number }).clientWidth;
    delete (HTMLElement.prototype as { clientHeight?: number }).clientHeight;
  }
});

const dragRight = (islandId: string) => {
  const map = screen.getByTestId('map');
  fireEvent.pointerDown(screen.getByTestId(`island-label-${islandId}`), { pointerId: 1, clientX: 100, clientY: 100 });
  fireEvent.pointerMove(map, { pointerId: 1, clientX: 400, clientY: 100 });
  fireEvent.pointerUp(map, { pointerId: 1, clientX: 400, clientY: 100 });
  return call.mock.calls.at(-1)![1] as { id: string; position: { x: number; y: number } };
};
const land = (p: { id: string; position: { x: number; y: number } }) =>
  act(() => { store.getState().applyPatch([{ op: 'replace', path: `/islands/${p.id}/position`, value: p.position }]); });
const settled = async () => { await act(async () => { await new Promise((r) => setTimeout(r, 400)); }); };
// an island is held where it was dropped until the fleet's answer settles
const held = (id: string) => document.querySelector(`[data-drop="island:${id}"]`)?.getAttribute('data-dragging');

test('an island dropped while the last one is still settling settles, and so does every drop after it', async () => {
  render(<Map />);
  await act(async () => {});
  land(dragRight('i_e'));
  // the second drop lands inside the first one's settle window
  land(dragRight('i_b'));
  await settled();
  expect(held('i_b')).toBe('false');
  land(dragRight('i_a'));
  await settled();
  expect(held('i_a')).toBe('false');
});

test('the map holds its animation still while the app is in the background or a full card covers it', async () => {
  render(<Map />);
  await act(async () => {});
  const paused = () => screen.getByTestId('map').getAttribute('data-paused');
  expect(paused()).toBe('false');
  act(() => store.getState().setActive(false));
  expect(paused()).toBe('true');
  act(() => store.getState().setActive(true));
  await act(async () => { store.getState().focus('c0'); });
  expect(paused()).toBe('false');
  await act(async () => { store.getState().toggleCardSize(); });
  expect(paused()).toBe('true');
  await act(async () => { store.getState().closeCard(); });
  expect(paused()).toBe('false');
});
