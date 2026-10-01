import { HOME_ISLAND, SPACING, cellKey, ground, homeSizeFor, homeSlots, isLand, landCells, pillWidth, sizeForCrew, type Cell, type FleetState, type Footprint, type Island, type Size } from '@svall/protocol';

export { ground, pillWidth };

export const GAP = 2;
// the next island's label pill floats above its ground, so rows of islands keep a row of water either side of it
export const ROW_GAP = 3;
// mission control draws as a fixed strip at the foot of the screen and the view already keeps the fleet
// out from under it, so the floor only has to read as water: one row, not the gap between two islands
export const HOME_GAP = 1;
// the row mission control's floor keeps under the lowest island: its own. the gap above is where arrange leaves the fleet
export const HOME_REACH = 0;
const ROW_LENGTH = 4;

export const randomSeed = (): number => Math.floor(Math.random() * 2 ** 31);

// mission control keeps its own row at the foot of the world; the islands above it are the ones that move
export const worldIslands = (state: FleetState): Island[] => Object.values(state.islands).filter((i) => i.kind !== 'home');

// footprints separated by at least `margin` cells do not intersect
export function clearBy(a: Footprint, b: Footprint, margin: number): boolean {
  return a.position.x + a.size.w + margin <= b.position.x || b.position.x + b.size.w + margin <= a.position.x ||
    a.position.y + a.size.h + margin <= b.position.y || b.position.y + b.size.h + margin <= a.position.y;
}

// islands keep a cell of water between them; a label pill asks for none
const gapFor = (a: Island, b: Island, margin: number): number => (a.collapsed || b.collapsed ? 0 : margin);

// the two may stand where they are: what each holds is its footprint, or its label pill once folded
export const clearOf = (a: Island, b: Island): boolean => clearBy(ground(a), ground(b), gapFor(a, b, 1));

// how far the search walks from the wanted cell before it gives up
const REACH = 80;

const fits = (state: FleetState, island: Island, margin: number, floor: boolean): boolean =>
  (!floor || aboveHome(state, island)) && worldIslands(state).every((o) => o.id === island.id || clearBy(ground(o), ground(island), gapFor(o, island, margin)));

// the island's own position whenever it is legal, else the closest spot that clears its neighbours by
// GAP, walking outwards a cell at a time and preferring to stay on the same row. a candidate carries the
// island's fold, so it is weighed by the ground it would hold — its label pill once folded — as neighbours are
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

// the lowest row the fleet puts an island on of its own accord: mission control's row is the floor of the world
export function aboveHome(state: FleetState, island: Island): boolean {
  const home = state.islands[HOME_ISLAND];
  if (!home || island.id === home.id) return true;
  const g = ground(island);
  return g.position.y + g.size.h + HOME_REACH <= home.position.y;
}

// mission control follows the fleet down whenever an island lands past its row, and never rises again on its
// own. it gives way by the reach, not the gap, so an island put on its row stays where it was put
export function sinkHome(draft: FleetState): void {
  const home = draft.islands[HOME_ISLAND];
  if (!home) return;
  const floor = fleetFloor(draft, HOME_REACH);
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
  const grounds = worldIslands(state).map(ground);
  return grounds.length ? Math.max(...grounds.map((i) => i.position.y + i.size.h)) + gap : undefined;
};

// islands created by default share a row (same y); the last row fills up to ROW_LENGTH, then a new row starts below everything
export function defaultPosition(state: FleetState): Cell {
  const islands = worldIslands(state).map(ground);
  if (islands.length === 0) return { x: 0, y: 0 };
  const y = Math.max(...islands.map((i) => i.position.y));
  const row = islands.filter((i) => i.position.y === y);
  if (row.length < ROW_LENGTH) return { x: Math.max(...row.map((i) => i.position.x + i.size.w)) + GAP, y };
  return { x: Math.min(...islands.map((i) => i.position.x)), y: Math.max(...islands.map((i) => i.position.y + i.size.h)) + GAP };
}

// what an island shows: its ground, or its label pill alone once folded — and never narrower than that pill,
// which floats above the island and would otherwise hang over a neighbour's cards
const shown = (i: Island): Size => (i.collapsed ? ground(i).size : { w: Math.max(i.size.w, pillWidth(i.name)), h: i.size.h });

// the crew of an island, in reading order of where they stand
export const crewOf = (state: FleetState, islandId: string): string[] =>
  Object.values(state.characters).filter((c) => c.islandId === islandId)
    .sort((a, b) => a.cell.y - b.cell.y || a.cell.x - b.cell.x || a.id.localeCompare(b.id)).map((c) => c.id);

// at its largest against the cells a card is just under three wide, counting the rail of links down its
// right, and three and a half tall, hanging from a little above its cell: crew stand in a grid this far
// apart so the cards keep water between them
const CREW_PITCH = { x: 3, y: 4 };
// the cells between a crew member and the coast: half a card, so the card stands on visible land
export const CREW_INSET = 2;

// the ground a crew of n needs, and where each stands: a grid of at most `abreast` to a row, as square as that
// allows, the last row centred and the whole grid moved further in from the coast until every cell of it is land
export function crewGrid(n: number, seed: number, abreast = 3): { size: Size; cells: Cell[] } {
  if (n === 0) return { size: sizeForCrew(0, seed), cells: [] };
  const rows = Math.ceil(n / abreast), cols = Math.ceil(n / rows);
  for (let m = CREW_INSET; ; m++) {
    // a lone column stands a cell further in, so its card sits centred on an island of odd width
    const mx = cols === 1 ? m + 1 : m;
    const size = { w: CREW_PITCH.x * (cols - 1) + 1 + 2 * mx, h: CREW_PITCH.y * (rows - 1) + 1 + 2 * m };
    const cells = Array.from({ length: n }, (_, i) => {
      const row = Math.floor(i / cols), inRow = Math.min(cols, n - row * cols);
      return { x: mx + CREW_PITCH.x * (i % cols) + Math.round((CREW_PITCH.x * (cols - inRow)) / 2), y: m + CREW_PITCH.y * row };
    });
    const land = new Set(landCells(size, seed).map(cellKey));
    if (cells.every((c) => land.has(cellKey(c)))) return { size, cells };
  }
}

// however wide the window, a crew stands at most about twice as many abreast as deep, so a long crew wraps
// into a rounder island instead of running out into a single row
const widest = (n: number): number => Math.max(3, Math.ceil(Math.sqrt(2 * n)));
const roundGrid = (n: number, seed: number, abreast: number) => crewGrid(n, seed, Math.min(abreast, widest(n)));

// label pills stand a cell apart in rows stacked one on the next, and the band keeps a row of water above the labels below it
const PILL_GAP = 1;
const BAND_GAP = 3;
// what the map draws round the fleet in cells, as its world bounds do: the label band over the first row. Its margins
// are screen px, which already come off the aspect the app sends
const FRAME = { w: 0, h: 0, label: 1.3 };

type Box = { id: string; size: Size };
type Plan = { band: Box[][]; rows: Box[][]; width: number; height: number; scale: number };

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

// as few rows as `width` allows, dealt out so no row holds more than one box over another
function evenShelves(boxes: Box[], width: number, gap: number): Box[][] {
  const n = shelves(boxes, width, gap).length;
  const rows: Box[][] = [];
  for (let r = 0, at = 0; r < n; r++) {
    const take = Math.ceil((boxes.length - at) / (n - r));
    rows.push(boxes.slice(at, at + take));
    at += take;
  }
  return rows;
}

// the folded islands' pills as a band above the unfolded, each wrapped in order; of every row width, the one
// a window of that aspect shows largest
function plan(pills: Box[], lands: Box[], aspect: number): Plan {
  let best: Plan | undefined;
  const widest = Math.max(...pills.map((b) => b.size.w), ...lands.map((b) => b.size.w));
  const longest = Math.max(span(pills, PILL_GAP), span(lands, GAP));
  for (let w = widest; w <= longest; w++) {
    const band = evenShelves(pills, w, PILL_GAP), rows = shelves(lands, w, GAP);
    const width = Math.max(...band.map((r) => span(r, PILL_GAP)), ...rows.map((r) => span(r, GAP)));
    const top = band.length === 0 ? FRAME.label : band.length + (rows.length > 0 ? BAND_GAP : 0);
    const landH = rows.reduce((h, r) => h + Math.max(...r.map((b) => b.size.h)), 0) + ROW_GAP * Math.max(0, rows.length - 1);
    const height = top + landH + FRAME.h;
    const scale = Math.min(aspect / (width + FRAME.w), 1 / height);
    if (!best || scale > best.scale) best = { band, rows, width, height, scale };
  }
  return best!;
}

// every island cut to a grid its crew's cards fit on and the fleet packed to fill a window of that aspect: the
// folded islands as a band of label pills on top, the rest in centred rows under it, and mission control under them.
// how many crew stand abreast is chosen with the rows, so a wide window gets long islands and a tall one deep islands.
// homeRoom is the widest mission control, in cells, the map has room for
export function arrangeFleet(draft: FleetState, aspect = 4 / 3, homeRoom?: number): void {
  if (homeRoom !== undefined) widenHome(draft, homeRoom);
  const islands = worldIslands(draft).sort((a, b) => a.position.y - b.position.y || a.position.x - b.position.x || a.id.localeCompare(b.id));
  if (islands.length === 0) return;
  const grounds = islands.map(ground);
  const origin = { x: Math.min(...grounds.map((i) => i.position.x)), y: Math.min(...grounds.map((i) => i.position.y)) };
  const crews = new Map(islands.map((i) => [i.id, crewOf(draft, i.id)]));

  const box = (i: Island): Box => ({ id: i.id, size: shown(draft.islands[i.id]) });
  const most = Math.max(1, ...[...crews.values()].map((c) => c.length));
  let best: (Plan & { abreast: number }) | undefined;
  // three abreast first, so it stands whenever another count only matches it
  for (const abreast of [3, ...Array.from({ length: Math.min(most, widest(most)) }, (_, i) => i + 1).filter((k) => k !== 3)]) {
    for (const { id, seed } of islands) draft.islands[id].size = roundGrid(crews.get(id)!.length, seed, abreast).size;
    // the unfolded pack tallest first, so each row wastes the least water under its shorter islands
    const next = plan(islands.filter((i) => i.collapsed).map(box), islands.filter((i) => !i.collapsed).map(box).sort((a, b) => b.size.h - a.size.h), aspect);
    if (!best || next.scale > best.scale) best = { ...next, abreast };
  }
  const { abreast, band, rows, width, height } = best!;
  // the height the window has to spare at that width is shared between the band and the rows, so the fleet fills it
  const gaps = rows.length - 1 + (band.length > 0 && rows.length > 0 ? 1 : 0);
  const extra = gaps > 0 ? Math.floor(Math.max(0, (width + FRAME.w) / aspect - height) / gaps) : 0;
  for (const { id, seed } of islands) {
    const { size, cells } = roundGrid(crews.get(id)!.length, seed, abreast);
    draft.islands[id].size = size;
    crews.get(id)!.forEach((c, i) => { draft.characters[c].cell = cells[i]; });
  }

  let y = origin.y;
  for (const r of band) {
    let x = origin.x + Math.round((width - span(r, PILL_GAP)) / 2);
    for (const b of r) {
      // the folded island stands centred under its pill, two rows down, as ground() draws it
      const island = draft.islands[b.id];
      island.position = { x: x - Math.ceil((island.size.w - b.size.w) / 2), y: y + 2 };
      x += b.size.w + PILL_GAP;
    }
    y++;
  }
  if (band.length > 0) y += BAND_GAP + extra;

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
  return landCells(island.size, island.seed).filter((c) => !blocked.has(cellKey(c))).sort((a, b) => dist(a) - dist(b))[0];
}

class NoFreeLand extends Error { code = 'invalid'; }

// characters whose cell became water move to the nearest free land, in reading order of their old cells;
// shared by island resize and by placeOnIsland's auto-grow, both of which can change the island's shape
export function relocateDrowned(draft: FleetState, islandId: string): void {
  const island = draft.islands[islandId];
  const drowned = Object.values(draft.characters)
    .filter((c) => c.islandId === islandId && !isLand(island, c.cell))
    .sort((a, b) => a.cell.y - b.cell.y || a.cell.x - b.cell.x);
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
