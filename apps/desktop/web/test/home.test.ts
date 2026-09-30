import { describe, expect, it } from 'vitest';
import type { Cell, FleetState, Island } from '@svall/protocol';
import { fitWithHome, homeBlocks, homeBox, homeCap, homeCellToScreen, homeCrew, homeFull, homeReserve, homeSlotAt, inHomeBox } from '../src/map/home.js';
import { cardScale, crewOf, mapIslands } from '../src/map/layout.js';
import { placeIslet } from '../src/map/resources.js';
import type { Drag } from '../src/map/types.js';
import { theme } from '../src/theme.js';
import { chr, fleet, isl } from './fixtures.js';

const home = isl('home', 'mission control', 0, { kind: 'home', size: { w: 8, h: 4 }, seed: 7 });
const host = { w: 1280, h: 800 };

describe('home geometry', () => {
  it('centres the land and shows the top three cells', () => {
    const b = homeBox(home, host);
    expect(b).toEqual({ x: (1280 - 8 * 44) / 2, y: 800 - 132, w: 8 * 44, h: 132, cell: 44 });
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
  it('gives a card joining a full row the slot past its last', () => {
    const b = homeBox(home, host);
    expect(homeSlotAt(home, b, { x: b.x + 7.5 * 44 }, true)).toEqual({ x: 7, y: 1 });
    expect(homeSlotAt(home, b, { x: b.x + 5.4 * 44 }, true)).toEqual({ x: 4, y: 1 });
  });
  it('is full for a card from elsewhere once every slot is taken, and never for its own crew', () => {
    const f = fleet();
    f.characters.h1 = chr('h1', 'home', { x: 1, y: 1 });
    expect(homeFull(f, f.islands.home, 'c0')).toBe(false);
    f.characters.h4 = chr('h4', 'home', { x: 4, y: 1 });
    expect(homeFull(f, f.islands.home, 'c0')).toBe(true);
    expect(homeFull(f, f.islands.home, 'h1')).toBe(false);
  });
  it('maps a home cell to screen px at scale 1', () => {
    const b = homeBox(home, host);
    expect(homeCellToScreen(b, { x: 1, y: 1 })).toEqual({ x: b.x + 44, y: b.y + 44 });
  });
  it('shrinks about its bottom centre, and picks slots and maps cells at that scale', () => {
    const wide = { ...home, size: { w: 17, h: 4 } };
    const b = homeBox(wide, host, -40, 0.5);
    expect(b).toEqual({ x: (1280 - 17 * 22) / 2 - 40, y: 800 - 66, w: 17 * 22, h: 66, cell: 22 });
    expect(inHomeBox(b, { x: b.x + b.w - 1, y: 799 })).toBe(true);
    expect(inHomeBox(b, { x: b.x + b.w - 1, y: 800 - 70 })).toBe(false);
    // the middle of slot 10 at half size is the middle of slot 4 at full size
    expect(homeSlotAt(wide, b, { x: b.x + 10.5 * 22 })).toEqual({ x: 10, y: 1 });
    expect(homeSlotAt(wide, b, { x: b.x + 4.5 * 22 })).toEqual({ x: 4, y: 1 });
    expect(homeCellToScreen(b, { x: 7, y: 1 })).toEqual({ x: b.x + 7 * 22, y: b.y + 22 });
  });
  it('blocks the row, the land and the islet, each padded by the water the fleet keeps', () => {
    const w = theme.home.water, place = placeIslet(host.w, 8 * 44, false);
    const land = homeBox(home, host, place.homeShift);
    const [row, ground, islet] = homeBlocks(home, host, { w: 300, h: 28 });
    expect(row).toEqual({ x: host.w / 2 + place.homeShift - 150 - w, w: 300 + 2 * w, top: host.h - homeReserve(false), bottom: host.h - 132 - 28 + w });
    expect(ground).toEqual({ x: land.x - w, w: land.w + 2 * w, top: land.y - w });
    expect(islet.x).toBeGreaterThan(ground.x + ground.w - 2 * w);
    expect(homeBlocks({ ...home, collapsed: true }, host, { w: 300, h: 28 })).toEqual([{ x: 640 - 150 - w, w: 300 + 2 * w, top: host.h - homeReserve(true), bottom: host.h - 16 + w }]);
    // a row wrapped to two lines grows upward, and the block with it
    expect(homeBlocks(home, host, { w: 300, h: 60 })[0].top).toBe(host.h - homeReserve(false, 60));
  });
  it('blocks a shrunk home where it is drawn, its row standing on the land it keeps', () => {
    const wide = { ...home, size: { w: 17, h: 4 } }, narrow = { w: 700, h: 800 };
    const w = theme.home.water, place = placeIslet(narrow.w, 17 * 44, false);
    expect(place.homeScale).toBeLessThan(1);
    const land = homeBox(wide, narrow, place.homeShift, place.homeScale);
    const [row, ground, islet] = homeBlocks(wide, narrow, { w: 300, h: 28 });
    expect(row).toMatchObject({ top: narrow.h - homeReserve(false, 28, place.homeScale), bottom: narrow.h - 132 * place.homeScale - 28 + w });
    expect(ground).toEqual({ x: land.x - w, w: land.w + 2 * w, top: land.y - w });
    expect(islet.x).toBeGreaterThanOrEqual(ground.x + ground.w - 2 * w);
  });
  it('blocks a home capped by the map where it is drawn', () => {
    const w = theme.home.water, place = placeIslet(host.w, 8 * 44, false, 0.6);
    const [row, ground] = homeBlocks(home, host, { w: 300, h: 28 }, 0.6);
    expect(row.top).toBe(host.h - homeReserve(false, 28, 0.6));
    expect(ground).toEqual({ x: homeBox(home, host, place.homeShift, 0.6).x - w, w: 8 * 44 * 0.6 + 2 * w, top: host.h - 132 * 0.6 - w });
  });
  it('settles the cap where home cards match the cards of the map it leaves room for', () => {
    // a map that zooms out as home grows
    const scaleAt = (most: number) => 0.9 - 0.5 * most;
    const m = homeCap(scaleAt);
    expect(cardScale(scaleAt(m))).toBeCloseTo(m, 3);
    expect(homeCap(() => 0.9)).toBe(1);
    expect(homeCap(() => theme.scale.min)).toBeCloseTo(cardScale(theme.scale.min), 3);
  });
  it('reserves the row plus half a cell of water, open or collapsed', () => {
    expect(theme.home.water).toBe(theme.cell / 2);
    expect(homeReserve(false)).toBe(132 + 28 + 28 + theme.home.water);
    expect(homeReserve(true)).toBe(16 + 28 + theme.home.water);
    expect(homeReserve(false, 60)).toBe(132 + 28 + 60 + theme.home.water);
    // a shrunk home shows less land under its row
    expect(homeReserve(false, 28, 0.5)).toBe(66 + 28 + 28 + theme.home.water);
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

describe('fitting the map with mission control', () => {
  // a fleet far wider than it is tall zooms the map out under the card floor, so home shrinks with it
  const wide = () => {
    const f = fleet();
    return { islands: mapIslands(f).map((i, n) => ({ ...i, position: { x: n * 40, y: 0 } })), crew: crewOf(f) };
  };
  const row = { w: 400, h: 28 };

  it('reserves the room for the home it hands back to draw, whose cards stand as big as the islands\'', () => {
    const { islands, crew } = wide();
    const f = fitWithHome(islands, crew, host, home, row);
    expect(f.most).toBeLessThan(1);
    expect(f.most).toBeCloseTo(cardScale(f.fit.scale), 3);
    const drawn = placeIslet(host.w, home.size.w * theme.cell, false, f.most).homeScale;
    expect(f.win.h).toBe(host.h - homeReserve(false, row.h, drawn));
  });

  it('keeps the last fit while nothing that shapes it changes', () => {
    const { islands, crew } = wide();
    const first = fitWithHome(islands, crew, host, home, row);
    expect(fitWithHome(structuredClone(islands), structuredClone(crew), { ...host }, { ...home }, { ...row })).toBe(first);
  });

  it('fits again when anything the fit reads changes', () => {
    const { islands, crew } = wide();
    const [a, ...rest] = islands;
    const changed: Parameters<typeof fitWithHome>[] = [
      [[{ ...a, name: `${a.name} and more` }, ...rest], crew, host, home, row],
      [[{ ...a, position: { x: a.position.x, y: 1 } }, ...rest], crew, host, home, row],
      [[{ ...a, size: { w: a.size.w + 1, h: a.size.h } }, ...rest], crew, host, home, row],
      [[{ ...a, collapsed: true }, ...rest], crew, host, home, row],
      [islands, { ...crew, [a.id]: [{ x: 2, y: 2 }] }, host, home, row],
      [islands, crew, { ...host, w: host.w - 1 }, home, row],
      [islands, crew, { ...host, h: host.h - 1 }, home, row],
      [islands, crew, host, { ...home, size: { w: home.size.w + 3, h: home.size.h } }, row],
      [islands, crew, host, { ...home, collapsed: true }, row],
      [islands, crew, host, { ...home, position: { x: 0, y: 5 } }, row],
      [islands, crew, host, undefined, row],
      [islands, crew, host, home, { ...row, w: row.w + 1 }],
      [islands, crew, host, home, { ...row, h: row.h + 1 }],
    ];
    for (const args of changed) {
      const first = fitWithHome(islands, crew, host, home, row);
      expect(fitWithHome(...args)).not.toBe(first);
    }
  });

  it('solves nothing for a folded home or none; a folded one keeps the cap island cards stand at, to unfold at', () => {
    const { islands, crew } = wide();
    const folded = fitWithHome(islands, crew, host, { ...home, collapsed: true }, row);
    expect(folded.most).toBeLessThan(1);
    expect(folded.most).toBe(cardScale(folded.fit.scale));
    expect(fitWithHome(islands, crew, host, undefined, row).most).toBe(1);
  });
});
