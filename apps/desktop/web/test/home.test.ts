import { describe, expect, it } from 'vitest';
import type { Cell, FleetState, Island } from '@archipelago/protocol';
import { homeBox, homeCellToScreen, homeCrew, homeReserve, homeSlotAt, inHomeBox } from '../src/map/home.js';
import type { Drag } from '../src/map/types.js';
import { theme } from '../src/theme.js';
import { chr, fleet, isl } from './fixtures.js';

const home = isl('home', 'mission control', 0, { kind: 'home', size: { w: 8, h: 4 }, seed: 7 });
const host = { w: 1280, h: 800 };

describe('home geometry', () => {
  it('centres the land and shows the top three cells', () => {
    const b = homeBox(home, host);
    expect(b).toEqual({ x: (1280 - 8 * 44) / 2, y: 800 - 132, w: 8 * 44, h: 132 });
    expect(inHomeBox(b, { x: 640, y: 700 })).toBe(true);
    expect(inHomeBox(b, { x: 640, y: 600 })).toBe(false);
    expect(inHomeBox(b, { x: 100, y: 700 })).toBe(false);
  });
  it('moves with the shift the islet asks for', () => {
    const island = { size: { w: 17, h: 4 } } as Island;
    expect(homeBox(island, { w: 1120, h: 800 }, -154).x).toBe(homeBox(island, { w: 1120, h: 800 }).x - 154);
  });
  it('snaps a pointer to the nearest slot on the crew row', () => {
    const b = homeBox(home, host);
    expect(homeSlotAt(home, b, { x: b.x + 1.5 * 44 })).toEqual({ x: 1, y: 1 });
    expect(homeSlotAt(home, b, { x: b.x + 2.9 * 44 })).toEqual({ x: 1, y: 1 });
    expect(homeSlotAt(home, b, { x: b.x + 3.2 * 44 })).toEqual({ x: 4, y: 1 });
    expect(homeSlotAt(home, b, { x: b.x + 7.9 * 44 })).toEqual({ x: 4, y: 1 });
    expect(homeSlotAt(home, b, { x: b.x - 50 })).toEqual({ x: 1, y: 1 });
  });
  it('maps a home cell to screen px at scale 1', () => {
    const b = homeBox(home, host);
    expect(homeCellToScreen(b, { x: 1, y: 1 })).toEqual({ x: b.x + 44, y: b.y + 44 });
  });
  it('reserves the row plus half a cell of water, open or collapsed', () => {
    expect(theme.home.water).toBe(theme.cell / 2);
    expect(homeReserve(false)).toBe(132 + 28 + 28 + theme.home.water);
    expect(homeReserve(true)).toBe(16 + 28 + theme.home.water);
  });
});

const crewed = (): FleetState => {
  const f = fleet();
  f.characters.h1 = chr('h1', 'home', { x: 1, y: 1 });
  return f;
};
const dragging = (id: string, over?: { islandId: string; local: Cell; free: boolean }): Drag =>
  ({ kind: 'figure', id, cell: { x: 0, y: 0 }, over });

describe('home crew', () => {
  it('is the crew itself when nothing is dragged', () => {
    expect(homeCrew(crewed(), undefined).map((c) => c.id)).toEqual(['h1']);
  });
  it('keeps a crew member dragged within home, once', () => {
    expect(homeCrew(crewed(), dragging('h1', { islandId: 'home', local: { x: 4, y: 1 }, free: true })).map((c) => c.id)).toEqual(['h1']);
  });
  it('drops a crew member dragged out over the world', () => {
    expect(homeCrew(crewed(), dragging('h1', { islandId: 'i_b', local: { x: 2, y: 1 }, free: true }))).toEqual([]);
  });
  it('takes in a world character dragged over home, once', () => {
    expect(homeCrew(crewed(), dragging('c0', { islandId: 'home', local: { x: 4, y: 1 }, free: true })).map((c) => c.id)).toEqual(['h1', 'c0']);
  });
  it('ignores a visitor that no longer exists', () => {
    expect(homeCrew(crewed(), dragging('gone', { islandId: 'home', local: { x: 4, y: 1 }, free: true })).map((c) => c.id)).toEqual(['h1']);
  });
});
