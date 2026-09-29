import type { FleetState } from '@svall/protocol';
import type { StateCreator } from 'zustand/vanilla';
import { SINGLE, shows, withoutSecond, type Panes } from '../panes.js';
import type { App } from './index.js';

// the panes a character shows, how the two share the width, and the editor's open files; page state, per character.
// failed holds the files whose last write went wrong
export type IdeState = { panes: Panes; ratio: number; open: string[]; active?: string; expanded: string[]; dirty: string[]; conflict: string[]; failed: string[] };
const emptyIde = (): IdeState => ({ panes: SINGLE, ratio: 0.5, open: [], expanded: [], dirty: [], conflict: [], failed: [] });

// the same list back when nothing changes, so a caller can tell
const withSet = (list: string[], v: string, on: boolean): string[] =>
  list.includes(v) === on ? list : on ? [...list, v] : list.filter((x) => x !== v);

// a character that is gone takes its panes and buffers with it; a resource root is nobody's. A second
// terminal that ended closes the pane that showed it; one still starting has no record yet and stays
export const pruneIde = (ide: Record<string, IdeState>, f: FleetState, prev: FleetState): Record<string, IdeState> =>
  Object.fromEntries(Object.entries(ide).filter(([id]) => id.startsWith('r:') || f.characters[id]).map(([id, s]) => {
    if (!prev.characters[id]?.second || f.characters[id]?.second || !shows(s.panes, 'terminal2')) return [id, s];
    return [id, { ...s, panes: withoutSecond(s.panes) }];
  }));

export type IdeSliceState = { ide: Record<string, IdeState> };

export type IdeActions = {
  setPanes(id: string, panes: Panes): void;
  setRatio(id: string, ratio: number): void;
  openFile(id: string, path: string): void;
  closeFile(id: string, path: string): void;
  activateFile(id: string, path: string): void;
  toggleFolder(id: string, path: string): void;
  markFile(id: string, path: string, flags: { dirty?: boolean; conflict?: boolean; failed?: boolean }): void;
};

export const createIdeSlice: StateCreator<App, [], [], IdeSliceState & IdeActions> = (set) => ({
  ide: {},
  setPanes: (id, panes) => set((s) => ({ ide: { ...s.ide, [id]: { ...(s.ide[id] ?? emptyIde()), panes } } })),
  // a drag fires this on every mouse move; skip the render when the clamp or the snap gives the same ratio
  setRatio: (id, ratio) => set((s) => (s.ide[id]?.ratio === ratio ? {} : { ide: { ...s.ide, [id]: { ...(s.ide[id] ?? emptyIde()), ratio } } })),
  openFile: (id, path) => set((s) => {
    const cur = s.ide[id] ?? emptyIde();
    return { ide: { ...s.ide, [id]: { ...cur, open: withSet(cur.open, path, true), active: path } }, ...(id.startsWith('r:') && { resourcesShown: { rootId: id, path }, resourcesField: undefined }) };
  }),
  closeFile: (id, path) => set((s) => {
    const cur = s.ide[id] ?? emptyIde();
    const i = cur.open.indexOf(path);
    const open = cur.open.filter((p) => p !== path);
    const active = cur.active === path ? open[Math.max(0, i - 1)] : cur.active;
    return {
      ide: { ...s.ide, [id]: { ...cur, open, active, dirty: withSet(cur.dirty, path, false), conflict: withSet(cur.conflict, path, false), failed: withSet(cur.failed, path, false) } },
      // the shelf's editor shows the file it was last sent; the one just closed is no longer there to show
      ...(s.resourcesShown?.rootId === id && s.resourcesShown.path === path && { resourcesShown: undefined }),
    };
  }),
  activateFile: (id, path) => set((s) => ({ ide: { ...s.ide, [id]: { ...(s.ide[id] ?? emptyIde()), active: path } } })),
  toggleFolder: (id, path) => set((s) => { const cur = s.ide[id] ?? emptyIde(); return { ide: { ...s.ide, [id]: { ...cur, expanded: withSet(cur.expanded, path, !cur.expanded.includes(path)) } } }; }),
  markFile: (id, path, flags) => set((s) => {
    const cur = s.ide[id] ?? emptyIde();
    const dirty = flags.dirty === undefined ? cur.dirty : withSet(cur.dirty, path, flags.dirty);
    const conflict = flags.conflict === undefined ? cur.conflict : withSet(cur.conflict, path, flags.conflict);
    const failed = flags.failed === undefined ? cur.failed : withSet(cur.failed, path, flags.failed);
    // the editor marks its file on every keystroke; skip the render when no flag moved
    if (dirty === cur.dirty && conflict === cur.conflict && failed === cur.failed) return {};
    return { ide: { ...s.ide, [id]: { ...cur, dirty, conflict, failed } } };
  }),
});
