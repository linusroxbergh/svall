import { SPACING, ground, isLand, pillWidth, type Cell, type Character, type FleetState, type Island } from '@svall/protocol';
import { theme, tokenPx } from '../theme.js';

export type Layout = { scale: number; tile: number; ox: number; oy: number };
export type Bounds = { x: number; y: number; w: number; h: number };

// the row an island's ground ends on, or its pill's once folded
const foot = (i: Island): number => ground(i).position.y + ground(i).size.h;

// each island's crew, by the cells they stand on in it
export type Crew = Record<string, Cell[]>;
export const crewOf = (f: FleetState): Crew => {
  const out: Crew = {};
  for (const c of Object.values(f.characters)) (out[c.islandId] ??= []).push(c.cell);
  return out;
};

// a card in cells at map scale 1, and the link rail standing off its right edge
const TOK = { w: tokenPx.w / theme.cell, h: tokenPx.h / theme.cell, rail: (0.36 * theme.token.unit) / theme.cell };

// what an island draws at a map scale, in cells: its ground, the label band over it and the pill across it, and each
// card where it hangs past the ground, centred on its cell with 48% of it above. A folded island is its pill alone
export function drawnBox(i: Island, crew: Cell[] = [], scale = 1): Bounds {
  const g = ground(i);
  let x0 = g.position.x, x1 = x0 + g.size.w, y1 = g.position.y + g.size.h;
  const y0 = i.position.y - theme.bounds.top;
  if (!i.collapsed) {
    const half = (pillWidth(i.name) * labelScale(scale)) / scale / 2, mid = i.position.x + i.size.w / 2;
    x0 = Math.min(x0, mid - half);
    x1 = Math.max(x1, mid + half);
    const k = cardScale(scale) / scale;
    for (const c of crew) {
      const cx = i.position.x + c.x + 0.5, cy = i.position.y + c.y + 0.5;
      x0 = Math.min(x0, cx - (TOK.w / 2) * k);
      x1 = Math.max(x1, cx + (TOK.w / 2 + TOK.rail) * k);
      y1 = Math.max(y1, cy + 0.52 * TOK.h * k);
    }
  }
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

// the box round everything the islands draw at a map scale, in cells
export function worldBounds(islands: Island[], crew: Crew = {}, scale = 1): Bounds {
  if (islands.length === 0) return { x: 0, y: -theme.bounds.top, w: 6, h: 4 + theme.bounds.top };
  const boxes = islands.map((i) => drawnBox(i, crew[i.id], scale));
  const x0 = Math.min(...boxes.map((b) => b.x)), y0 = Math.min(...boxes.map((b) => b.y));
  const x1 = Math.max(...boxes.map((b) => b.x + b.w)), y1 = Math.max(...boxes.map((b) => b.y + b.h));
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

// a screen rect the world keeps clear of: mission control's row, its land, the islet. the fit takes each down to the map's
// foot; `bottom` is where one really ends, which only a drop reads
export type Block = { x: number; w: number; top: number; bottom?: number };
// the whole map under the room kept over mission control, the blocks standing in it, and mission control's row in world
// cells, which arrange leaves a row under the fleet
export type Below = { h: number; blocks: Block[]; row?: number };

// how low a part of the world spanning screen x from l to r may reach: over a block, down to its top; clear of them all,
// to the map's foot less the water mission control keeps
export const limitAt = (below: Below, l: number, r: number): number =>
  Math.min(below.h - theme.home.water, ...below.blocks.filter((k) => l < k.x + k.w && r > k.x).map((k) => k.top));

// the screen x an island's land spans at a layout; the shoal glow around it counts for nothing
export const landSpan = (i: Island, l: Layout): [number, number] => {
  const g = ground(i), s = cellSize(l);
  return [l.ox + g.position.x * s, l.ox + (g.position.x + g.size.w) * s];
};

// the largest scale in [theme.scale.min, theme.scale.max] at which what the islands draw fits inside the fit margins,
// centred both ways in the room they leave over mission control. With `below`, a step down beside mission control (the
// lowest islands all clear of its blocks, another standing higher) lets the fleet rest on mission control instead, at
// whatever larger scale the water beside it allows, and still in the middle of the height when there is height to spare
export function fitAll(islands: Island[], win: { w: number; h: number }, crew: Crew = {}, below?: Below): Layout {
  const cell = theme.cell, { x, top, bottom } = theme.fit;
  const boxes = new Map<number, Bounds>();
  const box = (s: number): Bounds => boxes.get(s) ?? boxes.set(s, worldBounds(islands, crew, s)).get(s)!;
  // what is drawn only grows on screen with the scale, so the largest scale that fits a room is a bisection
  const largest = (w: number, h: number): number => {
    const ok = (s: number) => { const b = box(s); return b.w * cell * s <= w && b.h * cell * s <= h; };
    if (ok(theme.scale.max)) return theme.scale.max;
    if (!ok(theme.scale.min)) return theme.scale.min;
    let lo = theme.scale.min, hi = theme.scale.max;
    for (let n = 0; n < 30; n++) { const mid = (lo + hi) / 2; if (ok(mid)) lo = mid; else hi = mid; }
    return lo;
  };
  const at = (s: number, oy = 0): Layout => { const b = box(s); return { scale: s, tile: cell, ox: (win.w - b.w * cell * s) / 2 - b.x * cell * s, oy }; };
  // the oy that centres the world between two screen ys
  const centre = (s: number, from: number, to: number): number => { const b = box(s); return from + (to - from - b.h * cell * s) / 2 - b.y * cell * s; };
  const scale = largest(win.w - 2 * x, win.h - top - bottom);
  const centred = at(scale, centre(scale, top, win.h - bottom));
  if (!below || islands.length === 0) return centred;
  const feet = islands.map(foot), deepest = Math.max(...feet);
  if (Math.min(...feet) === deepest) return centred;
  const drawnFoot = (i: Island, s: number): number => { const d = drawnBox(i, crew[i.id], s); return d.y + d.h; };
  // the lowest the world may stand at a scale: every island's cards the bottom margin above the limit under its land
  const rest = (s: number): number => {
    const l = at(s);
    return Math.min(...islands.map((i) => limitAt(below, ...landSpan(i, l)) - bottom - drawnFoot(i, s) * cell * s));
  };
  const foot0 = below.h - theme.home.water - bottom;
  // an island put down on mission control's row holds the fleet down there; otherwise the height to spare is split
  const held = below.row !== undefined && deepest >= below.row;
  const settle = (s: number): number => (held ? rest(s) : Math.min(rest(s), centre(s, top, foot0)));
  // at a scale the lowest islands all stand clear of mission control, and the fleet rests on it inside the fit margins
  const fits = (s: number): boolean => {
    const l = at(s);
    return islands.every((i, n) => feet[n] < deepest || limitAt(below, ...landSpan(i, l)) >= below.h - theme.home.water) &&
      rest(s) >= top - box(s).y * cell * s;
  };
  // the room over mission control already holds the world at `scale`, so only the water beside it can offer more
  const most = largest(win.w - 2 * x, foot0 - top);
  for (let s = most, prev = most; s > scale; prev = s, s = Math.max(scale, s * 0.99)) {
    if (!fits(s)) continue;
    let ok = s, over = prev;
    if (ok < over) for (let n = 0; n < 12; n++) { const mid = (ok + over) / 2; if (fits(mid)) ok = mid; else over = mid; }
    return at(ok, settle(ok));
  }
  return fits(scale) ? at(scale, settle(scale)) : centred;
}

// the room a fitted world stands in: the map over mission control, or all of it when the fit rested on mission control
export function roomOf(islands: Island[], l: Layout, win: { w: number; h: number }, crew: Crew = {}, below?: Below): { w: number; h: number } {
  const plain = fitAll(islands, win, crew);
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
export function clampPan(islands: Island[], l: Layout, win: { w: number; h: number }, pan: { x: number; y: number }, crew: Crew = {}): { x: number; y: number } {
  const b = worldBounds(islands, crew, l.scale);
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
