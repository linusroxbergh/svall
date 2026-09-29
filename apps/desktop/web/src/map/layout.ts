import { SPACING, ground, isLand, type Cell, type Character, type FleetState, type Island } from '@svall/protocol';
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

const clampScale = (s: number): number => Math.min(theme.scale.max, Math.max(theme.scale.min, s));

// a screen rect the world keeps clear of: mission control's row, its land, the islet. the fit takes each down to the map's
// foot; `bottom` is where one really ends, which only a drop reads
export type Block = { x: number; w: number; top: number; bottom?: number };
// the whole map under the room kept over mission control, and the blocks standing in it
export type Below = { h: number; blocks: Block[] };

// how low a part of the world spanning screen x from l to r may reach: over a block, down to its top; clear of them all,
// to the map's foot less the water mission control keeps
export const limitAt = (below: Below, l: number, r: number): number =>
  Math.min(below.h - theme.home.water, ...below.blocks.filter((k) => l < k.x + k.w && r > k.x).map((k) => k.top));

// the screen x an island's land spans at a layout; the shoal glow around it counts for nothing
export const landSpan = (i: Island, l: Layout): [number, number] => {
  const g = ground(i), s = cellSize(l);
  return [l.ox + g.position.x * s, l.ox + (g.position.x + g.size.w) * s];
};

// the lowest the world may stand at a layout's scale and x: the cards under every island's land above the limit under it
const lowest = (islands: Island[], below: Below, l: Layout): number =>
  Math.min(...islands.map((i) => limitAt(below, ...landSpan(i, l)) - foot(i) * cellSize(l)));

// mission control's row never rises on its own, so a floor an island once took past it can lie far under the fleet;
// the fit takes it no lower than the row of water arrange leaves under the fleet's lowest ground
export function fitFloor(islands: Island[], floor?: number): number | undefined {
  if (floor === undefined || islands.length === 0) return floor;
  return Math.min(floor, Math.max(...islands.map((i) => ground(i).position.y + ground(i).size.h)) + 1);
}

// the largest scale in [theme.scale.min, theme.scale.max] at which the world fits inside the fit insets, centred both
// ways in the room they leave over mission control. With `below`, a step down beside mission control (the lowest
// islands all clear of its blocks, another standing higher) lets the fleet rest on mission control instead, at
// whatever larger scale the water beside it allows
export function fitAll(islands: Island[], win: { w: number; h: number }, floor?: number, below?: Below): Layout {
  const b = worldBounds(islands, floor);
  const cell = theme.cell, { x, top, bottom } = theme.fit;
  const ww = b.w * cell, wh = b.h * cell;
  const at = (scale: number, oy = 0): Layout => ({ scale, tile: cell, ox: (win.w - ww * scale) / 2 - b.x * cell * scale, oy });
  const scale = clampScale(Math.min((win.w - 2 * x) / ww, (win.h - top - bottom) / wh));
  const centred = at(scale, top + (win.h - top - bottom - wh * scale) / 2 - b.y * cell * scale);
  if (!below || islands.length === 0) return centred;
  const feet = islands.map(foot), deepest = Math.max(...feet);
  if (Math.min(...feet) === deepest) return centred;
  const rest = (s: number): number => lowest(islands, below, at(s));
  // at a scale the lowest islands all stand clear of mission control, and the fleet rests on it inside the fit insets
  const fits = (s: number): boolean => {
    const l = at(s);
    return islands.every((i, n) => feet[n] < deepest || limitAt(below, ...landSpan(i, l)) >= below.h - theme.home.water) &&
      rest(s) >= top - b.y * cell * s;
  };
  // the room over mission control already holds the world at `scale`, so only the water beside it can offer more
  const most = clampScale(Math.min((win.w - 2 * x) / ww, (below.h - top - theme.home.water) / wh));
  for (let s = most, prev = most; s > scale; prev = s, s = Math.max(scale, s * 0.99)) {
    if (!fits(s)) continue;
    let ok = s, over = prev;
    if (ok < over) for (let n = 0; n < 12; n++) { const mid = (ok + over) / 2; if (fits(mid)) ok = mid; else over = mid; }
    return at(ok, rest(ok));
  }
  return fits(scale) ? at(scale, rest(scale)) : centred;
}

// the room a fitted world stands in: the map over mission control, or all of it when the fit rested on mission control
export function roomOf(islands: Island[], l: Layout, win: { w: number; h: number }, floor?: number, below?: Below): { w: number; h: number } {
  const plain = fitAll(islands, win, floor);
  return below && (l.scale !== plain.scale || l.oy !== plain.oy) ? { w: win.w, h: below.h } : win;
}

// an island's land at a layout, on mission control itself rather than in the water it keeps: a drop there has nowhere
// to go, where one in the water only has the map make room
export function onBlocks(island: Island, l: Layout, below: Below): boolean {
  const g = ground(island), s = cellSize(l), pad = theme.home.water, [left, right] = landSpan(island, l);
  const top = l.oy + g.position.y * s, bottom = top + g.size.h * s;
  return below.blocks.some((k) => left < k.x + k.w - pad && right > k.x + pad && bottom > k.top + pad && (k.bottom === undefined || top < k.bottom - pad));
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
