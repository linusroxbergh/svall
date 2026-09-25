import { describe, expect, it } from 'vitest';
import { ground } from '@archipelago/protocol';
import { cardScale, cellOwner, characterAt, clampPan, fitAll, labelScale, mapIslands, screenToCell, worldBounds, worldCell, worldToScreen } from '../src/map/layout.js';
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
    // min((1400 - 2*56)/1091.2, (900 - 2*66)/290.4) = min(1.180351…, 2.644628…)
    expect(l.tile).toBe(theme.cell);
    expect(l.scale).toBeCloseTo(1.1803519061583576, 10);
    expect(l.ox).toBeCloseTo(128.70967741935493, 6);    // (1400 - 1288)/2 + 1.4*44*scale
    expect(l.oy).toBeCloseTo(346.1290322580645, 6);     // (900 - 290.4*scale)/2 + 1.3*44*scale
    // the water left over is shared evenly either side, across and down
    const b = worldBounds(islands);
    expect(l.ox + b.x * theme.cell * l.scale).toBeCloseTo(56, 6);
    const top = l.oy + b.y * theme.cell * l.scale;
    expect(top).toBeCloseTo(900 - (top + b.h * theme.cell * l.scale), 6);
  });

  it('holds the ceiling and the floor', () => {
    const islands = mapIslands(fleet());
    expect(fitAll(islands, { w: 3000, h: 2000 }).scale).toBe(theme.scale.max);   // raw 2.6467 → 1.5
    const tiny = fitAll(islands, { w: 400, h: 300 });
    expect(tiny.scale).toBe(theme.scale.min);                                    // raw 0.2639 → 0.42
    expect(tiny.ox).toBeCloseTo(-3.28, 6);                                       // (400 - 458.304)/2 + 25.872
    expect(tiny.oy).toBeCloseTo(113.04, 6);                                      // (300 - 121.968)/2 + 1.3*44*0.42
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
