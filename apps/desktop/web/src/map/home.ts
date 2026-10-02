import { HOME_ISLAND, HOME_ROW, SPACING, homeSlots, type Cell, type Character, type FleetState, type Island, type Size } from '@svall/protocol';
import { charactersOf, homeIsland } from '../selectors.js';
import { theme } from '../theme.js';
import { cardScale, characterAt, fitAll, roomOf, type Below, type Block, type Crew, type Layout } from './layout.js';
import { ISLET, placeIslet } from './resources.js';
import type { Drag } from './types.js';

// the visible strip of home land, in map px: centred, theme.home.visible tall, flush with the bottom edge, and the
// size of a cell on it, all drawn at `scale`
type HomeBox = { x: number; y: number; w: number; h: number; cell: number };

export function homeBox(island: Island, host: { w: number; h: number }, shift = 0, scale = 1): HomeBox {
  const cell = theme.cell * scale, w = island.size.w * cell, h = theme.home.visible * scale;
  return { x: (host.w - w) / 2 + shift, y: host.h - h, w, h, cell };
}

export const inHomeBox = (b: HomeBox, p: { x: number; y: number }): boolean =>
  p.x >= b.x && p.x < b.x + b.w && p.y >= b.y && p.y < b.y + b.h;

// the slot whose card centre is nearest the pointer, always on the crew row; a card joining a full row may also take
// the slot past its last
export function homeSlotAt(island: Island, b: HomeBox, p: { x: number }, joining = false): Cell {
  const col = (p.x - b.x) / b.cell - 0.5;
  const slots = homeSlots(island.size.w);
  if (joining) slots.push(slots.at(-1)! + SPACING + 1);
  const x = slots.reduce((best, s) => (Math.abs(s - col) < Math.abs(best - col) ? s : best), slots[0]);
  return { x, y: HOME_ROW };
}

// every slot is taken by someone other than this card, so it joins only by widening the row
export const homeFull = (fleet: FleetState, island: Island, id: string): boolean =>
  homeSlots(island.size.w).every((x) => { const o = characterAt(fleet, island.id, { x, y: HOME_ROW }); return o !== undefined && o.id !== id; });

// map px of a home cell's top-left corner
export const homeCellToScreen = (b: HomeBox, cell: Cell): { x: number; y: number } =>
  ({ x: b.x + cell.x * b.cell, y: b.y + cell.y * b.cell });

// the map height mission control keeps: its row, where that row hangs over land drawn at `scale`, and the water above the pill
export const homeReserve = (collapsed: boolean, row = theme.home.row, scale = 1): number =>
  (collapsed ? theme.home.bar : theme.home.visible * scale + theme.home.rowGap) + row + theme.home.water;

// what mission control stands on the map's foot with, each grown by the water the fleet keeps from it: its label row
// at its measured size, as tall as it has wrapped to, the land under the row and the resources islet, taken as tall as the row
export function homeBlocks(island: Island, host: { w: number; h: number }, measured: { w: number; h: number }, most = 1): Block[] {
  const place = placeIslet(host.w, island.size.w * theme.cell, Boolean(island.collapsed), most);
  const pad = theme.home.water, top = host.h - homeReserve(Boolean(island.collapsed), measured.h, place.homeScale);
  const rowFoot = host.h - (island.collapsed ? theme.home.bar : theme.home.visible * place.homeScale + theme.home.rowGap);
  const row = { x: host.w / 2 + place.homeShift - measured.w / 2 - pad, w: measured.w + 2 * pad, top, bottom: rowFoot + pad };
  if (island.collapsed) return [row];
  const land = homeBox(island, host, place.homeShift, place.homeScale);
  const blocks = [row, { x: land.x - pad, w: land.w + 2 * pad, top: land.y - pad }];
  if (place.mode === 'pair') blocks.push({ x: place.cx - (ISLET.w * place.scale) / 2 - pad, w: ISLET.w * place.scale + 2 * pad, top });
  return blocks;
}

// the cap on mission control's scale that agrees with the map it leaves room for: its cards stand as big as the
// islands', and a smaller home gives the fleet more room, so the two settle together
export function homeCap(scaleAt: (most: number) => number): number {
  if (cardScale(scaleAt(1)) >= 1) return 1;
  let lo = cardScale(theme.scale.min), hi = 1;
  for (let n = 0; n < 12; n++) { const mid = (lo + hi) / 2; if (cardScale(scaleAt(mid)) >= mid) lo = mid; else hi = mid; }
  return lo;
}

type Fitted = { fit: Layout; win: Size; room: Size; most: number };

let last: { key: string; fitted: Fitted } | undefined;

// the map fitted round the fleet with mission control's size solved alongside, and `most`, the cap home is drawn at. The
// last answer is kept, so a pan or a patch that moves nothing the fit reads costs nothing
export function fitWithHome(islands: Island[], crew: Crew, host: Size, home: Island | undefined, row: Size): Fitted {
  const key = JSON.stringify([islands.map((i) => [i.id, i.name, i.position, i.size]), crew, host, home && [home.size.w, home.collapsed, home.position.y], row]);
  if (last?.key === key) return last.fitted;
  const collapsed = Boolean(home?.collapsed);
  const at = (most: number) => {
    const scale = home ? placeIslet(host.w, home.size.w * theme.cell, collapsed, most).homeScale : 1;
    const win = { w: host.w, h: host.h - homeReserve(collapsed, row.h, scale) };
    const below: Below | undefined = home && { h: host.h, blocks: homeBlocks(home, host, row, most), row: home.position.y };
    return { win, below, fit: fitAll(islands, win, crew, below) };
  };
  const cap = home && !collapsed ? homeCap((m) => at(m).fit.scale) : 1;
  const { win, below, fit } = at(cap);
  // a folded home has no land to shrink; it keeps the cap island cards stand at, so it unfolds at their size
  const most = collapsed ? Math.min(1, cardScale(fit.scale)) : cap;
  const fitted = { fit, win, most, room: roomOf(islands, fit, win, crew, below) };
  last = { key, fitted };
  return fitted;
}

// home's crew, minus one being dragged away, plus a visitor while it hovers over home
export function homeCrew(f: FleetState, drag: Drag | undefined): Character[] {
  if (!homeIsland(f)) return [];
  const overHome = drag?.kind === 'figure' && drag.over?.islandId === HOME_ISLAND ? drag : undefined;
  const visitor = overHome ? f.characters[overHome.id] : undefined;
  return [
    ...charactersOf(f, HOME_ISLAND).filter((c) => !(drag?.kind === 'figure' && drag.id === c.id && !overHome)),
    ...(visitor && visitor.islandId !== HOME_ISLAND ? [visitor] : []),
  ];
}
