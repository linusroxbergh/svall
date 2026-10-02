import type { Cell, Size } from './state.js';
type Grid = boolean[][];

export const MIN_SIZE: Size = { w: 4, h: 3 };
// the ground a crew of one needs: a card two cells in from the coast on every side
export const DEFAULT_SIZE: Size = { w: 7, h: 5 };
// characters keep this many empty cells between them, in Chebyshev distance
export const SPACING = 2;
export const cellKey = (c: Cell): string => `${c.x},${c.y}`;

const grid = (size: Size, value: boolean): Grid => Array.from({ length: size.h }, () => Array.from({ length: size.w }, () => value));
const at = (g: Grid, x: number, y: number): boolean => g[y]?.[x] ?? false;

// a rounded rectangle: a quarter-disc off each corner, radius a third of the short side; the seed is kept for later
export function islandShape(size: Size, _seed: number): Grid {
  const { w, h } = size;
  const g = grid(size, true);
  const r = Math.max(1, Math.floor(Math.min(w, h) / 3));
  const corners: [number, number, number, number][] = [[0, 0, 1, 1], [w - 1, 0, -1, 1], [0, h - 1, 1, -1], [w - 1, h - 1, -1, -1]];
  for (const [cx, cy, sx, sy] of corners) {
    for (let dy = 0; dy < r; dy++) for (let dx = 0; dx < r; dx++) {
      if ((dx + 0.5) ** 2 + (dy + 0.5) ** 2 < r * r) g[cy + sy * dy][cx + sx * dx] = false;
    }
  }
  return g;
}

export function landCells(size: Size, seed: number): Cell[] {
  const g = islandShape(size, seed);
  const cells: Cell[] = [];
  for (let y = 0; y < size.h; y++) for (let x = 0; x < size.w; x++) if (g[y][x]) cells.push({ x, y });
  return cells;
}

// land cells in reading order, skipping any within Chebyshev distance SPACING of a cell already taken
export function spacedCells(size: Size, seed: number, n: number): Cell[] {
  const taken: Cell[] = [];
  for (const c of landCells(size, seed)) {
    if (taken.length === n) break;
    if (!taken.some((t) => Math.max(Math.abs(t.x - c.x), Math.abs(t.y - c.y)) <= SPACING)) taken.push(c);
  }
  return taken;
}

// the smallest near-square footprint whose land holds n characters SPACING apart, grown a cell at a time
export function sizeForCrew(n: number, seed: number): Size {
  let size: Size = { ...MIN_SIZE };
  while (spacedCells(size, seed, n).length < n) size = size.w <= size.h + 1 ? { w: size.w + 1, h: size.h } : { w: size.w, h: size.h + 1 };
  return size;
}

export const isLand = (island: { size: Size; seed: number }, cell: Cell): boolean => at(islandShape(island.size, island.seed), cell.x, cell.y);

export const HOME_ISLAND = 'home';
export const HOME_ROW = 1;
export const HOME_SEED = 7;

// crew stand on the crew row at columns 1, 4, 7, … that keep SPACING cells between cards and a cell of land to the right
export function homeSlots(w: number): number[] {
  const out: number[] = [];
  for (let x = 1; x <= w - 2; x += SPACING + 1) out.push(x);
  return out;
}

export const homeSizeFor = (slots: number): Size => ({ w: Math.max(8, 3 * slots + 2), h: 4 });

export const isHomeSlot = (island: { size: Size }, cell: Cell): boolean =>
  cell.y === HOME_ROW && homeSlots(island.size.w).includes(cell.x);

// the label pill as the map draws it: two rows above the island's top edge, centred on its middle, and
// as wide as its chevron, count and name — measured at 2.4 cells of furniture plus a fifth per character
export const pillWidth = (name: string): number => Math.max(2, Math.round(2.4 + name.length * 0.2));

// the ground something holds on the map
export type Footprint = { position: Cell; size: Size };
