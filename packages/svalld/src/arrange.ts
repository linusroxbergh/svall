import { cellKey, columnOf, isHomeSlot, isLand, starredOf, type Cell, type Column, type FleetState, type Island, type Robot } from '@svall/protocol';
import { Invalid, NotFound } from './errors.js';
import { newId } from './ids.js';
import { blockedCells, crewOf, placeOnIsland, unfold } from './layout.js';
import type { Logger } from './log.js';
import type { Store } from './store.js';

type Deps = { store: Store; log: Logger };

const robotIn = (store: Store, id: string): Robot => {
  if (!Object.hasOwn(store.state.robots, id)) throw new NotFound(`no robot ${id}`);
  return store.state.robots[id];
};

const islandIn = (store: Store, id: string): Island => {
  if (!Object.hasOwn(store.state.islands, id)) throw new NotFound(`no island ${id}`);
  return store.state.islands[id];
};

// the cell before the islandId, or the robot's stale cell would count as occupied on the target island
export function placeOn(d: FleetState, id: string, islandId: string, log: Logger): void {
  const cell = placeOnIsland(d, islandId, id, log);
  d.robots[id].islandId = islandId;
  d.robots[id].cell = cell;
}

export function checkCell(island: Island, cell: Cell): void {
  if (island.kind === 'home' && !isHomeSlot(island, cell)) throw new Invalid(`cell ${cellKey(cell)} is not a home slot`);
  if (!isLand(island, cell)) throw new Invalid(`cell ${cellKey(cell)} is not land`);
}

// one store update: a swap must never be observed half done
export function moveRobot({ store, log }: Deps, id: string, islandId: string, cell?: Cell): Robot {
  robotIn(store, id);
  const island = islandIn(store, islandId);
  // without a cell the fleet picks one and grows the island to fit, even on the island the robot already stands on
  if (!cell) {
    store.update((d) => placeOn(d, id, islandId, log));
    return robotIn(store, id);
  }
  checkCell(island, cell);
  const state = store.state;
  const occupant = Object.values(state.robots).find((o) => o.id !== id && o.islandId === islandId && cellKey(o.cell) === cellKey(cell));
  if (!occupant && blockedCells(state, islandId, id).has(cellKey(cell))) throw new Invalid(`cell ${cellKey(cell)} touches another robot`);
  store.update((d) => {
    const c = d.robots[id];
    const other = occupant ? d.robots[occupant.id] : undefined;
    if (other) { other.islandId = c.islandId; other.cell = c.cell; }
    c.islandId = islandId;
    c.cell = cell;
    if (d.islands[islandId].collapsed) unfold(d, islandId, log);
  });
  return robotIn(store, id);
}

// a sidebar drop, in one update: the crew's occupied cells stay put and its robots rotate through them
export function reorderRobot({ store, log }: Deps, id: string, targetId: string, after: boolean): Robot {
  const moving = robotIn(store, id);
  const target = robotIn(store, targetId);
  if (id === targetId) return moving;
  store.update((d) => {
    if (moving.islandId !== target.islandId) placeOn(d, id, target.islandId, log);
    const crew = crewOf(d, target.islandId).map((robotId) => d.robots[robotId]);
    const cells = crew.map((c) => c.cell);
    const order = crew.map((c) => c.id).filter((c) => c !== id);
    order.splice(order.indexOf(targetId) + Number(after), 0, id);
    order.forEach((robotId, index) => { d.robots[robotId].cell = cells[index]; });
  });
  return robotIn(store, id);
}

// without a target the star goes first; every starred robot is numbered anew in one update
export function starRobot({ store }: Deps, id: string, targetId?: string, after = false): Robot {
  robotIn(store, id);
  if (targetId !== undefined && robotIn(store, targetId).star === undefined) throw new Invalid(`${robotIn(store, targetId).name} is not starred`);
  if (id === targetId) return robotIn(store, id);
  const order = starredOf(store.state).map((c) => c.id).filter((x) => x !== id);
  order.splice(targetId === undefined ? 0 : order.indexOf(targetId) + Number(after), 0, id);
  store.update((d) => { order.forEach((x, n) => { d.robots[x].star = n; }); });
  return robotIn(store, id);
}

export function unstarRobot({ store }: Deps, id: string): Robot {
  robotIn(store, id);
  store.update((d) => { delete d.robots[id].star; });
  return robotIn(store, id);
}

// a hand move holds until releaseRobot; the agent is told nothing of either
export function placeRobot({ store }: Deps, id: string, columnId: string): Robot {
  robotIn(store, id);
  column(store, columnId);
  store.update((d) => {
    const c = d.robots[id];
    c.column = columnId;
    c.columnSource = 'manual';
  });
  return robotIn(store, id);
}

export function releaseRobot({ store }: Deps, id: string): Robot {
  robotIn(store, id);
  store.update((d) => { delete d.robots[id].columnSource; });
  return robotIn(store, id);
}

function column(store: Store, id: string): Column {
  const k = store.state.columns.find((x) => x.id === id);
  if (!k) throw new NotFound(`no column ${id}`);
  return k;
}

// the scribe matches a column by name in any case, so a twin would leave it unable to tell them apart
function columnName(store: Store, name: string, id?: string): string {
  const n = name.trim();
  if (!n) throw new Invalid('a column needs a name');
  const clash = store.state.columns.find((k) => k.id !== id && k.name.toLowerCase() === n.toLowerCase());
  if (clash) throw new Invalid(`another column is already called ${clash.name}`);
  return n;
}

export function addColumn({ store }: Deps, name: string, afterId?: string): Column[] {
  const n = columnName(store, name);
  if (afterId !== undefined) column(store, afterId);
  store.update((d) => {
    const at = afterId === undefined ? d.columns.length : d.columns.findIndex((k) => k.id === afterId) + 1;
    d.columns.splice(at, 0, { id: newId('k'), name: n });
  });
  return store.state.columns;
}

export function renameColumn({ store }: Deps, id: string, name: string): Column[] {
  column(store, id);
  const n = columnName(store, name, id);
  store.update((d) => { d.columns.find((k) => k.id === id)!.name = n; });
  return store.state.columns;
}

// a robot with no column of its own sits in the first, so each one is given the column it sits in before another can become first
export function reorderColumn({ store }: Deps, id: string, targetId: string, after: boolean): Column[] {
  const moving = column(store, id);
  column(store, targetId);
  if (id === targetId) return store.state.columns;
  store.update((d) => {
    for (const c of Object.values(d.robots)) c.column = columnOf(d, c).id;
    const order = d.columns.filter((k) => k.id !== id);
    order.splice(order.findIndex((k) => k.id === targetId) + Number(after), 0, moving);
    d.columns = order;
  });
  return store.state.columns;
}

export function deleteColumn({ store }: Deps, id: string, moveTo: string): Column[] {
  if (store.state.columns.length === 1) throw new Invalid('the board keeps its last column');
  column(store, id);
  column(store, moveTo);
  if (id === moveTo) throw new Invalid("a column's robots have to move to another column");
  // as in reorderColumn, every other robot is given the column it sits in
  store.update((d) => {
    for (const c of Object.values(d.robots)) {
      const k = columnOf(d, c).id;
      c.column = k === id ? moveTo : k;
    }
    d.columns = d.columns.filter((k) => k.id !== id);
  });
  return store.state.columns;
}
