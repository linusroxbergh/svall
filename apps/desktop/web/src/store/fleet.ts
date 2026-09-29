import jsonpatch, { type Operation } from 'fast-json-patch';
import { emptyState, type FleetState, type ResourceSource } from '@svall/protocol';
import type { StateCreator } from 'zustand/vanilla';
import type { Status } from '../api.js';
import { whereTier } from '../resources/model.js';
import { pruneIde } from './ide.js';
import type { App } from './index.js';

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

export const createFleetSlice: StateCreator<App, [], [], FleetSliceState & FleetActions> = (set, get) => ({
  fleet: emptyState(),
  loaded: false,
  status: 'connecting',
  resources: [],
  setFleet: (fleet) => set((s) => ({ fleet, loaded: true, focusedId: alive(fleet, s.focusedId), selectedId: alive(fleet, s.selectedId), card: alive(fleet, s.card), closingCharacter: alive(fleet, s.closingCharacter), deletingIsland: deletable(fleet, s.deletingIsland), ide: pruneIde(s.ide, fleet, s.fleet) })),
  // patches sent before the snapshot arrives are already folded into it
  applyPatch: (ops) => {
    if (!get().loaded) return;
    const fleet = jsonpatch.applyPatch(get().fleet, ops, false, false).newDocument;
    set((s) => ({ fleet, selectedId: alive(fleet, s.selectedId), card: alive(fleet, s.card), closingCharacter: alive(fleet, s.closingCharacter), deletingIsland: deletable(fleet, s.deletingIsland), ide: pruneIde(s.ide, fleet, s.fleet) }));
  },
  setStatus: (status) => set({ status }),
  // a listing without the chosen source has nothing to show under it: the rail falls back to its first; a chosen tier is always there
  setResources: (resources) => set((s) => ({ resources, resourcesWhere: whereTier(s.resourcesWhere) || resources.some((r) => r.rootId === s.resourcesWhere) ? s.resourcesWhere : undefined })),
});
