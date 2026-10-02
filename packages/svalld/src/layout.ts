import { HOME_ISLAND, SPACING, byCell, cellKey, crewGrid, homeSizeFor, homeSlots, isLand, landCells, pillWidth, type Cell, type FleetState, type Footprint, type Island, type Size } from '@svall/protocol';
import type { Logger } from './log.js';

export const GAP = 2;
// the next island's label pill floats above its ground, so rows of islands keep a row of water either side of it
export const ROW_GAP = 3;
// mission control draws as a fixed strip at the foot of the screen and the view already keeps the fleet
// out from under it, so the floor only has to read as water: one row, not the gap between two islands
export const HOME_GAP = 1;
const ROW_LENGTH = 4;

export const randomSeed = (): number => Math.floor(Math.random() * 2 ** 31);

// mission control keeps its own row at the foot of the world; the islands above it are the ones that move.
// a folded island is off the map and holds no ground
export const worldIslands = (state: FleetState): Island[] => Object.values(state.islands).filter((i) => i.kind !== 'home' && !i.collapsed);

// footprints separated by at least `margin` cells do not intersect
export function clearBy(a: Footprint, b: Footprint, margin: number): boolean {
  return a.position.x + a.size.w + margin <= b.position.x || b.position.x + b.size.w + margin <= a.position.x ||
    a.position.y + a.size.h + margin <= b.position.y || b.position.y + b.size.h + margin <= a.position.y;
}

// the two may stand where they are: a cell of water between them
export const clearOf = (a: Island, b: Island): boolean => clearBy(a, b, 1);

// how far the search walks from the wanted cell before it gives up
const REACH = 80;

const fits = (state: FleetState, island: Island, margin: number, floor: boolean): boolean => Boolean(island.collapsed) ||
  ((!floor || aboveHome(state, island)) && worldIslands(state).every((o) => o.id === island.id || clearBy(o, island, margin)));

// the island's own position whenever it is legal, else the closest spot that clears its neighbours by
// GAP, walking outwards a cell at a time and preferring to stay on the same row.
// `floor` keeps the result off mission control's row, for callers placing into a fleet that has already settled
export function freePosition(state: FleetState, island: Island, floor = false): Cell {
  const wanted = island.position;
  const at = (position: Cell): Island => ({ ...island, position });
  if (fits(state, at(wanted), 1, floor)) return wanted;
  for (const margin of [GAP, 1]) {
    for (let r = 0; r <= REACH; r++) {
      for (const c of ring(wanted, r)) {
        if (fits(state, at(c), margin, floor)) return c;
      }
    }
  }
  return wanted;
}

// the cells at Chebyshev distance r from `at`, nearest row first so an island slides sideways before it drops
function ring(at: Cell, r: number): Cell[] {
  if (r === 0) return [at];
  const out: Cell[] = [];
  for (let dy = -r; dy <= r; dy++) {
    const xs = Math.abs(dy) === r ? Array.from({ length: 2 * r + 1 }, (_, i) => i - r) : [-r, r];
    for (const dx of xs) out.push({ x: at.x + dx, y: at.y + dy });
  }
  return out.sort((a, b) => Math.abs(a.y - at.y) - Math.abs(b.y - at.y) || Math.abs(a.x - at.x) - Math.abs(b.x - at.x));
}

export const placementOk = (state: FleetState, island: Island): boolean => fits(state, island, 1, false);

// how many rounds a push may travel before the fleet is called settled
const PASSES = 16;

// an island stands legally when it clears every other island and keeps off mission control's row
const settled = (state: FleetState, island: Island): boolean => fits(state, island, 1, true);

// the island that changed keeps the ground it asked for, past mission control's row too; the fleet around it yields,
// one round after another, until every island is clear again. a round that moves nothing has nowhere left to go,
// and the islands it could not settle are the caller's sign that the search ran out
export function makeRoom(draft: FleetState, islandId: string): number {
  const island = draft.islands[islandId];
  if (!island || island.kind === 'home') return 0;
  for (let pass = 0; pass < PASSES; pass++) {
    const crowded = worldIslands(draft).filter((o) => o.id !== islandId && !settled(draft, o));
    if (crowded.length === 0) break;
    let moved = 0;
    for (const o of crowded) {
      const to = freePosition(draft, o, true);
      if (to.x !== o.position.x || to.y !== o.position.y) moved++;
      draft.islands[o.id].position = to;
    }
    if (moved === 0) break;
  }
  return worldIslands(draft).filter((o) => o.id !== islandId && !settled(draft, o)).length;
}

// a hidden island takes its ground back where it stands, and whatever stands there yields
export function unfold(draft: FleetState, islandId: string, log?: Logger): void {
  const island = draft.islands[islandId];
  delete island.collapsed;
  const crowded = makeRoom(draft, islandId);
  if (crowded > 0) log?.error(`island ${island.name}: ${crowded} island(s) the search could not settle`);
}

// the lowest row the fleet puts an island on of its own accord: mission control's row is the floor of the world
export function aboveHome(state: FleetState, island: Island): boolean {
  const home = state.islands[HOME_ISLAND];
  if (!home || island.id === home.id) return true;
  return island.position.y + island.size.h <= home.position.y;
}

// mission control follows the fleet down whenever an island lands past its row, and never rises again on its
// own. it drops to the island's foot, not a gap below it, so an island put on its row stays where it was put
export function sinkHome(draft: FleetState): void {
  const home = draft.islands[HOME_ISLAND];
  if (!home) return;
  const floor = fleetFloor(draft, 0);
  if (floor !== undefined && floor > home.position.y) home.position.y = floor;
}

// mission control takes its place one gap under the fleet: on a fresh start, and whenever an island leaves
export function settleHome(draft: FleetState): void {
  const home = draft.islands[HOME_ISLAND];
  if (!home) return;
  const floor = fleetFloor(draft, HOME_GAP);
  if (floor !== undefined) home.position.y = floor;
}

// the slots up to and including mission control's last crew member
const slotsInUse = (draft: FleetState, home: Island): number => {
  const last = Math.max(0, ...Object.values(draft.characters).filter((c) => c.islandId === HOME_ISLAND).map((c) => c.cell.x));
  return homeSlots(home.size.w).filter((x) => x <= last).length;
};

// mission control drops the empty slots past its last crew member but the one arrange may give it, down to two slots; no one moves
export function trimHome(draft: FleetState): void {
  const home = draft.islands[HOME_ISLAND];
  if (!home) return;
  const { w } = homeSizeFor(slotsInUse(draft, home) + 1);
  if (w < home.size.w) home.size = { ...home.size, w };
}

// arrange gives mission control an empty slot past its crew when the map has room for that width, in cells, and none when not
function widenHome(draft: FleetState, room: number): void {
  const home = draft.islands[HOME_ISLAND];
  if (!home) return;
  const used = slotsInUse(draft, home);
  const roomy = homeSizeFor(used + 1);
  home.size = { ...home.size, w: roomy.w <= room ? roomy.w : homeSizeFor(used).w };
}

const fleetFloor = (state: FleetState, gap: number): number | undefined => {
  const islands = worldIslands(state);
  return islands.length ? Math.max(...islands.map((i) => i.position.y + i.size.h)) + gap : undefined;
};

// islands created by default share a row (same y); the last row fills up to ROW_LENGTH, then a new row starts below everything
export function defaultPosition(state: FleetState): Cell {
  const islands = worldIslands(state);
  if (islands.length === 0) return { x: 0, y: 0 };
  const y = Math.max(...islands.map((i) => i.position.y));
  const row = islands.filter((i) => i.position.y === y);
  if (row.length < ROW_LENGTH) return { x: Math.max(...row.map((i) => i.position.x + i.size.w)) + GAP, y };
  return { x: Math.min(...islands.map((i) => i.position.x)), y: Math.max(...islands.map((i) => i.position.y + i.size.h)) + GAP };
}

// what an island shows: its ground, never narrower than its label pill, which floats above the island and would
// otherwise hang over a neighbour's cards
const shown = (i: Island): Size => ({ w: Math.max(i.size.w, pillWidth(i.name)), h: i.size.h });

// the crew of an island, in reading order of where they stand
export const crewOf = (state: FleetState, islandId: string): string[] =>
  Object.values(state.characters).filter((c) => c.islandId === islandId).sort(byCell).map((c) => c.id);

// however wide the window, a crew stands at most about twice as many abreast as deep, so a long crew wraps
// into a rounder island instead of running out into a single row
const widest = (n: number): number => Math.max(3, Math.ceil(Math.sqrt(2 * n)));
const roundGrid = (n: number, abreast: number) => crewGrid(n, Math.min(abreast, widest(n)));

// what the map draws round the fleet in cells, as its world bounds do: the label band over the first row. Its margins
// are screen px, which already come off the aspect the app sends
const FRAME = { w: 0, h: 0, label: 1.3 };

type Box = { id: string; size: Size };
type Plan = { rows: Box[][]; width: number; height: number; scale: number };

// boxes in order, a row broken whenever the next would reach past `width`
function shelves(boxes: Box[], width: number, gap: number): Box[][] {
  const rows: Box[][] = [];
  let row: Box[] = [], used = 0;
  for (const b of boxes) {
    if (row.length > 0 && used + gap + b.size.w > width) { rows.push(row); row = []; used = 0; }
    row.push(b);
    used += (row.length > 1 ? gap : 0) + b.size.w;
  }
  if (row.length > 0) rows.push(row);
  return rows;
}

const span = (row: Box[], gap: number): number => row.reduce((w, b) => w + b.size.w, 0) + gap * (row.length - 1);

// the islands wrapped in order; of every row width, the one a window of that aspect shows largest
function plan(lands: Box[], aspect: number): Plan {
  let best: Plan | undefined;
  const widest = Math.max(...lands.map((b) => b.size.w));
  const longest = span(lands, GAP);
  for (let w = widest; w <= longest; w++) {
    const rows = shelves(lands, w, GAP);
    const width = Math.max(...rows.map((r) => span(r, GAP)));
    const landH = rows.reduce((h, r) => h + Math.max(...r.map((b) => b.size.h)), 0) + ROW_GAP * (rows.length - 1);
    const height = FRAME.label + landH + FRAME.h;
    const scale = Math.min(aspect / (width + FRAME.w), 1 / height);
    if (!best || scale > best.scale) best = { rows, width, height, scale };
  }
  return best!;
}

// every island on the map cut to a grid its crew's cards fit on and the fleet packed to fill a window of that aspect,
// in centred rows with mission control under them; a folded island keeps its place and size for when it unfolds.
// how many crew stand abreast is chosen with the rows, so a wide window gets long islands and a tall one deep islands.
// homeRoom is the widest mission control, in cells, the map has room for
export function arrangeFleet(draft: FleetState, aspect = 4 / 3, homeRoom?: number): void {
  if (homeRoom !== undefined) widenHome(draft, homeRoom);
  const islands = worldIslands(draft).sort((a, b) => a.position.y - b.position.y || a.position.x - b.position.x || a.id.localeCompare(b.id));
  if (islands.length === 0) return;
  const origin = { x: Math.min(...islands.map((i) => i.position.x)), y: Math.min(...islands.map((i) => i.position.y)) };
  const crews = new Map(islands.map((i) => [i.id, crewOf(draft, i.id)]));

  const box = (i: Island): Box => ({ id: i.id, size: shown(draft.islands[i.id]) });
  const most = Math.max(1, ...[...crews.values()].map((c) => c.length));
  let best: (Plan & { abreast: number }) | undefined;
  // three abreast first, so it stands whenever another count only matches it
  for (const abreast of [3, ...Array.from({ length: Math.min(most, widest(most)) }, (_, i) => i + 1).filter((k) => k !== 3)]) {
    for (const { id } of islands) draft.islands[id].size = roundGrid(crews.get(id)!.length, abreast).size;
    // tallest first, so each row wastes the least water under its shorter islands
    const next = plan(islands.map(box).sort((a, b) => b.size.h - a.size.h), aspect);
    if (!best || next.scale > best.scale) best = { ...next, abreast };
  }
  const { abreast, rows, width, height } = best!;
  // the height the window has to spare at that width is shared between the rows, so the fleet fills it
  const gaps = rows.length - 1;
  const extra = gaps > 0 ? Math.floor(Math.max(0, (width + FRAME.w) / aspect - height) / gaps) : 0;
  for (const { id } of islands) {
    const { size, cells } = roundGrid(crews.get(id)!.length, abreast);
    draft.islands[id].size = size;
    crews.get(id)!.forEach((c, i) => { draft.characters[c].cell = cells[i]; });
  }

  let y = origin.y;
  for (const r of rows) {
    let x = origin.x + Math.round((width - span(r, GAP)) / 2);
    for (const b of r) {
      // an island narrower than its label stands centred under it
      const island = draft.islands[b.id];
      island.position = { x: x + Math.round((b.size.w - island.size.w) / 2), y };
      x += b.size.w + GAP;
    }
    y += Math.max(...r.map((b) => b.size.h)) + ROW_GAP + extra;
  }
  settleHome(draft);
}

export function occupiedCells(state: FleetState, islandId: string, exceptId?: string): Set<string> {
  return new Set(Object.values(state.characters).filter((c) => c.islandId === islandId && c.id !== exceptId).map((c) => cellKey(c.cell)));
}

// characters keep two empty cells between them: every occupied cell blocks everything within Chebyshev distance SPACING
export function blockedCells(state: FleetState, islandId: string, exceptId?: string): Set<string> {
  const blocked = new Set<string>();
  for (const c of Object.values(state.characters)) {
    if (c.islandId !== islandId || c.id === exceptId) continue;
    for (let dy = -SPACING; dy <= SPACING; dy++) for (let dx = -SPACING; dx <= SPACING; dx++) blocked.add(cellKey({ x: c.cell.x + dx, y: c.cell.y + dy }));
  }
  return blocked;
}

export function nearestFreeLand(island: Island, from: Cell, blocked: Set<string>): Cell | undefined {
  const dist = (c: Cell) => Math.abs(c.x - from.x) + Math.abs(c.y - from.y);
  return landCells(island.size).filter((c) => !blocked.has(cellKey(c))).sort((a, b) => dist(a) - dist(b))[0];
}

class NoFreeLand extends Error { code = 'invalid'; }

// characters whose cell became water move to the nearest free land, in reading order of their old cells;
// shared by island resize and by placeOnIsland's auto-grow, both of which can change the island's shape
export function relocateDrowned(draft: FleetState, islandId: string): void {
  const island = draft.islands[islandId];
  const drowned = Object.values(draft.characters)
    .filter((c) => c.islandId === islandId && !isLand(island, c.cell))
    .sort(byCell);
  for (const c of drowned) {
    const cell = nearestFreeLand(island, c.cell, blockedCells(draft, islandId, c.id));
    if (!cell) throw new NoFreeLand(`island ${island.name} has no free land to relocate ${c.name}`);
    draft.characters[c.id].cell = cell;
  }
}

// names resolve without regard to case, so a twin differing only in case would leave both islands unreachable by name
export function uniqueName(state: FleetState, base: string): string {
  const taken = new Set(Object.values(state.islands).map((i) => i.name.toLowerCase()));
  const free = (name: string) => !taken.has(name.toLowerCase());
  if (free(base)) return base;
  let n = 2;
  while (!free(`${base} ${n}`)) n++;
  return `${base} ${n}`;
}
