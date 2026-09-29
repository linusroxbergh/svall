import { HOME_ISLAND, HOME_ROW, SPACING, homeSlots, type Cell, type Character, type FleetState, type Island } from '@svall/protocol';
import { charactersOf, homeIsland } from '../selectors.js';
import { theme } from '../theme.js';
import { characterAt, type Block } from './layout.js';
import { ISLET, placeIslet } from './resources.js';
import type { Drag } from './types.js';

// the visible strip of home land, in map px: centred, theme.home.visible tall, flush with the bottom edge, and the
// size of a cell on it, all drawn at `scale`
export type HomeBox = { x: number; y: number; w: number; h: number; cell: number };

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
export function homeBlocks(island: Island, host: { w: number; h: number }, measured: { w: number; h: number }): Block[] {
  const place = placeIslet(host.w, island.size.w * theme.cell, Boolean(island.collapsed));
  const pad = theme.home.water, top = host.h - homeReserve(Boolean(island.collapsed), measured.h, place.homeScale);
  const rowFoot = host.h - (island.collapsed ? theme.home.bar : theme.home.visible * place.homeScale + theme.home.rowGap);
  const row = { x: host.w / 2 + place.homeShift - measured.w / 2 - pad, w: measured.w + 2 * pad, top, bottom: rowFoot + pad };
  if (island.collapsed) return [row];
  const land = homeBox(island, host, place.homeShift, place.homeScale);
  const blocks = [row, { x: land.x - pad, w: land.w + 2 * pad, top: land.y - pad }];
  if (place.mode === 'pair') blocks.push({ x: place.cx - (ISLET.w * place.scale) / 2 - pad, w: ISLET.w * place.scale + 2 * pad, top });
  return blocks;
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
