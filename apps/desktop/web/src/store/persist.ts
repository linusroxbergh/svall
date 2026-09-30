import type { Tier } from '../resources/model.js';
import { readSettings, type Settings } from '../settings.js';
import type { View } from './ui.js';

// the half card's footprint as a fraction of the map, so one window size carries to the next; the first leaves about
// a twentieth of the map around it
export type HalfCard = { w: number; h: number };
export const DEFAULT_HALF_CARD: HalfCard = { w: 0.9, h: 0.88 };
export const HALF_CARD_RANGE = { min: 0.22, max: 0.98 };
// the widths of the shelf's Where and Which columns, in pixels; What is fixed and the editor takes what is left
export type ResourceCols = { rail: number; list: number };
export const DEFAULT_RESOURCE_COLS: ResourceCols = { rail: 216, list: 262 };
export const RESOURCE_COL_RANGE = { rail: { min: 160, max: 360 }, list: { min: 180, max: 560 } };
export const clampCols = (c: ResourceCols): ResourceCols => ({
  rail: Math.round(Math.min(RESOURCE_COL_RANGE.rail.max, Math.max(RESOURCE_COL_RANGE.rail.min, c.rail))),
  list: Math.round(Math.min(RESOURCE_COL_RANGE.list.max, Math.max(RESOURCE_COL_RANGE.list.min, c.list))),
});
// how wide the two sidebars stand, in pixels
export type SideWidths = { sidebar: number; card: number };
export const DEFAULT_SIDE_WIDTHS: SideWidths = { sidebar: 258, card: 320 };
export const SIDE_WIDTH_RANGE = { sidebar: { min: 180, max: 480 }, card: { min: 240, max: 560 } };
export const clampSides = (w: SideWidths): SideWidths => ({
  sidebar: Math.round(Math.min(SIDE_WIDTH_RANGE.sidebar.max, Math.max(SIDE_WIDTH_RANGE.sidebar.min, w.sidebar))),
  card: Math.round(Math.min(SIDE_WIDTH_RANGE.card.max, Math.max(SIDE_WIDTH_RANGE.card.min, w.card))),
});
// the Files viewer's tree, shown or folded, and the width in pixels it was dragged to; no width is the default
export type FilesTree = { open: boolean; width?: number };
export const FILES_TREE_RANGE = { min: 140, max: 560 };
export const clampTree = (w: number): number => Math.round(Math.min(FILES_TREE_RANGE.max, Math.max(FILES_TREE_RANGE.min, w)));

export type AppStorage = {
  getFocus(): string | undefined; setFocus(id: string): void;
  getView(): View | undefined; setView(v: View): void;
  getSidebarOpen(): boolean | undefined; setSidebarOpen(v: boolean): void;
  getSettings(): Settings | undefined; setSettings(v: Settings): void;
  getHalfCard(): HalfCard | undefined; setHalfCard(v: HalfCard): void;
  getResourceCols(): ResourceCols | undefined; setResourceCols(v: ResourceCols): void;
  getResourceGroups(): Tier[] | undefined; setResourceGroups(v: Tier[]): void;
  getSideWidths(): SideWidths | undefined; setSideWidths(v: SideWidths): void;
  getFilesTree(): FilesTree | undefined; setFilesTree(v: FilesTree): void;
};

const FOCUS_KEY = 'svall.focused';
const VIEW_KEY = 'svall.view';
const SIDEBAR_KEY = 'svall.sidebar.open';
const HALF_KEY = 'svall.card.half';
const COLS_KEY = 'svall.resources.cols';
const GROUPS_KEY = 'svall.resources.tiers';
// read until GROUPS_KEY is written; Fleet opens with Global
const OLD_GROUPS_KEY = 'svall.resources.groups';
const SIDES_KEY = 'svall.side.widths';
const TREE_KEY = 'svall.files.tree';
export const SETTINGS_KEY = 'svall.settings';

const isView = (v: unknown): v is View => v === 'map' || v === 'board';
const readJson = <T,>(raw: string | null, ok: (v: unknown) => v is T): T | undefined => {
  if (raw === null) return undefined;
  try { const v: unknown = JSON.parse(raw); return ok(v) ? v : undefined; } catch { return undefined; }
};
const isHalf = (v: unknown): v is HalfCard =>
  typeof v === 'object' && v !== null && typeof (v as HalfCard).w === 'number' && typeof (v as HalfCard).h === 'number';
const isCols = (v: unknown): v is ResourceCols =>
  typeof v === 'object' && v !== null && typeof (v as ResourceCols).rail === 'number' && typeof (v as ResourceCols).list === 'number';
const TIER_NAMES = ['global', 'fleet', 'repo', 'island', 'character'];
const isTiers = (v: unknown): v is Tier[] => Array.isArray(v) && v.every((t) => TIER_NAMES.includes(t as string));
const withFleet = (v: Tier[] | undefined): Tier[] | undefined => (v?.includes('global') ? [...v, 'fleet'] : v);
const isSides = (v: unknown): v is SideWidths =>
  typeof v === 'object' && v !== null && typeof (v as SideWidths).sidebar === 'number' && typeof (v as SideWidths).card === 'number';
const isTree = (v: unknown): v is FilesTree =>
  typeof v === 'object' && v !== null && typeof (v as FilesTree).open === 'boolean' && ['number', 'undefined'].includes(typeof (v as FilesTree).width);

// every fleet's window shares one localStorage, so a fleet keeps its keys under its home and reads
// the unscoped key until it has written its own
export function localAppStorage(fleet?: string): AppStorage | undefined {
  try {
    const ls = globalThis.localStorage;
    ls.getItem(FOCUS_KEY);
    const own = (k: string) => (fleet ? `${k}@${fleet}` : k);
    const read = (k: string) => ls.getItem(own(k)) ?? ls.getItem(k);
    // a store that is full or switched off must not take the state change down with it
    const write = (k: string, v: string) => { try { ls.setItem(own(k), v); } catch { /* remembered, not required */ } };
    return {
      getFocus: () => read(FOCUS_KEY) ?? undefined,
      setFocus: (id) => write(FOCUS_KEY, id),
      getView: () => { const v = read(VIEW_KEY); return isView(v) ? v : undefined; },
      setView: (v) => write(VIEW_KEY, v),
      getSidebarOpen: () => { const v = read(SIDEBAR_KEY); return v === null ? undefined : v === 'true'; },
      setSidebarOpen: (v) => write(SIDEBAR_KEY, String(v)),
      getHalfCard: () => readJson(read(HALF_KEY), isHalf),
      setHalfCard: (v) => write(HALF_KEY, JSON.stringify(v)),
      getResourceCols: () => { const c = readJson(read(COLS_KEY), isCols); return c && clampCols(c); },
      setResourceCols: (v) => write(COLS_KEY, JSON.stringify(v)),
      getResourceGroups: () => readJson(read(GROUPS_KEY), isTiers) ?? withFleet(readJson(read(OLD_GROUPS_KEY), isTiers)),
      setResourceGroups: (v) => write(GROUPS_KEY, JSON.stringify(v)),
      getSideWidths: () => { const w = readJson(read(SIDES_KEY), isSides); return w && clampSides(w); },
      setSideWidths: (v) => write(SIDES_KEY, JSON.stringify(v)),
      getFilesTree: () => { const t = readJson(read(TREE_KEY), isTree); return t?.width === undefined ? t : { ...t, width: clampTree(t.width) }; },
      setFilesTree: (v) => write(TREE_KEY, JSON.stringify(v)),
      getSettings: () => { const raw = read(SETTINGS_KEY); if (raw === null) return undefined; try { return readSettings(JSON.parse(raw)); } catch { return undefined; } },
      setSettings: (v) => write(SETTINGS_KEY, JSON.stringify(v)),
    };
  } catch {
    return undefined;
  }
}
