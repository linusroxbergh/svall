import { SPACING, ground, isLand, type Cell, type Character, type FleetState, type Island } from '@archipelago/protocol';
import { theme } from '../theme.js';

export type Layout = { scale: number; tile: number; ox: number; oy: number };
export type Bounds = { x: number; y: number; w: number; h: number };

// the row an island draws down to: its ground and the card that hangs off it, or the label pill alone once folded
function foot(i: Island): number {
  const g = ground(i);
  return g.position.y + g.size.h + (i.collapsed ? 0 : theme.bounds.bottom);
}

// the footprint box grown by the label above and the card overhang below, in cells. `floor` is mission
// control's row: the world reaches down to it and stops there, the cards hanging into the water it
// already keeps above itself, so nothing is added below the row
export function worldBounds(islands: Island[], floor?: number): Bounds {
  const b = theme.bounds;
  if (islands.length === 0) {
    const y0 = (floor ?? 4) - 4;
    return { x: -b.left, y: y0 - b.top, w: 6 + b.left + b.right, h: 4 + b.top + (floor === undefined ? b.bottom : 0) };
  }
  // a folded island reaches only as wide as its pill; the ground it would take back stays out of the fit
  const x0 = Math.min(...islands.map((i) => ground(i).position.x)), y0 = Math.min(...islands.map((i) => i.position.y));
  const x1 = Math.max(...islands.map((i) => ground(i).position.x + ground(i).size.w));
  const y1 = Math.max(floor ?? -Infinity, ...islands.map(foot));
  return { x: x0 - b.left, y: y0 - b.top, w: x1 - x0 + b.left + b.right, h: y1 - y0 + b.top };
}

// the largest scale in [theme.scale.min, theme.scale.max] at which the world fits inside the fit insets,
// centred both ways in the room they leave
export function fitAll(islands: Island[], win: { w: number; h: number }, floor?: number): Layout {
  const b = worldBounds(islands, floor);
  const cell = theme.cell, { x, top, bottom } = theme.fit;
  const ww = b.w * cell, wh = b.h * cell;
  const raw = Math.min((win.w - 2 * x) / ww, (win.h - top - bottom) / wh);
  const scale = Math.min(theme.scale.max, Math.max(theme.scale.min, raw));
  const ox = (win.w - ww * scale) / 2 - b.x * cell * scale;
  const oy = top + (win.h - top - bottom - wh * scale) / 2 - b.y * cell * scale;
  return { scale, tile: cell, ox, oy };
}

// a pan may not push the world bounds further than theme.panMargin out of the window; an axis whose world fits keeps the fit
export function clampPan(islands: Island[], l: Layout, win: { w: number; h: number }, pan: { x: number; y: number }, floor?: number): { x: number; y: number } {
  const b = worldBounds(islands, floor);
  const s = cellSize(l);
  const m = theme.panMargin;
  const axis = (v: number, start: number, len: number, size: number) => {
    // a world no longer than the window is already where the fit centred it
    if (len <= size) return 0;
    const lo = size - m - (start + len), hi = m - start;
    return Math.max(lo, Math.min(hi, v));
  };
  return {
    x: axis(pan.x, l.ox + b.x * s, b.w * s, win.w),
    y: axis(pan.y, l.oy + b.y * s, b.h * s, win.h),
  };
}

const grown = (scale: number, share: number): number => 1 + Math.max(0, scale - 1) * share;

// a card's size on screen against its drawn size, at a map scale
export const cardScale = (scale: number): number =>
  scale < theme.token.floor ? scale / theme.token.floor : grown(scale, theme.token.grow);

// the same for an island's label pill, which follows the map below 1
export const labelScale = (scale: number): number => Math.min(scale, grown(scale, theme.label.grow));

export const cellSize = (l: Layout): number => l.tile * l.scale;
export const worldToScreen = (l: Layout, c: Cell) => ({ x: l.ox + c.x * cellSize(l), y: l.oy + c.y * cellSize(l) });
export const screenToCell = (l: Layout, p: { x: number; y: number }): Cell => ({ x: Math.floor((p.x - l.ox) / cellSize(l)), y: Math.floor((p.y - l.oy) / cellSize(l)) });
export const worldCell = (origin: Cell, local: Cell): Cell => ({ x: origin.x + local.x, y: origin.y + local.y });

// the islands that live in the panned world; home is drawn in screen space
export const mapIslands = (f: FleetState): Island[] => Object.values(f.islands).filter((i) => i.kind !== 'home');

// a folded island draws no land, so it reads as open water
export function cellOwner(f: FleetState, cell: Cell): { island: Island; local: Cell; land: boolean } | undefined {
  for (const island of mapIslands(f)) {
    if (island.collapsed) continue;
    const local = { x: cell.x - island.position.x, y: cell.y - island.position.y };
    if (local.x < 0 || local.y < 0 || local.x >= island.size.w || local.y >= island.size.h) continue;
    return { island, local, land: isLand(island, local) };
  }
  return undefined;
}

// the unfolded island whose footprint, grown by its one-cell coast, holds the cell
export const islandNear = (f: FleetState, c: Cell): string | undefined =>
  mapIslands(f).find((i) => !i.collapsed && c.x >= i.position.x - 1 && c.y >= i.position.y - 1 && c.x <= i.position.x + i.size.w && c.y <= i.position.y + i.size.h)?.id;

export const characterAt = (f: FleetState, islandId: string, local: Cell): Character | undefined =>
  Object.values(f.characters).find((c) => c.islandId === islandId && c.cell.x === local.x && c.cell.y === local.y);

// a cell within SPACING of another character is taken (the other's own cell swaps)
export const crowded = (f: FleetState, islandId: string, local: Cell, exceptId: string): boolean =>
  Object.values(f.characters).some((c) => c.id !== exceptId && c.islandId === islandId && Math.max(Math.abs(c.cell.x - local.x), Math.abs(c.cell.y - local.y)) <= SPACING);
