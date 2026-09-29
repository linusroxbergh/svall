import { describe, expect, it } from 'vitest';
import { ground, type Island } from '@svall/protocol';
import { cardScale, cellOwner, characterAt, clampPan, fitAll, fitFloor, labelScale, limitAt, mapIslands, onBlocks, roomOf, screenToCell, worldBounds, worldCell, worldToScreen, type Below, type Layout } from '../src/map/layout.js';
import { theme } from '../src/theme.js';
import { fleet } from './fixtures.js';

// fixture: three 6x4 islands at x = 0, 8, 16, all at y = 0 → footprint box x 0..22, y 0..4
// bounds grow it by 1.4 left and right, 1.3 above (the island label) and 1.3 below → { x: -1.4, y: -1.3, w: 24.8, h: 6.6 }
// world pixels at cell 44: ww = 24.8 * 44 = 1091.2, wh = 6.6 * 44 = 290.4
describe('world layout', () => {
  it('bounds cover every island plus the asymmetric label and card margins', () => {
    const b = worldBounds(mapIslands(fleet()));
    expect(b.x).toBe(-1.4);
    expect(b.y).toBe(-1.3);
    expect(b.w).toBeCloseTo(24.8, 10);
    expect(b.h).toBeCloseTo(6.6, 10);
    const empty = worldBounds([]);
    expect(empty.x).toBe(-1.4);
    expect(empty.y).toBe(-1.3);
    expect(empty.w).toBeCloseTo(8.8, 10);
    expect(empty.h).toBeCloseTo(6.6, 10);
  });

  it('fits continuously and centres the world both ways', () => {
    const islands = mapIslands(fleet());
    const l = fitAll(islands, { w: 1400, h: 900 });
    // min((1400 - 2*24)/1091.2, (900 - 56 - 0)/290.4) = min(1.239002…, 2.906336…)
    expect(l.tile).toBe(theme.cell);
    expect(l.scale).toBeCloseTo(1.2390029325513197, 10);
    expect(l.ox).toBeCloseTo(100.3225806451613, 6);     // (1400 - 1352)/2 + 1.4*44*scale
    expect(l.oy).toBeCloseTo(368.9677419354839, 6);     // 56 + (844 - 290.4*scale)/2 + 1.3*44*scale
    // the water left over is shared evenly either side, across and down
    const b = worldBounds(islands);
    expect(l.ox + b.x * theme.cell * l.scale).toBeCloseTo(24, 6);
    const top = l.oy + b.y * theme.cell * l.scale;
    expect(top - theme.fit.top).toBeCloseTo(900 - theme.fit.bottom - (top + b.h * theme.cell * l.scale), 6);
  });

  it('holds the ceiling and the floor', () => {
    const islands = mapIslands(fleet());
    expect(fitAll(islands, { w: 3000, h: 2000 }).scale).toBe(theme.scale.max);   // raw 2.6467 → 1.5
    const tiny = fitAll(islands, { w: 400, h: 300 });
    expect(tiny.scale).toBe(theme.scale.min);                                    // raw 0.2639 → 0.42
    expect(tiny.ox).toBeCloseTo(-3.28, 6);                                       // (400 - 458.304)/2 + 25.872
    expect(tiny.oy).toBeCloseTo(141.04, 6);                                      // 56 + (244 - 121.968)/2 + 1.3*44*0.42
  });

  it('reaches down to mission control, so the water above it is the fleet to spend', () => {
    const islands = mapIslands(fleet());                 // footprints end at y = 4
    // the row is the foot of the world: 8 + 1.3, with the cards hanging into the water above it
    expect(worldBounds(islands, 8).h).toBeCloseTo(9.3, 10);
    // a floor inside the fleet is no floor at all
    expect(worldBounds(islands, 2).h).toBeCloseTo(6.6, 10);
    // an island moved down within the floor leaves the fit alone, so it travels towards the foot of the map
    const moved = islands.map((i) => (i.id === 'i_a' ? { ...i, position: { x: i.position.x, y: 2 } } : i));
    expect(fitAll(moved, { w: 1400, h: 900 }, 8)).toEqual(fitAll(islands, { w: 1400, h: 900 }, 8));
  });

  it('measures a folded island by its pill, so its footprint does not sink the world past the row', () => {
    const islands = mapIslands(fleet());
    // folded on the row itself: the pill ends at y = 7, and no card hangs off it
    const folded = islands.map((i) => (i.id === 'i_a' ? { ...i, position: { x: i.position.x, y: 8 }, collapsed: true } : i));
    expect(worldBounds(folded, 8).h).toBeCloseTo(9.3, 10);
  });

  it('measures a folded island across by its pill, not the ground it would take back', () => {
    const islands = mapIslands(fleet()).map((i) => (i.id === 'i_e' ? { ...i, size: { w: 30, h: 4 }, collapsed: true } : i));
    const pill = ground(islands.find((i) => i.id === 'i_e')!);
    expect(worldBounds(islands).w).toBeCloseTo(pill.position.x + pill.size.w + 2.8, 10);
  });

  it('clamps a pan to the world edge and drops a pan on an axis that fits', () => {
    const islands = mapIslands(fleet());
    const win = { w: 1400, h: 900 };
    const fits = fitAll(islands, win);
    expect(clampPan(islands, fits, win, { x: 500, y: -500 }).x).toBeCloseTo(0, 6);
    expect(clampPan(islands, fits, win, { x: 500, y: -500 }).y).toBeCloseTo(0, 6);

    const small = { w: 400, h: 300 };
    const l = fitAll(islands, small);                    // world 458.3 x 122 px on screen at scale 0.42
    // x: 458.304 + 2*40 > 400 → clamped to [-69.152, 69.152]; y: 121.968 + 2*40 < 300 → re-centred to 0
    expect(clampPan(islands, l, small, { x: 1000, y: 0 }).x).toBeCloseTo(69.152, 6);
    expect(clampPan(islands, l, small, { x: -1000, y: 0 }).x).toBeCloseTo(-69.152, 6);
    expect(clampPan(islands, l, small, { x: 20, y: 0 }).x).toBeCloseTo(20, 6);
    expect(clampPan(islands, l, small, { x: 0, y: 999 }).y).toBeCloseTo(0, 6);
  });

  it('leaves the fit alone at every height a fitting world is centred at', () => {
    const islands = mapIslands(fleet());
    for (let h = 300; h <= 1200; h += 1) {
      const win = { w: 1400, h };
      const l = fitAll(islands, win, 6);
      expect(clampPan(islands, l, win, { x: 0, y: 0 }, 6)).toEqual({ x: 0, y: 0 });
    }
  });

  it('holds a card at its drawn size between the zoom floor and 1, and lets it follow the map outside', () => {
    expect(cardScale(theme.token.floor / 2)).toBeCloseTo(0.5, 10);
    expect(cardScale(theme.token.floor)).toBe(1);
    expect(cardScale(1)).toBe(1);
    expect(cardScale(1.5)).toBeCloseTo(1 + 0.5 * theme.token.grow, 10);
  });

  it('lets a label pill follow the map up to 1 and only a share of its growth past it', () => {
    expect(labelScale(0.5)).toBe(0.5);
    expect(labelScale(1)).toBe(1);
    expect(labelScale(1.5)).toBeCloseTo(1 + 0.5 * theme.label.grow, 10);
  });

  it('maps cells to screen and back', () => {
    const l = { scale: 2, tile: 16, ox: 100, oy: 50 };
    expect(worldToScreen(l, { x: 3, y: 1 })).toEqual({ x: 196, y: 82 });
    expect(screenToCell(l, { x: 196, y: 82 })).toEqual({ x: 3, y: 1 });
    expect(screenToCell(l, { x: 227, y: 113 })).toEqual({ x: 3, y: 1 });
    expect(screenToCell(l, { x: 99, y: 49 })).toEqual({ x: -1, y: -1 });
  });

  it('finds the island and character under a world cell', () => {
    const f = fleet();
    const c0 = f.characters.c0;
    const w = worldCell(f.islands.i_b.position, c0.cell);
    expect(cellOwner(f, w)).toEqual({ island: f.islands.i_b, local: c0.cell, land: true });
    expect(characterAt(f, 'i_b', c0.cell)?.id).toBe('c0');
    expect(cellOwner(f, { x: 0, y: 0 })).toMatchObject({ island: f.islands.i_b, land: false }); // corner cut
    expect(cellOwner(f, { x: 7, y: 0 })).toBeUndefined();                                       // gap
  });
});

// mission control on a 1400 x 900 map: its row 210px up the foot, the land under it wider and lower
describe('fitting around mission control', () => {
  const win = { w: 1400, h: 690 };
  const below: Below = { h: 900, blocks: [{ x: 550, w: 300, top: 690 }, { x: 520, w: 360, top: 746 }] };
  const cs = (l: Layout) => theme.cell * l.scale;
  const foot = (i: Island) => ground(i).position.y + ground(i).size.h + theme.bounds.bottom;
  const span = (i: Island, l: Layout): [number, number] => [l.ox + ground(i).position.x * cs(l), l.ox + (ground(i).position.x + ground(i).size.w) * cs(l)];
  // every island's cards above the limit under them, and the labels under the top inset
  const clear = (islands: Island[], l: Layout, b: Below) => {
    for (const i of islands) expect(l.oy + foot(i) * cs(l)).toBeLessThanOrEqual(limitAt(b, ...span(i, l)) + 1e-6);
    expect(l.oy + worldBounds(islands).y * cs(l)).toBeGreaterThanOrEqual(theme.fit.top - 1e-6);
  };
  const dropped = (id: string, by: number) => mapIslands(fleet()).map((i) => (i.id === id ? { ...i, position: { x: i.position.x, y: i.position.y + by } } : i));
  const find = (islands: Island[], id: string) => islands.find((i) => i.id === id)!;

  it('fits a fleet that stands over mission control as the room above it would', () => {
    const islands = mapIslands(fleet());
    expect(fitAll(islands, win, undefined, below)).toEqual(fitAll(islands, win));
    expect(fitAll(islands, win, undefined, { h: 900, blocks: [{ x: 0, w: 1400, top: 690 }] })).toEqual(fitAll(islands, win));
  });

  it('rests the fleet on mission control when an island clear of it can hang down beside it', () => {
    const islands = dropped('i_e', 3);
    const l = fitAll(islands, win, undefined, below);
    clear(islands, l, below);
    expect(span(find(islands, 'i_e'), l)[0]).toBeGreaterThan(880);
    expect(l.oy).toBeGreaterThan(fitAll(islands, win).oy);
    expect(l.oy + foot(find(islands, 'i_e')) * cs(l)).toBeGreaterThan(win.h);
    expect(roomOf(islands, l, win, undefined, below)).toEqual({ w: 1400, h: 900 });
    const level = mapIslands(fleet());
    expect(roomOf(level, fitAll(level, win, undefined, below), win, undefined, below)).toEqual(win);
  });

  it('keeps a level fleet centred over mission control, even one standing clear of it', () => {
    const level = mapIslands(fleet()).map((i) => ({ ...i, position: { x: i.id === 'i_e' ? 40 : i.position.x - 40, y: 0 } }));
    const l = fitAll(level, win, undefined, below);
    expect(level.every((i) => limitAt(below, ...span(i, l)) === 900 - theme.home.water)).toBe(true);
    expect(l).toEqual(fitAll(level, win));
    // the room over mission control short of their height makes no difference
    const tall = [0, 20].map((x, n) => ({ ...mapIslands(fleet())[n], position: { x, y: 0 }, size: { w: 6, h: 14 } }));
    expect(fitAll(tall, win, undefined, below)).toEqual(fitAll(tall, win));
  });

  it('takes a floor left far under the fleet no lower than a row under its ground', () => {
    const islands = mapIslands(fleet());                  // ground ends at y = 4
    expect(fitFloor(islands, 30)).toBe(5);
    expect(fitFloor(islands, 3)).toBe(3);
    expect(fitFloor([], 30)).toBe(30);
    expect(fitFloor(islands, undefined)).toBeUndefined();
  });

  it('keeps the room over mission control for a fleet too big for the map, so it pans up to its last row', () => {
    const big = Array.from({ length: 25 }, (_, n) => ({ ...mapIslands(fleet())[0], id: `b${n}`, position: { x: (n % 5) * 12, y: Math.floor(n / 5) * 10 }, size: { w: 10, h: 7 } }));
    const l = fitAll(big, win, undefined, below);
    expect(l.scale).toBe(theme.scale.min);
    expect(roomOf(big, l, win, undefined, below)).toBe(win);
  });

  it('grows the world into the water beside mission control when the room above it is short', () => {
    const short = { w: 1400, h: 290 }, low: Below = { h: 500, blocks: [{ x: 620, w: 160, top: 290 }, { x: 600, w: 200, top: 346 }] };
    const islands = dropped('i_e', 3);
    const l = fitAll(islands, short, undefined, low);
    clear(islands, l, low);
    expect(l.scale).toBeGreaterThan(fitAll(islands, short).scale * 1.1);
  });

  it('knows land put down on mission control from land beside it', () => {
    const l = fitAll(mapIslands(fleet()), win, undefined, below);
    const [, a, c] = mapIslands(fleet());
    expect(onBlocks({ ...a, position: { x: a.position.x, y: 8 } }, l, below)).toBe(true);
    expect(onBlocks({ ...c, position: { x: c.position.x, y: 8 } }, l, below)).toBe(false);
    expect(onBlocks(a, l, below)).toBe(false);
    // under a row that ends above the foot, the water is open
    const row: Below = { h: 900, blocks: [{ x: 0, w: 1400, top: 690, bottom: 740 }] };
    expect(onBlocks({ ...a, position: { x: a.position.x, y: 8 } }, l, row)).toBe(true);
    expect(onBlocks({ ...a, position: { x: a.position.x, y: 9 } }, l, row)).toBe(false);
  });
});
