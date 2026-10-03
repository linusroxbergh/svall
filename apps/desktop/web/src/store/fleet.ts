import jsonpatch, { type Operation } from 'fast-json-patch';
import { emptyState, type FleetState, type ResourceSource } from '@svall/protocol';
import type { StateCreator } from 'zustand/vanilla';
import type { Api, Status } from '../api.js';
import { whereTier } from '../resources/model.js';
import { pruneIde } from './ide.js';
import type { App, AppStore } from './index.js';

// the fleet as the daemon last showed it, the listing that hangs off it, and the state of the link itself
export type FleetSliceState = { fleet: FleetState; loaded: boolean; status: Status; resources: ResourceSource[] };

export type FleetActions = {
  setFleet(fleet: FleetState): void;
  applyPatch(ops: Operation[]): void;
  setStatus(status: Status): void;
  setResources(sources: ResourceSource[]): void;
};

// a character that vanishes takes its card and focus with it, before any effect can run
const alive = (f: FleetState, id: string | undefined): string | undefined => (id && f.characters[id] ? id : undefined);
// an island's delete is asked only while the island is there and empty
const deletable = (f: FleetState, id: string | undefined): string | undefined =>
  (id && f.islands[id] && !Object.values(f.characters).some((c) => c.islandId === id) ? id : undefined);
const pruned = (s: App, fleet: FleetState) => {
  // a selected island that goes, from here or elsewhere, takes its card with it
  const islandGone = s.selectedIslandId !== undefined && !fleet.islands[s.selectedIslandId];
  return {
    focusedId: alive(fleet, s.focusedId), selectedId: alive(fleet, s.selectedId), card: alive(fleet, s.card), closingCharacter: alive(fleet, s.closingCharacter),
    selectedIslandId: islandGone ? undefined : s.selectedIslandId, sideCardOpen: s.sideCardOpen && !islandGone,
    deletingIsland: deletable(fleet, s.deletingIsland), ide: pruneIde(s.ide, fleet, s.fleet),
  };
};

// a patch copies only the objects on its paths, so an island or a character it leaves alone keeps its identity
function patched(fleet: FleetState, ops: Operation[]): FleetState {
  let doc: Record<string, unknown> = { ...fleet };
  const copied = new Set<unknown>([doc]);
  const own = (pointer: string) => {
    let node = doc;
    for (const key of pointer.split('/').slice(1, -1).map(jsonpatch.unescapePathComponent)) {
      const child = node[key];
      if (!child || typeof child !== 'object') return;
      if (!copied.has(child)) { node[key] = Array.isArray(child) ? [...child] : { ...child }; copied.add(node[key]); }
      node = node[key] as Record<string, unknown>;
    }
  };
  for (const op of ops) {
    // the whole fleet only ever comes as a snapshot
    if (!op.path) throw new Error('a patch on the whole fleet');
    own(op.path);
    if (op.op === 'move') own(op.from);
    doc = jsonpatch.applyOperation(doc, op, false, true).newDocument;
  }
  return doc as FleetState;
}

export const createFleetSlice: StateCreator<App, [], [], FleetSliceState & FleetActions> = (set, get) => ({
  fleet: emptyState(),
  loaded: false,
  status: 'connecting',
  resources: [],
  setFleet: (fleet) => set((s) => ({ fleet, loaded: true, ...pruned(s, fleet) })),
  // patches sent before the snapshot arrives are already folded into it
  applyPatch: (ops) => {
    if (!get().loaded) return;
    const fleet = patched(get().fleet, ops);
    set((s) => ({ fleet, ...pruned(s, fleet) }));
  },
  setStatus: (status) => set({ status }),
  // a listing without the chosen source has nothing to show under it: the rail falls back to its first; a chosen tier is always there
  setResources: (resources) => set((s) => ({ resources, resourcesWhere: whereTier(s.resourcesWhere) || resources.some((r) => r.rootId === s.resourcesWhere) ? s.resourcesWhere : undefined })),
});

// the mirror loads whole on every connect and then follows the patches; one that does not apply means it has
// drifted, and a fresh snapshot resets it
export function followFleet(api: Pick<Api, 'call'>, store: AppStore): { load(): void; patch(ops: Operation[]): void } {
  const load = () => { api.call('state.get', {}).then((f) => store.getState().setFleet(f)).catch(() => {}); };
  return { load, patch: (ops) => { try { store.getState().applyPatch(ops); } catch { load(); } } };
}
