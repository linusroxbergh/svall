import { describe, expect, it } from 'vitest';
import type { Cell } from '@svall/protocol';
import { createInteractions, type CellEv } from '../src/map/interactions.js';
import { cellOwner, islandNear, mapIslands } from '../src/map/layout.js';
import type { Target } from '../src/map/types.js';
import { chr, fleet } from './fixtures.js';

const fig = (id: string): Target => ({ kind: 'figure', id });
const label = (islandId: string): Target => ({ kind: 'label', islandId });
const handle = (islandId: string): Target => ({ kind: 'handle', islandId });
const ev = (type: CellEv['type'], x: number, y: number, target?: Target, time = 0): CellEv => ({ type, cell: { x, y }, target, time });

// fixture: i_b at 0,0 (6x4 seed 1) with c0 at 1,1 and c1 at 4,1; i_a at 8,0 with c2; i_e at 16,0 empty
describe('interactions', () => {
  it('click selects, double click opens', () => {
    const f = fleet(), i = createInteractions({ dblClickMs: 300 });
    expect(i.handle(ev('down', 1, 1, fig('c0'), 0), f)).toBeUndefined();
    expect(i.handle(ev('up', 1, 1, undefined, 50), f)).toEqual({ type: 'select', id: 'c0' });
    expect(i.handle(ev('down', 1, 1, fig('c0'), 200), f)).toEqual({ type: 'open', id: 'c0' });
    expect(i.handle(ev('up', 1, 1, undefined, 250), f)).toBeUndefined();
    expect(i.handle(ev('down', 1, 1, fig('c0'), 1000), f)).toBeUndefined();
    expect(i.handle(ev('up', 1, 1, undefined, 1050), f)).toEqual({ type: 'select', id: 'c0' });
  });
  it('a click on the figure already selected opens it', () => {
    const f = fleet(), i = createInteractions({ dblClickMs: 300 });
    expect(i.handle(ev('down', 1, 1, fig('c0'), 0), f, 'c0')).toBeUndefined();
    expect(i.handle(ev('up', 1, 1, undefined, 50), f, 'c0')).toEqual({ type: 'open', id: 'c0' });
    // another figure still only selects
    expect(i.handle(ev('down', 4, 1, fig('c1'), 1000), f, 'c0')).toBeUndefined();
    expect(i.handle(ev('up', 4, 1, undefined, 1050), f, 'c0')).toEqual({ type: 'select', id: 'c1' });
  });

  it('a drag off the selected figure still moves it', () => {
    const f = fleet(), i = createInteractions();
    i.handle(ev('down', 1, 1, fig('c0')), f, 'c0');
    i.handle(ev('move', 1, 3), f, 'c0');
    expect(i.handle(ev('up', 1, 3), f, 'c0')).toEqual({ type: 'move', id: 'c0', islandId: 'i_b', cell: { x: 1, y: 3 } });
  });
  it('a press that stays in its cell is a click, not a drag', () => {
    const f = fleet(), i = createInteractions();
    i.handle(ev('down', 1, 1, fig('c0')), f);
    i.handle(ev('move', 1, 1), f);
    expect(i.drag()).toBeUndefined();
    expect(i.handle(ev('up', 1, 1), f)).toEqual({ type: 'select', id: 'c0' });
  });
  it('drags a figure to free land, an occupied cell, and water', () => {
    const f = fleet();
    let i = createInteractions();
    i.handle(ev('down', 1, 1, fig('c0')), f);
    i.handle(ev('move', 1, 3), f);
    expect(i.drag()).toEqual({ kind: 'figure', id: 'c0', cell: { x: 1, y: 3 }, over: { islandId: 'i_b', local: { x: 1, y: 3 }, free: true } });
    expect(i.handle(ev('up', 1, 3), f)).toEqual({ type: 'move', id: 'c0', islandId: 'i_b', cell: { x: 1, y: 3 } });
    expect(i.drag()).toBeUndefined();

    i = createInteractions();
    i.handle(ev('down', 1, 1, fig('c0')), f);
    i.handle(ev('move', 4, 1), f);
    expect(i.drag()).toMatchObject({ over: { free: false } });
    expect(i.handle(ev('up', 4, 1), f)).toEqual({ type: 'swap', id: 'c0', otherId: 'c1' });

    i = createInteractions();
    i.handle(ev('down', 1, 1, fig('c0')), f);
    i.handle(ev('move', 7, 7), f);
    expect(i.drag()).toEqual({ kind: 'figure', id: 'c0', cell: { x: 7, y: 7 }, over: undefined });
    expect(i.handle(ev('up', 7, 7), f)).toEqual({ type: 'newIsland', id: 'c0', cell: { x: 7, y: 7 } });

    i = createInteractions();
    i.handle(ev('down', 1, 1, fig('c0')), f);
    i.handle(ev('move', 0, 0), f);                       // a cut corner is water
    expect(i.drag()).toMatchObject({ over: undefined });
    i.handle(ev('move', 9, 1), f);                       // c2 lives at i_a local 1,1 = world 9,1
    expect(i.handle(ev('up', 9, 1), f)).toEqual({ type: 'swap', id: 'c0', otherId: 'c2' });

    // an empty cell too close to c2: the island is asked for, not the cell, so the fleet makes room
    i = createInteractions();
    i.handle(ev('down', 1, 1, fig('c0')), f);
    i.handle(ev('move', 10, 1), f);
    expect(i.drag()).toMatchObject({ over: { free: false } });
    expect(i.handle(ev('up', 10, 1), f)).toEqual({ type: 'move', id: 'c0', islandId: 'i_a', cell: undefined });
  });
  it('dropping a figure back on itself does nothing; cancel clears the drag', () => {
    const f = fleet(), i = createInteractions();
    i.handle(ev('down', 1, 1, fig('c0')), f);
    i.handle(ev('move', 3, 2), f);
    i.handle(ev('move', 1, 1), f);
    expect(i.handle(ev('up', 1, 1), f)).toBeUndefined();
    i.handle(ev('down', 1, 1, fig('c0')), f);
    i.handle(ev('move', 3, 2), f);
    i.cancel();
    expect(i.drag()).toBeUndefined();
    expect(i.handle(ev('up', 3, 2), f)).toBeUndefined();
  });
  it('drags an island by its label and selects it on a plain click', () => {
    const f = fleet(), i = createInteractions();
    i.handle(ev('down', 0, -1, label('i_b')), f);
    i.handle(ev('move', 2, 0), f);
    expect(i.drag()).toEqual({ kind: 'island', id: 'i_b', position: { x: 2, y: 1 } });
    expect(i.handle(ev('up', 2, 0), f)).toEqual({ type: 'moveIsland', id: 'i_b', position: { x: 2, y: 1 } });
    i.handle(ev('down', 0, -1, label('i_b')), f);
    expect(i.handle(ev('up', 0, -1), f)).toEqual({ type: 'selectIsland', id: 'i_b' });
  });
  it('double clicking an island opens its card', () => {
    const f = fleet(), i = createInteractions({ dblClickMs: 300 });
    i.handle(ev('down', 0, -1, label('i_b')), f);
    expect(i.handle(ev('up', 0, -1, undefined, 50), f)).toEqual({ type: 'selectIsland', id: 'i_b' });
    expect(i.handle(ev('down', 1, 1, label('i_b'), 200), f)).toEqual({ type: 'openIsland', id: 'i_b' });
    // a second click on a different island is a fresh first click
    i.handle(ev('down', 8, -1, label('i_a'), 400), f);
    expect(i.handle(ev('up', 8, -1, undefined, 420), f)).toEqual({ type: 'selectIsland', id: 'i_a' });
    expect(i.handle(ev('down', 0, -1, label('i_b'), 500), f)).toBeUndefined();
  });
  it('the press that opens can still drag the island it opened', () => {
    const f = fleet(), i = createInteractions({ dblClickMs: 300 });
    i.handle(ev('down', 0, -1, label('i_b')), f);
    i.handle(ev('up', 0, -1, undefined, 50), f);
    expect(i.handle(ev('down', 0, -1, label('i_b'), 150), f)).toEqual({ type: 'openIsland', id: 'i_b' });
    i.handle(ev('move', 2, 0, undefined, 200), f);
    expect(i.handle(ev('up', 2, 0, undefined, 250), f)).toEqual({ type: 'moveIsland', id: 'i_b', position: { x: 2, y: 1 } });
  });
  it('a drag, a cancel and an opening press all disarm the next double click', () => {
    const f = fleet(), i = createInteractions({ dblClickMs: 300 });
    // a drag is not the first half of a double click
    i.handle(ev('down', 0, -1, label('i_b')), f);
    i.handle(ev('move', 2, 0, undefined, 20), f);
    i.handle(ev('up', 2, 0, undefined, 40), f);
    expect(i.handle(ev('down', 2, 0, label('i_b'), 60), f)).toBeUndefined();
    // nor is a press that already opened
    i.handle(ev('up', 2, 0, undefined, 80), f);
    expect(i.handle(ev('down', 2, 0, label('i_b'), 100), f)).toEqual({ type: 'openIsland', id: 'i_b' });
    i.handle(ev('up', 2, 0, undefined, 120), f);
    expect(i.handle(ev('down', 2, 0, label('i_b'), 140), f)).toBeUndefined();
    // a cancelled press leaves nothing armed either
    i.handle(ev('up', 2, 0, undefined, 160), f);
    i.cancel();
    expect(i.handle(ev('down', 2, 0, label('i_b'), 180), f)).toBeUndefined();
  });
  it('resizes by the handle one cell at a time, never below 4x3', () => {
    const f = fleet(), i = createInteractions();
    i.handle(ev('down', 6, 4, handle('i_b')), f);
    i.handle(ev('move', 8, 5), f);
    expect(i.drag()).toEqual({ kind: 'resize', id: 'i_b', size: { w: 8, h: 5 } });
    i.handle(ev('move', 1, 1), f);
    expect(i.drag()).toEqual({ kind: 'resize', id: 'i_b', size: { w: 4, h: 3 } });
    expect(i.handle(ev('up', 1, 1), f)).toEqual({ type: 'resize', id: 'i_b', size: { w: 4, h: 3 } });
    i.handle(ev('down', 6, 4, handle('i_b')), f);
    expect(i.handle(ev('up', 6, 4), f)).toBeUndefined();
  });
  it('click on water deselects', () => {
    const f = fleet(), i = createInteractions();
    i.handle(ev('down', 30, 30, { kind: 'water' }), f);
    expect(i.handle(ev('up', 30, 30), f)).toEqual({ type: 'deselect' });
    const c: Cell = { x: 30, y: 30 };
    expect(i.handle({ type: 'down', cell: c, time: 0 }, f)).toBeUndefined();   // no target reads as water
    expect(i.handle({ type: 'up', cell: c, time: 1 }, f)).toEqual({ type: 'deselect' });
  });
  it('a folded island is water: a figure dropped on it asks for a new island', () => {
    const f = fleet();
    const i = createInteractions();
    i.handle({ type: 'down', cell: { x: 1, y: 1 }, target: { kind: 'figure', id: 'c0' }, time: 0 }, f);
    i.handle({ type: 'move', cell: { x: 9, y: 1 }, time: 10 }, f);
    expect(i.handle({ type: 'up', cell: { x: 9, y: 1 }, time: 20 }, f)).toEqual({ type: 'swap', id: 'c0', otherId: 'c2' });

    f.islands.i_a.collapsed = true;
    const folded = createInteractions();
    folded.handle({ type: 'down', cell: { x: 1, y: 1 }, target: { kind: 'figure', id: 'c0' }, time: 0 }, f);
    folded.handle({ type: 'move', cell: { x: 9, y: 1 }, time: 10 }, f);
    const d = folded.drag();
    expect(d?.kind === 'figure' && d.over).toBeUndefined();
    expect(folded.handle({ type: 'up', cell: { x: 9, y: 1 }, time: 20 }, f))
      .toEqual({ type: 'newIsland', id: 'c0', cell: { x: 9, y: 1 } });
  });
});

describe('home island', () => {
  it('a figure dragged over home lands on the slot the event names', () => {
    const f = fleet();
    const it_ = createInteractions();
    it_.handle({ type: 'down', cell: { x: 1, y: 1 }, target: { kind: 'figure', id: 'c0' }, time: 0 }, f);
    it_.handle({ type: 'move', cell: { x: 99, y: 99 }, home: { x: 4, y: 1 }, time: 10 }, f);
    expect(it_.drag()).toEqual({ kind: 'figure', id: 'c0', cell: { x: 99, y: 99 }, over: { islandId: 'home', local: { x: 4, y: 1 }, free: true } });
    expect(it_.handle({ type: 'up', cell: { x: 99, y: 99 }, home: { x: 4, y: 1 }, time: 20 }, f))
      .toEqual({ type: 'move', id: 'c0', islandId: 'home', cell: { x: 4, y: 1 } });
  });
  it('an occupied slot swaps', () => {
    const f = fleet();
    f.characters.c9 = chr('c9', 'home', { x: 1, y: 1 });
    const it_ = createInteractions();
    it_.handle({ type: 'down', cell: { x: 1, y: 1 }, target: { kind: 'figure', id: 'c0' }, time: 0 }, f);
    it_.handle({ type: 'move', cell: { x: 99, y: 99 }, home: { x: 1, y: 1 }, time: 10 }, f);
    const d = it_.drag();
    expect(d?.kind === 'figure' && d.over?.free).toBe(false);
    expect(it_.handle({ type: 'up', cell: { x: 99, y: 99 }, home: { x: 1, y: 1 }, time: 20 }, f)).toEqual({ type: 'swap', id: 'c0', otherId: 'c9' });
  });
  it('past the last slot of a full row asks for home alone, so the fleet widens it', () => {
    const f = fleet();
    f.characters.h1 = chr('h1', 'home', { x: 1, y: 1 });
    f.characters.h4 = chr('h4', 'home', { x: 4, y: 1 });
    const it_ = createInteractions();
    it_.handle({ type: 'down', cell: { x: 1, y: 1 }, target: { kind: 'figure', id: 'c0' }, time: 0 }, f);
    it_.handle({ type: 'move', cell: { x: 99, y: 99 }, home: { x: 7, y: 1 }, time: 10 }, f);
    const d = it_.drag();
    expect(d?.kind === 'figure' && d.over).toEqual({ islandId: 'home', local: { x: 7, y: 1 }, free: true });
    expect(it_.handle({ type: 'up', cell: { x: 99, y: 99 }, home: { x: 7, y: 1 }, time: 20 }, f)).toEqual({ type: 'move', id: 'c0', islandId: 'home' });
  });
  it('home cannot be dragged or resized, but its label still selects', () => {
    const f = fleet();
    const it_ = createInteractions();
    it_.handle({ type: 'down', cell: { x: 31, y: 1 }, target: { kind: 'label', islandId: 'home' }, time: 0 }, f);
    it_.handle({ type: 'move', cell: { x: 35, y: 3 }, time: 10 }, f);
    expect(it_.drag()).toBeUndefined();
    expect(it_.handle({ type: 'up', cell: { x: 35, y: 3 }, time: 20 }, f)).toEqual({ type: 'selectIsland', id: 'home' });
    it_.handle({ type: 'down', cell: { x: 37, y: 3 }, target: { kind: 'handle', islandId: 'home' }, time: 30 }, f);
    it_.handle({ type: 'move', cell: { x: 39, y: 4 }, time: 40 }, f);
    expect(it_.drag()).toBeUndefined();
  });
  it('a world cell inside home stored footprint is water', () => {
    const f = fleet();
    expect(cellOwner(f, { x: 31, y: 1 })).toBeUndefined();
    expect(islandNear(f, { x: 31, y: 1 })).toBeUndefined();
    expect(mapIslands(f).map((i) => i.id).sort()).toEqual(['i_a', 'i_b', 'i_e']);
  });
});
