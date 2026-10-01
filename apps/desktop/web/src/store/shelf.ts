import type { ResourceSource } from '@svall/protocol';
import type { StateCreator } from 'zustand/vanilla';
import { offers, type FieldRef, type Tier, type What } from '../resources/model.js';
import type { App } from './index.js';
import { clampCols, DEFAULT_RESOURCE_COLS, DEFAULT_RESOURCE_SIZE, type AppStorage, type HalfCard, type ResourceCols } from './persist.js';

export type ShelfState = {
  resourcesOpen: boolean;
  resourcesWhere?: string;
  resourcesWhat: What;
  // the file the shelf's editor shows; its root may not be the one the rail has chosen
  resourcesShown?: { rootId: string; path: string };
  // an island's or a character's own field, shown in the editor's place; a file and a field are never both up
  resourcesField?: FieldRef;
  // the id of the row that opened it: rows of a kind share a file, so the file cannot say which
  resourcesChosen?: string;
  // set when a card's + new doc opened the shelf, so the list starts its name field; cleared once it has
  resourcesNaming: boolean;
  resourceCols: ResourceCols;
  // the shelf's size as a fraction of its room, and whether it fills the room instead, as the terminal card does the map
  resourceSize: HalfCard;
  resourcesFull: boolean;
  // the tier groups standing open in the shelf's Where column
  resourceGroups: Tier[];
};

export type ShelfActions = {
  toggleResources(open?: boolean, opts?: { where?: string; what?: What; keepPageFocus?: boolean; naming?: boolean }): void;
  setResourcesFilter(f: { where?: string; what?: What }): void;
  toggleResourceGroup(tier: Tier): void;
  chooseResourceRow(id: string): void;
  showResourceField(ref: FieldRef): void;
  setResourcesNaming(v: boolean): void;
  setResourceCols(cols: ResourceCols, persist?: boolean): void;
  setResourceSize(size: HalfCard, persist?: boolean): void;
  toggleResourcesFull(): void;
};

// a source the shelf is sent to must be in view, so its group opens
const withGroupOf = (s: { resources: ResourceSource[]; resourceGroups: Tier[] }, where: string | undefined): Tier[] => {
  const tier = s.resources.find((r) => r.rootId === where)?.tier;
  return tier && !s.resourceGroups.includes(tier) ? [...s.resourceGroups, tier] : s.resourceGroups;
};

// only an island and a character are offered the card's kinds, so a move to any other source falls back to All
const whatFor = (s: { resources: ResourceSource[] }, where: string | undefined, what: What): What =>
  what === 'all' || offers(s.resources.find((r) => r.rootId === (where ?? s.resources[0]?.rootId))?.tier, what) ? what : 'all';

export const createShelfSlice = (storage?: AppStorage): StateCreator<App, [], [], ShelfState & ShelfActions> => (set, get) => ({
  resourcesOpen: false,
  resourcesWhere: undefined,
  resourcesWhat: 'all',
  resourcesShown: undefined,
  resourcesField: undefined,
  resourcesChosen: undefined,
  resourcesNaming: false,
  resourceCols: storage?.getResourceCols() ?? DEFAULT_RESOURCE_COLS,
  resourceSize: storage?.getResourceSize() ?? DEFAULT_RESOURCE_SIZE,
  resourcesFull: false,
  resourceGroups: storage?.getResourceGroups() ?? ['global', 'fleet'],
  // the shelf stands on the map, in the corner panels' light: opening it takes the view there and closes them
  toggleResources: (open, opts) => {
    const next = open ?? !get().resourcesOpen;
    if (next && get().view !== 'map') get().setView('map');
    set((s) => {
      const resourceGroups = withGroupOf(s, opts?.where);
      if (resourceGroups !== s.resourceGroups) storage?.setResourceGroups(resourceGroups);
      return {
        resourcesOpen: next, usageOpen: next ? false : s.usageOpen, mobileOpen: next ? false : s.mobileOpen,
        resourcesWhere: opts?.where ?? s.resourcesWhere,
        resourcesWhat: whatFor(s, opts?.where ?? s.resourcesWhere, opts?.what ?? s.resourcesWhat),
        keepPageFocus: opts?.keepPageFocus ?? false, resourceGroups,
        resourcesNaming: next && (opts?.naming ?? false),
      };
    });
  },
  setResourcesFilter: (f) => set((s) => {
    const resourceGroups = withGroupOf(s, f.where);
    if (resourceGroups !== s.resourceGroups) storage?.setResourceGroups(resourceGroups);
    const resourcesWhere = f.where ?? s.resourcesWhere;
    return { resourcesWhere, resourcesWhat: whatFor(s, resourcesWhere, f.what ?? s.resourcesWhat), resourceGroups };
  }),
  toggleResourceGroup: (tier) => set((s) => {
    const resourceGroups = s.resourceGroups.includes(tier) ? s.resourceGroups.filter((t) => t !== tier) : [...s.resourceGroups, tier];
    storage?.setResourceGroups(resourceGroups);
    return { resourceGroups };
  }),
  chooseResourceRow: (id) => set({ resourcesChosen: id }),
  showResourceField: (ref) => set({ resourcesField: ref, resourcesShown: undefined }),
  setResourcesNaming: (v) => set({ resourcesNaming: v }),
  setResourceCols: (cols, persist = true) => set(() => { const c = clampCols(cols); if (persist) storage?.setResourceCols(c); return { resourceCols: c }; }),
  setResourceSize: (size, persist = true) => set(() => { if (persist) storage?.setResourceSize(size); return { resourceSize: size }; }),
  toggleResourcesFull: () => set((s) => ({ resourcesFull: !s.resourcesFull })),
});
