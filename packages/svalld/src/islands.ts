import { DEFAULT_SIZE, byIslandOrder, landCells, type Cell, type ContextItem, type Island, type Size } from '@svall/protocol';
import { settleItems } from './context/items.js';
import { removeDocs } from './docs.js';
import { Invalid, NotFound } from './errors.js';
import { newId } from './ids.js';
import { arrangeFleet, defaultPosition, freePosition, makeRoom, placementOk, randomSeed, relocateDrowned, settleHome, uniqueName } from './layout.js';
import type { Logger } from './log.js';
import type { Paths } from './paths.js';
import type { Store } from './store.js';

type Deps = { store: Store; log: Logger; paths: Paths };
export type NewIsland = { name: string; position?: Cell; size?: Size; seed?: number; description?: string; instructions?: string; context?: ContextItem[] };
export type IslandPatch = { name?: string; description?: string; instructions?: string; context?: ContextItem[]; position?: Cell; size?: Size; collapsed?: boolean };

// text a person writes stays theirs until they clear it; cleared, the scribe may write it again
function setDescription(i: Island, description: string): void {
  i.description = description;
  if (description) i.descriptionSource = 'manual'; else delete i.descriptionSource;
}

export function createIsland({ store }: Deps, p: NewIsland): Island {
  const state = store.state;
  const size = p.size ?? DEFAULT_SIZE;
  const wanted = p.position ?? defaultPosition(state);
  const island: Island = {
    id: newId('i'), name: uniqueName(state, p.name), description: p.description ?? '', instructions: p.instructions ?? '', context: settleItems(p.context ?? [], []),
    position: wanted, size, seed: p.seed ?? randomSeed(),
  };
  setDescription(island, island.description);
  island.position = freePosition(state, island);
  if (!placementOk(state, island)) throw new Invalid(`island ${p.name} would overlap another island`);
  // an island joining or leaving is where mission control takes its place again; between those it holds its row
  store.update((d) => { d.islands[island.id] = island; settleHome(d); });
  return island;
}

export function updateIsland({ store, log }: Deps, id: string, patch: IslandPatch): Island {
  const current = store.state.islands[id];
  if (!Object.hasOwn(store.state.islands, id)) throw new NotFound(`no island ${id}`);
  // home is drawn in screen space; only its text and its fold can change
  const p: typeof patch = current.kind === 'home'
    ? { name: patch.name, description: patch.description, instructions: patch.instructions, context: patch.context, collapsed: patch.collapsed }
    : patch;
  const next: Island = { ...current, position: p.position ?? current.position, size: p.size ?? current.size, collapsed: p.collapsed ?? current.collapsed };
  // names resolve without regard to case, so a twin would leave both islands unreachable by name
  const clash = p.name !== undefined && Object.values(store.state.islands)
    .find((i) => i.id !== id && i.name.toLowerCase() === p.name!.toLowerCase());
  if (clash) throw new Invalid(`another island is already called ${clash.name}`);
  if ((p.position || p.size) && !placementOk(store.state, next)) throw new Invalid(`island ${current.name} would overlap another island`);
  const members = Object.values(store.state.characters).filter((c) => c.islandId === id);
  if (p.size && landCells(next.size, next.seed).length < members.length) throw new Invalid(`island ${current.name} would have fewer cells than characters`);
  const context = p.context && settleItems(p.context, current.context);
  store.update((d) => {
    const i = d.islands[id];
    if (p.name !== undefined) i.name = p.name;
    if (p.description !== undefined) setDescription(i, p.description);
    if (p.instructions !== undefined) i.instructions = p.instructions;
    if (context) i.context = context;
    if (p.position) i.position = p.position;
    if (p.size) {
      i.size = p.size;
      relocateDrowned(d, id);
    }
    if (p.collapsed !== undefined) {
      if (p.collapsed) i.collapsed = true; else delete i.collapsed;
      // an island taking its ground back pushes whatever stands on it aside
      if (!p.collapsed) {
        const crowded = makeRoom(d, id);
        if (crowded > 0) log.error(`island ${i.name}: ${crowded} island(s) the search could not settle`);
      }
    }
  });
  return store.state.islands[id];
}

// one update for the whole fleet: islands moved one at a time would collide with the ones still to move
export function arrangeIslands({ store }: Deps, aspect?: number): void {
  store.update((d) => arrangeFleet(d, aspect));
}

// a sidebar drop numbers every island in the new order, so islands made later follow them
export function reorderIsland({ store }: Deps, id: string, targetId: string, after: boolean): Island {
  for (const x of [id, targetId]) if (!Object.hasOwn(store.state.islands, x)) throw new NotFound(`no island ${x}`);
  if (store.state.islands[id].kind === 'home' || store.state.islands[targetId].kind === 'home') throw new Invalid('mission control stays last');
  if (id === targetId) return store.state.islands[id];
  const order = Object.values(store.state.islands).filter((i) => i.kind !== 'home').sort(byIslandOrder)
    .map((i) => i.id).filter((x) => x !== id);
  order.splice(order.indexOf(targetId) + Number(after), 0, id);
  store.update((d) => { order.forEach((x, n) => { d.islands[x].order = n; }); });
  return store.state.islands[id];
}

export function deleteIsland({ store, log, paths }: Deps, id: string): void {
  if (!Object.hasOwn(store.state.islands, id)) throw new NotFound(`no island ${id}`);
  if (store.state.islands[id].kind === 'home') throw new Invalid('mission control cannot be deleted');
  if (Object.values(store.state.characters).some((c) => c.islandId === id)) throw new Invalid(`island ${store.state.islands[id].name} is not empty`);
  store.update((d) => { delete d.islands[id]; settleHome(d); });
  removeDocs(paths.docs, 'island', id, log);
}
