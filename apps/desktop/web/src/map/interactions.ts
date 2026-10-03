import { HOME_ISLAND, MIN_SIZE, isHomeSlot, type Cell, type FleetState, type Size } from '@svall/protocol';
import { cellOwner, characterAt, crowded } from './layout.js';
import { theme } from '../theme.js';
import type { Drag, Target } from './types.js';

// `home` is the slot on the home island under the pointer, when the pointer is over its visible land
export type CellEv = { type: 'down' | 'move' | 'up' | 'cancel'; cell: Cell; home?: Cell; target?: Target; time: number; screen?: { x: number; y: number }; scale?: number };

export type Intent =
  | { type: 'select'; id: string }
  | { type: 'selectIsland'; id: string }
  | { type: 'deselect' }
  | { type: 'open'; id: string }
  | { type: 'openIsland'; id: string }
  | { type: 'move'; id: string; islandId: string; cell?: Cell }
  | { type: 'swap'; id: string; otherId: string }
  | { type: 'newIsland'; id: string; cell: Cell }
  | { type: 'moveIsland'; id: string; position: Cell }
  | { type: 'resize'; id: string; size: Size };

type Interactions = { handle(ev: CellEv, fleet: FleetState, selectedId?: string): Intent | undefined; drag(): Drag | undefined; cancel(): void };

const same = (a: Cell, b: Cell) => a.x === b.x && a.y === b.y;

// what a second click has to land on to count as a double click
const clicked = (t: Target): string | undefined =>
  t.kind === 'figure' ? `figure:${t.id}` : t.kind === 'label' ? `island:${t.islandId}` : undefined;

export const DBL_CLICK_MS = 300;

// pointer events produce grid intents; map islands use the screen delta for continuous preview
export function createInteractions(opts: { dblClickMs?: number } = {}): Interactions {
  const dbl = opts.dblClickMs ?? DBL_CLICK_MS;
  let pending: { target: Target; cell: Cell; time: number; opened?: boolean; screen?: { x: number; y: number }; scale?: number } | undefined;
  let drag: Drag | undefined;
  let lastClick: { key: string; time: number } | undefined;

  const startOrUpdateDrag = (ev: CellEv, fleet: FleetState) => {
    const t = pending!.target;
    const offset = ev.screen && pending!.screen && pending!.scale
      ? { x: (ev.screen.x - pending!.screen.x) / pending!.scale, y: (ev.screen.y - pending!.screen.y) / pending!.scale }
      : undefined;
    const delta = offset
      ? { x: Math.round(offset.x / theme.cell), y: Math.round(offset.y / theme.cell) }
      : { x: ev.cell.x - pending!.cell.x, y: ev.cell.y - pending!.cell.y };
    if (t.kind === 'figure') {
      const home = ev.home ? fleet.islands[HOME_ISLAND] : undefined;
      const owner = home && ev.home ? { island: home, local: ev.home, land: true } : cellOwner(fleet, ev.cell);
      const over = owner?.land ? { islandId: owner.island.id, local: owner.local, free: !crowded(fleet, owner.island.id, owner.local, t.id) } : undefined;
      drag = { kind: 'figure', id: t.id, cell: ev.cell, over };
    } else if (t.kind === 'label') {
      const island = fleet.islands[t.islandId];
      if (island && island.kind !== 'home') drag = { kind: 'island', id: t.islandId, position: { x: island.position.x + delta.x, y: island.position.y + delta.y }, ...(offset && { offset }) };
    } else if (t.kind === 'handle') {
      const island = fleet.islands[t.islandId];
      if (island && island.kind !== 'home') drag = { kind: 'resize', id: t.islandId, size: { w: Math.max(MIN_SIZE.w, island.size.w + delta.x), h: Math.max(MIN_SIZE.h, island.size.h + delta.y) }, ...(offset && { offset }) };
    }
  };

  const drop = (d: Drag, fleet: FleetState): Intent | undefined => {
    if (d.kind === 'figure') {
      if (!d.over) return { type: 'newIsland', id: d.id, cell: d.cell };
      const other = characterAt(fleet, d.over.islandId, d.over.local);
      if (other?.id === d.id) return undefined;
      if (other) return { type: 'swap', id: d.id, otherId: other.id };
      // a cell too close to another card, or past the last slot of a full home, asks for the island alone: the fleet finds
      // it a spot, growing the island when none is free
      const target = fleet.islands[d.over.islandId];
      const past = target?.kind === 'home' && !isHomeSlot(target, d.over.local);
      return { type: 'move', id: d.id, islandId: d.over.islandId, cell: d.over.free && !past ? d.over.local : undefined };
    }
    const island = fleet.islands[d.id];
    if (!island) return undefined;
    if (d.kind === 'island') return same(island.position, d.position) ? undefined : { type: 'moveIsland', id: d.id, position: d.position };
    return island.size.w === d.size.w && island.size.h === d.size.h ? undefined : { type: 'resize', id: d.id, size: d.size };
  };

  const click = (t: Target, time: number, selectedId?: string): Intent | undefined => {
    const key = clicked(t);
    if (key) lastClick = { key, time };
    // the card already selected has nothing left to say, so the click opens it
    if (t.kind === 'figure') return { type: t.id === selectedId ? 'open' : 'select', id: t.id };
    if (t.kind === 'label') return { type: 'selectIsland', id: t.islandId };
    if (t.kind === 'handle') return undefined;
    return { type: 'deselect' };
  };

  return {
    handle(ev, fleet, selectedId) {
      switch (ev.type) {
        case 'down': {
          const target = ev.target ?? { kind: 'water' };
          const key = clicked(target);
          const again = Boolean(key && lastClick?.key === key && ev.time - lastClick.time <= dbl);
          // the second press opens, and still starts a drag: a label is also the island's grip. A drag whose release
          // never arrived ends here rather than being dropped by this press's release
          drag = undefined;
          pending = { target, cell: ev.cell, time: ev.time, opened: again, screen: ev.screen, scale: ev.scale };
          if (again) {
            lastClick = undefined;
            if (target.kind === 'figure') return { type: 'open', id: target.id };
            if (target.kind === 'label') return { type: 'openIsland', id: target.islandId };
          }
          return undefined;
        }
        case 'move':
          if (pending && (drag || !same(ev.cell, pending.cell) ||
            (pending.target.kind !== 'figure' && ev.screen && pending.screen &&
              Math.hypot(ev.screen.x - pending.screen.x, ev.screen.y - pending.screen.y) > 4))) startOrUpdateDrag(ev, fleet);
          return undefined;
        case 'up': {
          const p = pending, d = drag;
          pending = undefined; drag = undefined;
          if (!p) return undefined;
          // a drag, or the press that already opened, leaves no click behind to pair with the next one
          if (d || p.opened) { lastClick = undefined; return d ? drop(d, fleet) : undefined; }
          return click(p.target, ev.time, selectedId);
        }
        case 'cancel':
          pending = undefined; drag = undefined; lastClick = undefined;
          return undefined;
      }
    },
    drag: () => drag,
    cancel: () => { pending = undefined; drag = undefined; lastClick = undefined; },
  };
}
