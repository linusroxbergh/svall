import { describe, expect, it } from 'vitest';
import { ground, pillWidth, type Island } from '@svall/protocol';
import { cardScale, cellOwner, characterAt, clampPan, crewOf, drawnBox, fitAll, labelScale, limitAt, mapIslands, onBlocks, roomOf, screenToCell, worldBounds, worldCell, worldToScreen, type Below, type Layout } from '../src/map/layout.js';
import { theme, tokenPx } from '../src/theme.js';
import { fleet } from './fixtures.js';

// fixture: three 6x4 islands at x = 0, 8, 16, all at y = 0, with crew on row 1 of beta and alpha. A card on row 1
// stands inside a four-row ground at every scale, so the world is the grounds and the label band: x 0..22, y -1.3..4
const TOK_H = tokenPx.h / theme.cell;
const cs = (l: Layout) => theme.cell * l.scale;

describe('what an island draws', () => {
  const beta = () => mapIslands(fleet()).find((i) => i.id === 'i_b')!;
  it('is its ground and the label band over it while its crew stands inside', () => {
    expect(drawnBox(beta(), [{ x: 1, y: 1 }], 1)).toEqual({ x: 0, y: -theme.bounds.top, w: 6, h: 4 + theme.bounds.top });
  });
  it('reaches down to a card on the bottom row, as far as the card hangs at the scale', () => {
    const foot = (s: number) => { const d = drawnBox(beta(), [{ x: 2, y: 3 }], s); return d.y + d.h; };
    for (const s of [theme.scale.min, theme.token.floor, 1, theme.scale.max]) {
      expect(foot(s)).toBeCloseTo(Math.max(4, 3.5 + (0.52 * TOK_H * cardScale(s)) / s), 10);
    }
    // it hangs furthest in cells where it keeps its screen size and the map shrinks under it
    expect(foot(theme.token.floor)).toBeGreaterThan(foot(1));
  });
  it('widens a narrow island to its label pill', () => {
    const narrow = { ...beta(), name: 'a very long island name indeed', size: { w: 4, h: 3 } };
    expect(drawnBox(narrow, [], 1).w).toBeCloseTo(pillWidth(narrow.name), 10);
  });
  it('is only its pill once folded', () => {
    const folded = { ...beta(), size: { w: 30, h: 4 }, collapsed: true };
    const pill = ground(folded);
    expect(drawnBox(folded, [{ x: 2, y: 3 }], 1)).toEqual({ x: pill.position.x, y: -theme.bounds.top, w: pill.size.w, h: pill.position.y + 1 + theme.bounds.top });
  });
});

describe('world layout', () => {
  it('bounds every island by what it draws', () => {
    const f = fleet();
    expect(worldBounds(mapIslands(f), crewOf(f), 1)).toEqual({ x: 0, y: -theme.bounds.top, w: 22, h: 4 + theme.bounds.top });
    expect(worldBounds([])).toEqual({ x: 0, y: -theme.bounds.top, w: 6, h: 4 + theme.bounds.top });
  });

  it('fits the drawn world inside even margins, and shares what is left both ways', () => {
    const f = fleet(), islands = mapIslands(f), crew = crewOf(f);
    const l = fitAll(islands, { w: 1400, h: 900 }, crew);
    expect(l.tile).toBe(theme.cell);
    expect(l.scale).toBeCloseTo((1400 - 2 * theme.fit.x) / (22 * theme.cell), 6);
    const b = worldBounds(islands, crew, l.scale);
    const left = l.ox + b.x * cs(l), right = 1400 - left - b.w * cs(l);
    const top = l.oy + b.y * cs(l), bottom = 900 - top - b.h * cs(l);
    expect(left).toBeCloseTo(theme.fit.x, 6);
    expect(right).toBeCloseTo(theme.fit.x, 6);
    expect(top - theme.fit.top).toBeCloseTo(bottom - theme.fit.bottom, 6);
  });

  it('keeps the margins even: the sides match the top, and so do the bottom and mission control\'s water', () => {
    expect(theme.fit.x).toBe(theme.fit.top);
    expect(theme.fit.bottom + theme.home.water).toBe(theme.fit.top);
  });

  it('finds the largest scale a world whose cards change size with it still fits', () => {
    // a card on beta's bottom row hangs past the ground by an amount that follows the scale
    const f = fleet();
    f.characters.c1 = { ...f.characters.c1, cell: { x: 4, y: 3 } };
    const islands = mapIslands(f), crew = crewOf(f), win = { w: 3000, h: 400 };
    const l = fitAll(islands, win, crew);
    expect(worldBounds(islands, crew, l.scale).h * cs(l)).toBeCloseTo(win.h - theme.fit.top - theme.fit.bottom, 3);
  });

  it('holds the ceiling and the floor', () => {
    const f = fleet(), islands = mapIslands(f), crew = crewOf(f);
    expect(fitAll(islands, { w: 3000, h: 2000 }, crew).scale).toBe(theme.scale.max);
    const tiny = fitAll(islands, { w: 400, h: 300 }, crew);
    expect(tiny.scale).toBe(theme.scale.min);
    // too big for the window, the world is still centred across it
    const b = worldBounds(islands, crew, tiny.scale);
    expect(tiny.ox + (b.x + b.w / 2) * cs(tiny)).toBeCloseTo(200, 6);
  });

  it('measures a folded island across by its pill, not the ground it would take back', () => {
    const islands = mapIslands(fleet()).map((i) => (i.id === 'i_e' ? { ...i, size: { w: 30, h: 4 }, collapsed: true } : i));
    const pill = ground(islands.find((i) => i.id === 'i_e')!);
    expect(worldBounds(islands).w).toBeCloseTo(pill.position.x + pill.size.w, 10);
  });

  it('clamps a pan to the world edge and drops a pan on an axis that fits', () => {
    const f = fleet(), islands = mapIslands(f), crew = crewOf(f);
    const win = { w: 1400, h: 900 };
    expect(clampPan(islands, fitAll(islands, win, crew), win, { x: 500, y: -500 }, crew)).toEqual({ x: 0, y: 0 });
    const small = { w: 400, h: 300 };
    const l = fitAll(islands, small, crew);
    const b = worldBounds(islands, crew, l.scale);
    // wider than the window, it pans as far as the margin past either edge; it fits down, so it stays put that way
    const reach = (b.w * cs(l) - small.w) / 2 + theme.panMargin;
    expect(clampPan(islands, l, small, { x: 1000, y: 0 }, crew).x).toBeCloseTo(reach, 6);
    expect(clampPan(islands, l, small, { x: -1000, y: 0 }, crew).x).toBeCloseTo(-reach, 6);
    expect(clampPan(islands, l, small, { x: 20, y: 0 }, crew).x).toBeCloseTo(20, 6);
    expect(clampPan(islands, l, small, { x: 0, y: 999 }, crew).y).toBeCloseTo(0, 6);
  });

  it('leaves the fit alone at every height a fitting world is centred at', () => {
    const f = fleet(), islands = mapIslands(f), crew = crewOf(f);
    for (let h = 300; h <= 1200; h += 1) {
      const win = { w: 1400, h };
      const l = fitAll(islands, win, crew);
      expect(clampPan(islands, l, win, { x: 0, y: 0 }, crew)).toEqual({ x: 0, y: 0 });
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
  const crew = crewOf(fleet());
  const foot = (i: Island, l: Layout) => { const d = drawnBox(i, crew[i.id], l.scale); return d.y + d.h; };
  const span = (i: Island, l: Layout): [number, number] => [l.ox + ground(i).position.x * cs(l), l.ox + (ground(i).position.x + ground(i).size.w) * cs(l)];
  // every island's cards the bottom margin above the limit under them, and the labels under the top inset
  const clear = (islands: Island[], l: Layout, b: Below) => {
    for (const i of islands) expect(l.oy + foot(i, l) * cs(l)).toBeLessThanOrEqual(limitAt(b, ...span(i, l)) - theme.fit.bottom + 1e-6);
    expect(l.oy + worldBounds(islands, crew, l.scale).y * cs(l)).toBeGreaterThanOrEqual(theme.fit.top - 1e-6);
  };
  const dropped = (id: string, by: number) => mapIslands(fleet()).map((i) => (i.id === id ? { ...i, position: { x: i.position.x, y: i.position.y + by } } : i));
  const find = (islands: Island[], id: string) => islands.find((i) => i.id === id)!;

  it('fits a fleet that stands over mission control as the room above it would', () => {
    const islands = mapIslands(fleet());
    expect(fitAll(islands, win, crew, below)).toEqual(fitAll(islands, win));
    expect(fitAll(islands, win, crew, { h: 900, blocks: [{ x: 0, w: 1400, top: 690 }] })).toEqual(fitAll(islands, win));
  });

  it('rests the fleet on mission control when an island clear of it can hang down beside it', () => {
    const islands = dropped('i_e', 3);
    const l = fitAll(islands, win, crew, below);
    clear(islands, l, below);
    expect(span(find(islands, 'i_e'), l)[0]).toBeGreaterThan(880);
    expect(l.oy).toBeGreaterThan(fitAll(islands, win).oy);
    expect(l.oy + foot(find(islands, 'i_e'), l) * cs(l)).toBeGreaterThan(win.h);
    expect(roomOf(islands, l, win, crew, below)).toEqual({ w: 1400, h: 900 });
    const level = mapIslands(fleet());
    expect(roomOf(level, fitAll(level, win, crew, below), win, crew, below)).toEqual(win);
  });

  it('keeps a level fleet centred over mission control, even one standing clear of it', () => {
    const level = mapIslands(fleet()).map((i) => ({ ...i, position: { x: i.id === 'i_e' ? 40 : i.position.x - 40, y: 0 } }));
    const l = fitAll(level, win, crew, below);
    expect(level.every((i) => limitAt(below, ...span(i, l)) === 900 - theme.home.water)).toBe(true);
    expect(l).toEqual(fitAll(level, win));
    // the room over mission control short of their height makes no difference
    const tall = [0, 20].map((x, n) => ({ ...mapIslands(fleet())[n], position: { x, y: 0 }, size: { w: 6, h: 14 } }));
    expect(fitAll(tall, win, crew, below)).toEqual(fitAll(tall, win));
  });

  it('splits the water over and under a fleet resting on mission control', () => {
    // the width holds the scale down, so there is height to spare above the rest limit
    const islands = dropped('i_e', 3);
    const l = fitAll(islands, win, crew, below);
    expect(l.oy).toBeGreaterThan(fitAll(islands, win, crew).oy);
    const b = worldBounds(islands, crew, l.scale);
    const top = l.oy + b.y * cs(l) - theme.fit.top;
    const bottom = below.h - theme.home.water - theme.fit.bottom - (l.oy + (b.y + b.h) * cs(l));
    expect(top).toBeGreaterThan(20);
    expect(top).toBeCloseTo(bottom, 6);
    clear(islands, l, below);
  });

  it('keeps the fleet down on mission control while an island stands on its row', () => {
    // i_e's ground ends on row 7: put there by hand, where arrange leaves mission control a row under the fleet
    const islands = dropped('i_e', 3);
    const pinned = fitAll(islands, win, crew, { ...below, row: 7 });
    expect(pinned.oy).toBeGreaterThan(fitAll(islands, win, crew, below).oy);
    clear(islands, pinned, below);
    // resting, some island's cards stand right on the limit under them
    const slack = Math.min(...islands.map((i) => limitAt(below, ...span(i, pinned)) - theme.fit.bottom - (pinned.oy + foot(i, pinned) * cs(pinned))));
    expect(slack).toBeCloseTo(0, 6);
    // a row a cell under the fleet is where arrange leaves it, and the water is split again
    expect(fitAll(islands, win, crew, { ...below, row: 8 })).toEqual(fitAll(islands, win, crew, below));
  });

  it('keeps the room over mission control for a fleet too big for the map, so it pans up to its last row', () => {
    const big = Array.from({ length: 25 }, (_, n) => ({ ...mapIslands(fleet())[0], id: `b${n}`, position: { x: (n % 5) * 12, y: Math.floor(n / 5) * 10 }, size: { w: 10, h: 7 } }));
    const l = fitAll(big, win, crew, below);
    expect(l.scale).toBe(theme.scale.min);
    expect(roomOf(big, l, win, crew, below)).toBe(win);
  });

  it('grows the world into the water beside mission control when the room above it is short', () => {
    const short = { w: 1400, h: 290 }, low: Below = { h: 500, blocks: [{ x: 620, w: 160, top: 290 }, { x: 600, w: 200, top: 346 }] };
    const islands = dropped('i_e', 3);
    const l = fitAll(islands, short, crew, low);
    clear(islands, l, low);
    expect(l.scale).toBeGreaterThan(fitAll(islands, short).scale * 1.1);
  });

  it('knows land put down on mission control from land beside it', () => {
    const l = fitAll(mapIslands(fleet()), win, crew, below);
    const [, a, c] = mapIslands(fleet());
    expect(onBlocks({ ...a, position: { x: a.position.x, y: 8 } }, l, below)).toBe(true);
    expect(onBlocks({ ...c, position: { x: c.position.x, y: 8 } }, l, below)).toBe(false);
    expect(onBlocks(a, l, below)).toBe(false);
    // under a row that ends above the foot, the water is open
    const row: Below = { h: 900, blocks: [{ x: 0, w: 1400, top: 690, bottom: 740 }] };
    expect(onBlocks({ ...a, position: { x: a.position.x, y: 7 } }, l, row)).toBe(true);
    expect(onBlocks({ ...a, position: { x: a.position.x, y: 8 } }, l, row)).toBe(false);
  });
});
