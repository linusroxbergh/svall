import fs from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { HOME_ISLAND, PORTRAITS, landCells, spacedCells, type Cell, type Size } from '@svall/protocol';
import { Config } from '../src/config.js';
import { Fleet } from '../src/fleet.js';
import { CREW_INSET, clearBy, crewGrid } from '../src/layout.js';
import { silentLogger } from '../src/log.js';
import { resolvePaths } from '../src/paths.js';
import { Store } from '../src/store.js';
import { tmuxConfText } from '../src/tmux/conf.js';
import { Tmux } from '../src/tmux/tmux.js';
import { cleanHomes, hasTmux, makeHome } from './helpers.js';

const runIf = hasTmux() ? describe : describe.skip;

// how far a cell stands from the nearest coast
const inset = (size: Size, c: Cell): number => Math.min(c.x, c.y, size.w - 1 - c.x, size.h - 1 - c.y);

runIf('Fleet layout', () => {
  const cleanup: (() => Promise<void>)[] = [];
  afterEach(async () => { for (const f of cleanup.splice(0)) await f(); cleanHomes(); });

  async function boot() {
    const home = makeHome();
    const paths = resolvePaths(home);
    const config = Config.parse({ shell: '/bin/sh' });
    fs.writeFileSync(paths.tmuxConf, tmuxConfText(config));
    const store = Store.load(paths.state, () => {});
    const tmux = new Tmux(paths.tmuxSock, paths.tmuxConf);
    const fleet = new Fleet({ store, tmux, paths, config, log: silentLogger, pollMs: 150 });
    const started = fleet.start();
    cleanup.push(async () => { await started.catch(() => {}); fleet.stop(); await tmux.killServer(); });
    await started;
    return { fleet, store, tmux };
  }

  it('creates islands with defaults, refuses overlap, and places characters on land', async () => {
    const { fleet, store } = await boot();
    const a = fleet.createIsland({ name: 'a' });
    expect(a).toMatchObject({ position: { x: 0, y: 0 }, size: { w: 7, h: 5 }, description: '', instructions: '', context: [] });
    const b = fleet.createIsland({ name: 'b', seed: 5 });
    expect(b.position).toEqual({ x: 9, y: 0 });          // 0 + 7 + GAP
    // an overlapping spot slides clear rather than refusing
    const c = fleet.createIsland({ name: 'c', position: { x: 3, y: 1 } });
    expect(clearBy(a, c, 1)).toBe(true);
    expect(clearBy(b, c, 1)).toBe(true);
    expect(fleet.createIsland({ name: 'a' }).name).toBe('a 2');
    const c1 = await fleet.createCharacter({ islandId: a.id, cwd: '/tmp' });
    const c2 = await fleet.createCharacter({ islandId: a.id, cwd: '/tmp' });
    // the island reshaped around the pair, so the first one moved with it
    const size = store.state.islands[a.id].size;
    const cells = [c1, c2].map((c) => store.state.characters[c.id].cell);
    for (const c of cells) expect(inset(size, c)).toBeGreaterThanOrEqual(CREW_INSET);
    expect(Math.max(Math.abs(cells[0].x - cells[1].x), Math.abs(cells[0].y - cells[1].y))).toBeGreaterThan(2);
    await expect(fleet.createCharacter({ islandId: a.id, cwd: '/tmp', cell: cells[0] })).rejects.toThrow(/occupied/);
    await expect(fleet.createCharacter({ islandId: a.id, cwd: '/tmp', cell: { x: cells[0].x + 1, y: cells[0].y } })).rejects.toThrow(/touches/);
    await expect(fleet.createCharacter({ islandId: a.id, cwd: '/tmp', cell: { x: 0, y: 0 } })).rejects.toThrow(/land/);
  });

  it('moves and swaps atomically', async () => {
    const { fleet, store } = await boot();
    const a = fleet.createIsland({ name: 'a' });
    const b = fleet.createIsland({ name: 'b' });
    const c1 = await fleet.createCharacter({ islandId: a.id, cwd: '/tmp' });
    const c2 = await fleet.createCharacter({ islandId: b.id, cwd: '/tmp' });
    const target = landCells(a.size, a.seed)[3];
    expect(fleet.moveCharacter(c1.id, a.id, target).cell).toEqual(target);
    const ops: number[] = [];
    store.subscribe((o) => ops.push(o.length));
    fleet.moveCharacter(c1.id, b.id, c2.cell);
    expect(ops).toHaveLength(1);
    expect(store.state.characters[c1.id]).toMatchObject({ islandId: b.id, cell: c2.cell });
    expect(store.state.characters[c2.id]).toMatchObject({ islandId: a.id, cell: target });
    expect(() => fleet.moveCharacter(c1.id, a.id, { x: 0, y: 0 })).toThrow(/land/);
  });

  it('reshapes an island around its crew on create, pushing the island below it aside', async () => {
    const { fleet, store } = await boot();
    const a = fleet.createIsland({ name: 'a', size: { w: 4, h: 3 }, seed: 1 });
    const below = fleet.createIsland({ name: 'below', position: { x: 0, y: 7 }, size: { w: 4, h: 3 } });
    const first = await fleet.createCharacter({ islandId: a.id, cwd: '/tmp' });
    const grown = store.state.islands[a.id].size;
    expect(grown.h).toBeGreaterThan(3);
    expect(landCells(grown, 1)).toContainEqual(store.state.characters[first.id].cell);
    // growing into the water the island below held moves that one out of the way rather than refusing
    for (let i = 0; i < 20 && store.state.islands[a.id].size.h < 8; i++) await fleet.createCharacter({ islandId: a.id, cwd: '/tmp' });
    expect(store.state.islands[a.id].size.h).toBeGreaterThanOrEqual(8);
    expect(store.state.islands[below.id].position).not.toEqual(below.position);
    expect(clearBy(store.state.islands[a.id], store.state.islands[below.id], 1)).toBe(true);
    const cells = Object.values(store.state.characters).map((c) => c.cell);
    for (const p of cells) for (const q of cells) if (p !== q) expect(Math.max(Math.abs(p.x - q.x), Math.abs(p.y - q.y))).toBeGreaterThan(2);
  });

  it('kills the tmux window when recording the character fails', async () => {
    const { fleet, store, tmux } = await boot();
    const a = fleet.createIsland({ name: 'a', size: { w: 4, h: 3 }, seed: 1 });
    await fleet.createCharacter({ islandId: a.id, cwd: '/tmp' });
    // refuse the update that records a new character, leaving the window that was already created behind
    const update = store.update.bind(store);
    store.update = (mutate) => {
      const probe = structuredClone(store.state);
      mutate(probe);
      if (Object.keys(probe.characters).length > Object.keys(store.state.characters).length) throw new Error('island a is full');
      return update(mutate);
    };
    await expect(fleet.createCharacter({ islandId: a.id, cwd: '/tmp' })).rejects.toThrow(/full/);
    const windows = await tmux.listWindows();
    expect(windows).toHaveLength(1);
  });

  it('resize relocates a drowned character and refuses when too small', async () => {
    const { fleet, store } = await boot();
    const a = fleet.createIsland({ name: 'a', size: { w: 8, h: 6 }, seed: 2 });
    const far = landCells(a.size, a.seed).at(-1)!;
    const c = await fleet.createCharacter({ islandId: a.id, cwd: '/tmp', cell: far });
    fleet.updateIsland(a.id, { size: { w: 4, h: 3 } });
    expect(landCells({ w: 4, h: 3 }, 2)).toContainEqual(store.state.characters[c.id].cell);
    fleet.updateIsland(a.id, { size: { w: 8, h: 6 } });
    const cap = spacedCells({ w: 8, h: 6 }, 2, 99).length;
    for (let i = 1; i < cap; i++) await fleet.createCharacter({ islandId: a.id, cwd: '/tmp' });
    expect(store.state.islands[a.id].size).toEqual(crewGrid(cap, 2).size);
    expect(() => fleet.updateIsland(a.id, { size: { w: 4, h: 3 } })).toThrow(/fewer|free land/);
  });

  it('updates description, instructions, context and position; refuses an overlapping move', async () => {
    const { fleet } = await boot();
    const a = fleet.createIsland({ name: 'a' });
    const b = fleet.createIsland({ name: 'b' });
    const link = { kind: 'other' as const, ref: 'https://x', label: 'x', source: 'manual' as const };
    expect(fleet.updateIsland(a.id, { description: 'd', context: [link] })).toMatchObject({ description: 'd', context: [link] });
    expect(() => fleet.updateIsland(b.id, { position: { x: 5, y: 0 } })).toThrow(/overlap/);
    // past the row mission control settled under the pair, into the water beside it
    expect(fleet.updateIsland(b.id, { position: { x: 0, y: 10 } }).position).toEqual({ x: 0, y: 10 });
    expect(fleet.updateIsland(b.id, { position: { x: 0, y: -10 } }).position).toEqual({ x: 0, y: -10 });
    expect(fleet.updateIsland(a.id, { instructions: 'ship small' }).instructions).toBe('ship small');
    expect(() => fleet.updateIsland(a.id, { context: [{ kind: 'file', ref: '/nope/x', label: '', source: 'manual' }] })).toThrow(/no such file/);
    expect(fleet.islandBrief(a.id)).toContain('Island instructions: ship small');
  });

  it('mission control settles under the fleet, follows it down, and holds its row', async () => {
    const { fleet, store } = await boot();
    const floor = () => store.state.islands[HOME_ISLAND].position.y;
    const a = fleet.createIsland({ name: 'a', position: { x: 0, y: 0 }, size: { w: 6, h: 4 } });
    expect(floor()).toBe(5);
    const b = fleet.createIsland({ name: 'b', position: { x: 20, y: 20 }, size: { w: 6, h: 4 } });
    expect(floor()).toBe(25);

    // an island put onto the floor's own row leaves it be; one put past it takes the floor down with it
    expect(fleet.updateIsland(a.id, { position: { x: 0, y: 21 } }).position.y).toBe(21);
    expect(floor()).toBe(25);
    expect(fleet.updateIsland(a.id, { position: { x: 0, y: 22 } }).position.y).toBe(22);
    expect(floor()).toBe(26);

    // and the floor holds its row when the island goes back up; growing past it is the same as moving past it
    fleet.updateIsland(a.id, { position: { x: 0, y: 0 } });
    expect(floor()).toBe(26);
    expect(fleet.updateIsland(a.id, { size: { w: 6, h: 30 } }).size.h).toBe(30);
    expect(floor()).toBe(30);
    fleet.updateIsland(a.id, { size: { w: 6, h: 4 } });

    fleet.deleteIsland(b.id);
    expect(floor()).toBe(5);
  });

  it('a folded island holds only its label, and takes its ground back by pushing neighbours aside', async () => {
    const { fleet, store } = await boot();
    const a = fleet.createIsland({ name: 'a', position: { x: 0, y: 0 }, size: { w: 6, h: 4 } });
    const b = fleet.createIsland({ name: 'b', position: { x: 20, y: 0 }, size: { w: 6, h: 4 } });
    expect(() => fleet.updateIsland(b.id, { position: { x: 0, y: 0 } })).toThrow(/overlap/);

    fleet.updateIsland(a.id, { collapsed: true });
    // every cell the folded island stood on is free, down to the ones under its own label
    expect(fleet.updateIsland(b.id, { position: { x: 0, y: 0 } }).position).toEqual({ x: 0, y: 0 });
    // the pill itself is not: it draws in the band above where the island stood
    expect(() => fleet.updateIsland(b.id, { position: { x: 0, y: -4 } })).toThrow(/overlap/);

    fleet.updateIsland(a.id, { collapsed: false });
    expect(store.state.islands[a.id].position).toEqual({ x: 0, y: 0 });
    expect(store.state.islands[a.id].collapsed).toBeUndefined();
    expect(clearBy(store.state.islands[a.id], store.state.islands[b.id], 1)).toBe(true);
  });

  it('folded islands stand a row apart, as close as their pills are drawn', async () => {
    const { fleet } = await boot();
    const a = fleet.createIsland({ name: 'liraboll', position: { x: 0, y: 0 }, size: { w: 6, h: 4 } });
    const b = fleet.createIsland({ name: 'tenfold', position: { x: 40, y: 0 }, size: { w: 6, h: 4 } });
    fleet.updateIsland(a.id, { collapsed: true });
    fleet.updateIsland(b.id, { collapsed: true });

    // one row below is clear: the pills are drawn a third of a cell apart there
    expect(fleet.updateIsland(b.id, { position: { x: 0, y: 1 } }).position).toEqual({ x: 0, y: 1 });
    // the same row is not: that is the same pill
    expect(() => fleet.updateIsland(b.id, { position: { x: 0, y: 0 } })).toThrow(/overlap/);
    // side by side, the pills stand as wide as they are drawn and no wider
    expect(fleet.updateIsland(b.id, { position: { x: 4, y: 0 } }).position).toEqual({ x: 4, y: 0 });
    expect(() => fleet.updateIsland(b.id, { position: { x: 3, y: 0 } })).toThrow(/overlap/);
  });

  it('char.update with a new island places the character on a free cell', async () => {
    const { fleet } = await boot();
    const a = fleet.createIsland({ name: 'a' });
    const b = fleet.createIsland({ name: 'b' });
    const c = await fleet.createCharacter({ islandId: a.id, cwd: '/tmp' });
    const moved = fleet.updateCharacter(c.id, { islandId: b.id });
    expect(moved.islandId).toBe(b.id);
    expect(inset(b.size, moved.cell)).toBeGreaterThanOrEqual(CREW_INSET);
    const upd = fleet.updateCharacter(c.id, { instructions: 'in Spanish', context: [{ kind: 'file', ref: '/tmp', label: '', source: 'manual' }] });
    expect(upd.instructions).toBe('in Spanish');
    expect(upd.context[0].kind).toBe('folder');
    expect(fleet.brief(c.id)).toContain('Character instructions: in Spanish');
  });

  it('a move without a cell re-places a character on the island it already stands on', async () => {
    const { fleet, store } = await boot();
    const a = fleet.createIsland({ name: 'a' });
    const c = await fleet.createCharacter({ islandId: a.id, cwd: '/tmp' });
    const coast = landCells(store.state.islands[a.id].size, a.seed).at(-1)!;
    expect(fleet.moveCharacter(c.id, a.id, coast).cell).toEqual(coast);
    const moved = fleet.moveCharacter(c.id, a.id);
    expect(moved.cell).not.toEqual(coast);
    expect(inset(store.state.islands[a.id].size, moved.cell)).toBeGreaterThanOrEqual(CREW_INSET);
  });

  it('gives each new character an animal of its own, and char.update swaps it', async () => {
    const { fleet } = await boot();
    const a = fleet.createIsland({ name: 'a' });
    const one = await fleet.createCharacter({ islandId: a.id, cwd: '/tmp' });
    const two = await fleet.createCharacter({ islandId: a.id, cwd: '/tmp' });
    expect(PORTRAITS).toContain(one.portrait);
    expect(two.portrait).not.toBe(one.portrait);
    expect(fleet.updateCharacter(one.id, { portrait: 'walrus' }).portrait).toBe('walrus');
  });
});
