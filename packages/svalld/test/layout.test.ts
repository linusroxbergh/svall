import { describe, expect, it } from 'vitest';
import { DEFAULT_SIZE, SPACING, emptyState, homeSizeFor, isLand, landCells, sizeForCrew, type FleetState, type Island } from '@svall/protocol';
import { CREW_INSET, GAP, HOME_GAP, HOME_REACH, ROW_GAP, aboveHome, arrangeFleet, crewGrid, blockedCells, clearBy, defaultPosition, freePosition, ground, makeRoom, nearestFreeLand, occupiedCells, pillWidth, placementOk, settleHome, sinkHome, uniqueName, worldIslands } from '../src/layout.js';

const island = (id: string, x: number, y: number, w = 6, h = 4): Island => ({ id, name: id, description: '', instructions: '', context: [], position: { x, y }, size: { w, h }, seed: 1 });
const withIslands = (...islands: Island[]): FleetState => ({ ...emptyState(), islands: Object.fromEntries(islands.map((i) => [i.id, i])) });

describe('footprints', () => {
  it('need a one-cell gap', () => {
    expect(clearBy(island('a', 0, 0), island('b', 6, 0), 1)).toBe(false);
    expect(clearBy(island('a', 0, 0), island('b', 7, 0), 1)).toBe(true);
    expect(clearBy(island('a', 0, 0), island('b', 0, 4), 1)).toBe(false);
    expect(clearBy(island('a', 0, 0), island('b', 0, 5), 1)).toBe(true);
    expect(clearBy(island('a', 0, 0), island('b', 3, 2), 1)).toBe(false);
  });
  it('placementOk ignores the island itself', () => {
    const s = withIslands(island('a', 0, 0), island('b', 10, 0));
    expect(placementOk(s, island('a', 0, 0))).toBe(true);
    expect(placementOk(s, island('a', 5, 0))).toBe(false);
    expect(placementOk(s, island('c', 20, 0))).toBe(true);
  });
});

describe('defaultPosition', () => {
  it('starts at the origin, then goes right with a two-cell gap', () => {
    expect(defaultPosition(withIslands())).toEqual({ x: 0, y: 0 });
    expect(defaultPosition(withIslands(island('a', 0, 0)))).toEqual({ x: 8, y: 0 });
    expect(defaultPosition(withIslands(island('a', 0, 0), island('b', 8, 0, 4, 3)))).toEqual({ x: 14, y: 0 });
  });
  it('wraps to a new row after four islands, below the tallest', () => {
    const row = [island('a', 0, 0), island('b', 8, 0, 6, 6), island('c', 16, 0), island('d', 24, 0)];
    expect(defaultPosition(withIslands(...row))).toEqual({ x: 0, y: 8 });
    expect(defaultPosition(withIslands(...row, island('e', 0, 8)))).toEqual({ x: 8, y: 8 });
  });
});

describe('cells', () => {
  it('nearestFreeLand prefers the closest land cell', () => {
    const i = island('a', 0, 0);
    const cells = landCells(i.size, i.seed);
    const from = cells[Math.floor(cells.length / 2)];
    expect(nearestFreeLand(i, from, new Set())).toEqual(from);
    const near = nearestFreeLand(i, from, new Set([`${from.x},${from.y}`]))!;
    expect(Math.abs(near.x - from.x) + Math.abs(near.y - from.y)).toBe(1);
    expect(nearestFreeLand(i, { x: 0, y: 0 }, new Set(cells.map((c) => `${c.x},${c.y}`)))).toBeUndefined();
  });
  it('occupiedCells lists the island characters cells', () => {
    const s = withIslands(island('a', 0, 0));
    s.characters.c = { id: 'c', islandId: 'a', cell: { x: 2, y: 1 }, name: 'c', portrait: 'fox', note: '', instructions: '', cwd: '/', context: [], shell: { lastOutputAt: 0 }, unread: false };
    expect([...occupiedCells(s, 'a')]).toEqual(['2,1']);
    expect([...occupiedCells(s, 'a', 'c')]).toEqual([]);
  });
  it('blockedCells covers each character and everything within Chebyshev distance 2', () => {
    const s = withIslands(island('a', 0, 0));
    s.characters.c = { id: 'c', islandId: 'a', cell: { x: 2, y: 1 }, name: 'c', portrait: 'fox', note: '', instructions: '', cwd: '/', context: [], shell: { lastOutputAt: 0 }, unread: false };
    const b = blockedCells(s, 'a');
    expect(b.size).toBe(25);                            // a 5x5 block around 2,1
    expect(b.has('0,-1') && b.has('4,3') && b.has('2,1')).toBe(true);
    expect(b.has('5,1')).toBe(false);
    expect(b.has('2,4')).toBe(false);
    expect(blockedCells(s, 'a', 'c').size).toBe(0);
  });
  it('uniqueName suffixes taken names', () => {
    const s = withIslands(island('a', 0, 0));
    s.islands.a.name = 'repo';
    expect(uniqueName(s, 'repo')).toBe('repo 2');
    expect(uniqueName(s, 'other')).toBe('other');
    // a name resolves without regard to case, so a twin differing only in case is taken too
    expect(uniqueName(s, 'Repo')).toBe('Repo 2');
  });
  it('SPACING is two cells, and a crew grid stands that far apart and clear of the coast', () => {
    expect(SPACING).toBe(2);
    expect(DEFAULT_SIZE).toEqual({ w: 7, h: 5 });
    // a fresh island is the ground a crew of one needs
    expect(crewGrid(1, 1).size).toEqual(DEFAULT_SIZE);
    for (let n = 1; n <= 9; n++) {
      const { size, cells } = crewGrid(n, 1);
      const land = new Set(landCells(size, 1).map((c) => `${c.x},${c.y}`));
      for (const c of cells) {
        expect(land.has(`${c.x},${c.y}`)).toBe(true);
        expect(Math.min(c.x, c.y, size.w - 1 - c.x, size.h - 1 - c.y)).toBeGreaterThanOrEqual(CREW_INSET);
      }
      for (const p of cells) for (const q of cells) if (p !== q) expect(Math.max(Math.abs(p.x - q.x), Math.abs(p.y - q.y))).toBeGreaterThan(SPACING);
    }
  });

  it('freePosition keeps the wanted spot when it is clear', () => {
    const st = emptyState();
    st.islands.a = island('a', 0, 0, 6, 4);
    expect(freePosition(st, island('new', 20, 0))).toEqual({ x: 20, y: 0 });
  });

  it('freePosition slides an overlapping island clear of its neighbours', () => {
    const st = emptyState();
    st.islands.a = island('a', 0, 0, 6, 4);
    const at = freePosition(st, island('new', 1, 1));
    const placed = island('new', at.x, at.y);
    expect(clearBy(st.islands.a, placed, 2)).toBe(true);
    expect(Math.max(Math.abs(at.x - 1), Math.abs(at.y - 1))).toBeLessThanOrEqual(10);
  });

  it('freePosition threads an island into a gap between two others', () => {
    const st = emptyState();
    st.islands.a = island('a', 0, 0, 6, 4);
    st.islands.b = island('b', 30, 0, 6, 4);
    const at = freePosition(st, island('new', 15, 0));
    const placed = island('new', at.x, at.y);
    expect(clearBy(st.islands.a, placed, 2)).toBe(true);
    expect(clearBy(st.islands.b, placed, 2)).toBe(true);
  });

  it('returns a spot below mission control unless the floor is asked for', () => {
    const mc: Island = { ...island('home', 0, 20), kind: 'home', name: 'mission control' };
    const st = withIslands(island('a', 0, 0), mc);
    expect(freePosition(st, island('new', 0, 18))).toEqual({ x: 0, y: 18 });
    const at = freePosition(st, island('new', 0, 18), true);
    expect(at.y + 4 + HOME_REACH).toBeLessThanOrEqual(20);
  });
});

describe('mission control as the floor', () => {
  const home = (y: number): Island => ({ ...island('home', 0, y), kind: 'home', name: 'mission control' });
  const state = (...islands: Island[]): FleetState => withIslands(...islands);

  it('leaves a row of water under the lowest island, and takes no part in its own floor', () => {
    const st = state(island('a', 0, 0), home(99));
    settleHome(st);
    expect(st.islands.home.position.y).toBe(4 + HOME_GAP);
  });

  it('follows ground that grows past its row, and holds when the fleet rises', () => {
    const st = state(island('a', 0, 0, 6, 20), home(6));
    sinkHome(st);
    expect(st.islands.home.position.y).toBe(20 + HOME_REACH);
    st.islands.a.size = { w: 6, h: 4 };
    sinkHome(st);
    expect(st.islands.home.position.y).toBe(20 + HOME_REACH);
  });

  it('holds its row for an island that comes down onto it and no further', () => {
    const st = state(island('a', 0, 0), island('b', 40, 10), home(16));
    expect(aboveHome(st, island('a', 0, 12))).toBe(true);
    expect(aboveHome(st, island('a', 0, 13))).toBe(false);
    // growth and a move reach the same row: what is refused is the ground, not the gesture
    expect(aboveHome(st, island('a', 0, 0, 6, 16))).toBe(true);
    expect(aboveHome(st, island('a', 0, 0, 6, 17))).toBe(false);
    // mission control never stands below itself, so folding it is not a move onto its own row
    expect(aboveHome(st, { ...st.islands.home, collapsed: true })).toBe(true);
  });

  it('is no floor at all with nothing to stand under', () => {
    const st = state(home(6));
    settleHome(st);
    expect(st.islands.home.position.y).toBe(6);
  });
});

describe('arrangeFleet', () => {
  const home = (y: number): Island => ({ ...island('home', 0, y), kind: 'home', name: 'mission control' });
  const crew = (s: FleetState, islandId: string, n: number): void => {
    for (let i = 0; i < n; i++) {
      const id = `${islandId}c${i}`;
      s.characters[id] = { id, islandId, cell: { x: 1, y: 1 }, name: id, portrait: 'fox', note: '', instructions: '', cwd: '/', context: [], shell: { lastOutputAt: 0 }, unread: false };
    }
  };
  const pairs = (s: FleetState): [Island, Island][] => {
    const list = Object.values(s.islands).filter((i) => i.kind !== 'home');
    return list.flatMap((a, i) => list.slice(i + 1).map((b) => [a, b] as [Island, Island]));
  };

  it('cuts every island to the crew it holds and stands them on land, spaced', () => {
    const st = withIslands(island('a', 0, 0, 12, 9), island('b', 40, 30, 12, 9), home(99));
    crew(st, 'a', 3);
    arrangeFleet(st);
    expect(st.islands.b.size).toEqual(sizeForCrew(0, st.islands.b.seed));
    const cells = Object.values(st.characters).map((c) => c.cell);
    const { w, h } = st.islands.a.size;
    for (const c of cells) expect(isLand(st.islands.a, c)).toBe(true);
    // a cell in from the coast on every side, so the card standing there stays on the island
    for (const c of cells) expect(c.x >= 1 && c.y >= 1 && c.x <= w - 2 && c.y <= h - 2).toBe(true);
    for (const p of cells) for (const q of cells) if (p !== q) expect(Math.max(Math.abs(p.x - q.x), Math.abs(p.y - q.y))).toBeGreaterThan(SPACING);
  });

  it('packs the fleet together, clear of itself, and settles mission control under it', () => {
    const st = withIslands(island('a', 0, 0), island('b', 40, 0), island('c', 0, 40), island('d', 90, 90), home(99));
    crew(st, 'a', 2);
    crew(st, 'd', 5);
    const before = pairs(st).length;
    arrangeFleet(st);
    expect(before).toBe(6);
    for (const [a, b] of pairs(st)) expect(clearBy(ground(a), ground(b), GAP)).toBe(true);
    const bottom = Math.max(...Object.values(st.islands).filter((i) => i.kind !== 'home').map((i) => ground(i).position.y + ground(i).size.h));
    expect(st.islands.home.position.y).toBe(bottom + HOME_GAP);
    // the whole fleet fits in a fraction of the ground it was strewn over
    const right = Math.max(...Object.values(st.islands).filter((i) => i.kind !== 'home').map((i) => i.position.x + i.size.w));
    expect(right).toBeLessThan(30);
  });

  it('a wide window lays the islands out in fewer rows than a tall one', () => {
    const islands = ['a', 'b', 'c', 'd', 'e', 'f'].map((id, n) => island(id, n * 20, 0));
    const rows = (aspect: number): number => {
      const st = withIslands(...islands.map((i) => ({ ...i })), home(99));
      arrangeFleet(st, aspect);
      return new Set(Object.values(st.islands).filter((i) => i.kind !== 'home').map((i) => i.position.y)).size;
    };
    expect(rows(4)).toBeLessThan(rows(0.4));
  });

  it('keeps a folded island folded and packs it as its label pill', () => {
    const st = withIslands(island('a', 0, 0), { ...island('b', 40, 0, 12, 9), collapsed: true }, home(99));
    crew(st, 'b', 1);
    arrangeFleet(st);
    expect(st.islands.b.collapsed).toBe(true);
    expect(st.islands.b.size).toEqual(crewGrid(1, st.islands.b.seed).size);
    for (const [a, b] of pairs(st)) expect(clearBy(ground(a), ground(b), GAP)).toBe(true);
  });

  it('gathers the folded islands as a band of pills above every unfolded island', () => {
    const st = withIslands(island('a', 0, 0), { ...island('b', 20, 0), collapsed: true }, island('c', 0, 20),
      { ...island('d', 30, 30), collapsed: true }, { ...island('e', 50, 0), collapsed: true }, home(99));
    crew(st, 'a', 2);
    crew(st, 'c', 4);
    arrangeFleet(st);
    const list = Object.values(st.islands).filter((i) => i.kind !== 'home');
    const pills = list.filter((i) => i.collapsed).map(ground), lands = list.filter((i) => !i.collapsed);
    // a row of water between the lowest pill and the highest label, which floats two rows above its island
    const bandFoot = Math.max(...pills.map((p) => p.position.y + p.size.h));
    for (const i of lands) expect(i.position.y - 2).toBeGreaterThanOrEqual(bandFoot + 1);
    for (const [p, i] of pills.entries()) for (const q of pills.slice(p + 1)) expect(clearBy(i, q, 1)).toBe(true);
  });

  it('spreads the band and the rows apart to fill the height a window has to spare', () => {
    const drop = (aspect: number): number => {
      const st = withIslands(island('a', 0, 0), island('b', 20, 0), { ...island('c', 40, 0), collapsed: true }, home(99));
      arrangeFleet(st, aspect);
      return st.islands.a.position.y - st.islands.c.position.y;
    };
    expect(drop(1)).toBeGreaterThan(drop(4));
  });

  it('wraps a long band into rows that neither overlap nor leave a pill stranded', () => {
    const folded = Array.from({ length: 10 }, (_, n) => ({ ...island(`f${n}`, n * 10, 0), collapsed: true }));
    const st = withIslands(island('a', 0, 20), ...folded, home(99));
    arrangeFleet(st, 0.5);
    const pills = Object.values(st.islands).filter((i) => i.collapsed).map(ground);
    const rows = [...new Set(pills.map((p) => p.position.y))].map((y) => pills.filter((p) => p.position.y === y));
    expect(rows.length).toBeGreaterThan(1);
    expect(Math.max(...rows.map((r) => r.length)) - Math.min(...rows.map((r) => r.length))).toBeLessThanOrEqual(1);
    for (const [p, i] of pills.entries()) for (const q of pills.slice(p + 1)) {
      expect(clearBy(i, q, 0)).toBe(true);
      if (i.position.y === q.position.y) expect(clearBy(i, q, 1)).toBe(true);
    }
  });

  it('stands a crew abreast for a wide window and deeper for a tall one', () => {
    const cut = (aspect: number) => {
      const st = withIslands(island('a', 0, 0), island('b', 20, 0), home(99));
      crew(st, 'a', 6);
      arrangeFleet(st, aspect);
      return st.islands.a.size;
    };
    expect(cut(4).h).toBeLessThan(cut(0.25).h);
    expect(cut(4).w).toBeGreaterThan(cut(0.25).w);
  });

  it('wraps a long crew into a rounder island however wide the window', () => {
    for (const n of [4, 6, 8, 12]) {
      const st = withIslands(island('a', 0, 0), home(99));
      crew(st, 'a', n);
      arrangeFleet(st, 8);
      const rows = new Set(Object.values(st.characters).map((c) => c.cell.y)).size;
      expect(rows).toBeGreaterThan(1);
      expect(Math.ceil(n / rows)).toBeLessThanOrEqual(2 * rows);
    }
  });

  it('leaves room between rows for the cards below one island and the label above the next', () => {
    const st = withIslands(...['a', 'b', 'c', 'd'].map((id, n) => island(id, n * 20, 0)), home(99));
    arrangeFleet(st, 0.3);
    const rows = [...new Set(Object.values(st.islands).filter((i) => i.kind !== 'home').map((i) => i.position.y))].sort((a, b) => a - b);
    expect(rows.length).toBeGreaterThan(1);
    for (const [n, y] of rows.slice(1).entries()) {
      const above = Object.values(st.islands).filter((i) => i.position.y === rows[n]);
      expect(y).toBeGreaterThanOrEqual(Math.max(...above.map((i) => i.position.y + i.size.h)) + ROW_GAP);
    }
  });

  it('keeps a long label pill inside its own column', () => {
    const st = withIslands(island('a', 0, 0), { ...island('b', 30, 0), name: 'the island with the longest name' }, home(99));
    arrangeFleet(st, 8);
    const b = st.islands.b;
    const pillLeft = b.position.x + b.size.w / 2 - pillWidth(b.name) / 2;
    expect(pillWidth(b.name)).toBeGreaterThan(b.size.w);
    expect(pillLeft).toBeGreaterThanOrEqual(st.islands.a.position.x + st.islands.a.size.w);
  });

  it('leaves an empty fleet alone', () => {
    const st = withIslands(home(9));
    arrangeFleet(st);
    expect(st.islands.home.position.y).toBe(9);
  });

  it('gives mission control an empty slot past its crew where the map has room for it, and takes it back where not', () => {
    const st = withIslands(island('a', 0, 0), { ...home(9), size: homeSizeFor(2) });
    for (const x of [1, 4]) st.characters[`h${x}`] = { id: `h${x}`, islandId: 'home', cell: { x, y: 1 }, name: `h${x}`, portrait: 'fox', note: '', instructions: '', cwd: '/', context: [], shell: { lastOutputAt: 0 }, unread: false };
    arrangeFleet(st);
    expect(st.islands.home.size).toEqual(homeSizeFor(2));
    arrangeFleet(st, 4 / 3, 11);
    expect(st.islands.home.size).toEqual(homeSizeFor(3));
    expect([st.characters.h1.cell, st.characters.h4.cell]).toEqual([{ x: 1, y: 1 }, { x: 4, y: 1 }]);
    arrangeFleet(st, 4 / 3, 10);
    expect(st.islands.home.size).toEqual(homeSizeFor(2));
  });
});

describe('crewGrid', () => {
  it('stands every crew on land, spaced, a cell in from the coast', () => {
    for (const abreast of [1, 3, 5]) for (let n = 1; n <= 16; n++) {
      const { size, cells } = crewGrid(n, 1, abreast);
      expect(cells).toHaveLength(n);
      for (const c of cells) {
        expect(isLand({ size, seed: 1 }, c)).toBe(true);
        expect(c.x >= 1 && c.y >= 1 && c.x <= size.w - 2 && c.y <= size.h - 2).toBe(true);
      }
      for (const p of cells) for (const q of cells) if (p !== q) expect(Math.max(Math.abs(p.x - q.x), Math.abs(p.y - q.y))).toBeGreaterThan(SPACING);
    }
  });

  it('centres a lone crew on its island', () => {
    const { size, cells } = crewGrid(1, 1);
    expect(cells[0].x * 2 + 1).toBe(size.w);
  });
});

describe('makeRoom', () => {
  const home = (y: number): Island => ({ ...island('home', 0, y), kind: 'home', name: 'mission control' });

  it('leaves an island put past mission control\'s row where it was put, as settled', () => {
    const st = withIslands(island('a', 0, 14), home(16));
    expect(makeRoom(st, 'a')).toBe(0);
    expect(st.islands.a.position).toEqual({ x: 0, y: 14 });
  });

  it('pushes the neighbours an unfolded island now stands on', () => {
    const st = withIslands(island('a', 0, 0), island('b', 3, 0), home(30));
    makeRoom(st, 'a');
    expect(st.islands.a.position).toEqual({ x: 0, y: 0 });
    expect(placementOk(st, st.islands.b)).toBe(true);
    expect(aboveHome(st, st.islands.b)).toBe(true);
  });

  it('settles a chain of pushes rather than trading one overlap for another', () => {
    const st = withIslands(island('a', 0, 0), island('b', 3, 0), island('c', 10, 0), island('d', 17, 0), home(40));
    makeRoom(st, 'a');
    for (const id of ['a', 'b', 'c', 'd']) expect(placementOk(st, st.islands[id])).toBe(true);
  });

  it('clears a folded neighbour whose label pill stands on the island', () => {
    const st = withIslands(island('a', 0, 1), { ...island('b', 2, 6), collapsed: true }, home(40));
    makeRoom(st, 'a');
    for (const i of worldIslands(st)) expect(placementOk(st, i)).toBe(true);
  });

  it('leaves mission control where it stands', () => {
    const st = withIslands(island('a', 0, 12), home(16));
    makeRoom(st, 'a');
    expect(st.islands.home.position.y).toBe(16);
  });
});
