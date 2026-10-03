import { describe, expect, it } from 'vitest';
import { HOME_ROW, homeSizeFor, homeSlots, isHomeSlot, isLand, islandShape, landCells } from '../src/shape.js';

const count = (g: boolean[][]) => g.flat().filter(Boolean).length;
const render = (g: boolean[][]) => g.map((row) => row.map((c) => (c ? '#' : '.')).join('')).join('\n');

describe('islandShape', () => {
  it('is deterministic and stays inside the footprint', () => {
    const a = islandShape({ w: 6, h: 4 });
    const b = islandShape({ w: 6, h: 4 });
    expect(render(a)).toBe(render(b));
    expect(a).toHaveLength(4);
    for (const row of a) expect(row).toHaveLength(6);
  });
  it('removes every corner and keeps the centre', () => {
    const g = islandShape({ w: 6, h: 4 });
    expect(g[0][0]).toBe(false);
    expect(g[0][5]).toBe(false);
    expect(g[3][0]).toBe(false);
    expect(g[3][5]).toBe(false);
    expect(g[2][3]).toBe(true);
  });
  it('is 4-connected', () => {
    const g = islandShape({ w: 9, h: 7 });
    const seen = new Set<string>();
    const stack = [[Math.floor(9 / 2), Math.floor(7 / 2)]];
    while (stack.length) {
      const [x, y] = stack.pop()!;
      const k = `${x},${y}`;
      if (seen.has(k) || !g[y]?.[x]) continue;
      seen.add(k);
      stack.push([x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]);
    }
    expect(seen.size).toBe(count(g));
  });
  it('4x3 keeps at least six land cells', () => {
    expect(count(islandShape({ w: 4, h: 3 }))).toBeGreaterThanOrEqual(6);
  });
  it('is a rounded rectangle with a bigger radius on bigger islands', () => {
    expect(render(islandShape({ w: 6, h: 4 }))).toBe('.####.\n######\n######\n.####.');
    expect(render(islandShape({ w: 8, h: 8 }))).toBe('..####..\n.######.\n########\n########\n########\n########\n.######.\n..####..');
  });
});

describe('landCells and masks', () => {
  it('lists land in reading order', () => {
    const cells = landCells({ w: 4, h: 3 });
    const g = islandShape({ w: 4, h: 3 });
    expect(cells).toHaveLength(count(g));
    for (let i = 1; i < cells.length; i++) expect(cells[i].y * 4 + cells[i].x).toBeGreaterThan(cells[i - 1].y * 4 + cells[i - 1].x);
  });
});

describe('home slots', () => {
  it('lists columns three apart that leave land to their right', () => {
    expect(homeSlots(8)).toEqual([1, 4]);
    expect(homeSlots(11)).toEqual([1, 4, 7]);
    expect(homeSlots(14)).toEqual([1, 4, 7, 10]);
  });
  it('sizes the island for n slots, never under 8 wide', () => {
    expect(homeSizeFor(1)).toEqual({ w: 8, h: 4 });
    expect(homeSizeFor(2)).toEqual({ w: 8, h: 4 });
    expect(homeSizeFor(3)).toEqual({ w: 11, h: 4 });
    expect(homeSlots(homeSizeFor(5).w)).toHaveLength(5);
  });
  it('every slot is land on the crew row', () => {
    for (const n of [2, 3, 6]) {
      const size = homeSizeFor(n);
      for (const x of homeSlots(size.w)) expect(isLand({ size }, { x, y: HOME_ROW })).toBe(true);
    }
    expect(isHomeSlot({ size: { w: 8, h: 4 } }, { x: 4, y: 1 })).toBe(true);
    expect(isHomeSlot({ size: { w: 8, h: 4 } }, { x: 4, y: 2 })).toBe(false);
    expect(isHomeSlot({ size: { w: 8, h: 4 } }, { x: 3, y: 1 })).toBe(false);
  });
});
