import { HOME_ISLAND, HOME_ROW, homeSlots, type Cell, type Character, type FleetState, type Island } from '@archipelago/protocol';
import { charactersOf, homeIsland } from '../selectors.js';
import { theme } from '../theme.js';
import type { Drag } from './types.js';

// the visible strip of home land, in map px: centred, theme.home.visible tall, flush with the bottom edge
export type HomeBox = { x: number; y: number; w: number; h: number };

export function homeBox(island: Island, host: { w: number; h: number }, shift = 0): HomeBox {
  const w = island.size.w * theme.cell;
  return { x: (host.w - w) / 2 + shift, y: host.h - theme.home.visible, w, h: theme.home.visible };
}

export const inHomeBox = (b: HomeBox, p: { x: number; y: number }): boolean =>
  p.x >= b.x && p.x < b.x + b.w && p.y >= b.y && p.y < b.y + b.h;

// the slot whose card centre is nearest the pointer, always on the crew row
export function homeSlotAt(island: Island, b: HomeBox, p: { x: number }): Cell {
  const col = (p.x - b.x) / theme.cell - 0.5;
  const slots = homeSlots(island.size.w);
  const x = slots.reduce((best, s) => (Math.abs(s - col) < Math.abs(best - col) ? s : best), slots[0]);
  return { x, y: HOME_ROW };
}

// map px of a home cell's top-left corner; home never scales
export const homeCellToScreen = (b: HomeBox, cell: Cell): { x: number; y: number } =>
  ({ x: b.x + cell.x * theme.cell, y: b.y + cell.y * theme.cell });

// the map height mission control keeps: its row, where that row hangs, and the water above the pill
export const homeReserve = (collapsed: boolean): number =>
  (collapsed ? theme.home.bar : theme.home.visible + theme.home.rowGap) + theme.home.row + theme.home.water;

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
