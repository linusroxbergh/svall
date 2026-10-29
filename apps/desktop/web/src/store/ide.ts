import type { FleetState } from '@svall/protocol';
import type { StateCreator } from 'zustand/vanilla';
import { absOf, between, isAbsolute, parent, placeOf, rootOf, within } from '../ide/where.js';
import { SINGLE, shows, withoutSecond, type Panes } from '../panes.js';
import type { App } from './index.js';

// the panes a robot shows, how the two share the width, and the editor's open files; page state, per robot.
// failed holds the files whose last write went wrong; top is the folder the files tree shows, '' for the robot's root
export type IdeState = { panes: Panes; ratio: number; open: string[]; active?: string; top: string; expanded: string[]; dirty: string[]; conflict: string[]; failed: string[] };
const emptyIde = (): IdeState => ({ panes: SINGLE, ratio: 0.5, open: [], top: '', expanded: [], dirty: [], conflict: [], failed: [] });

// the same list back when nothing changes, so a caller can tell
const withSet = (list: string[], v: string, on: boolean): string[] =>
  list.includes(v) === on ? list : on ? [...list, v] : list.filter((x) => x !== v);

export const rootIn = (s: App, id: string): string | undefined => {
  if (id.startsWith('r:')) return id.slice(2);
  const c = s.fleet.robots[id];
  return c && rootOf(c);
};

// the tree stays where it stands when it shows the path already; otherwise it moves to the robot's root for a path under it,
// and to the path's own folder for any other. The folders on the way down open
function revealIn(cur: IdeState, path: string, root: string | undefined, folder = false): IdeState {
  if (root === undefined) return cur;
  const abs = absOf(path, root);
  const top = within(abs, absOf(cur.top, root)) ? cur.top : !isAbsolute(path) ? '' : folder ? path : parent(abs);
  const from = folder ? path : placeOf(parent(abs), root);
  return { ...cur, top, expanded: between(from, top, root).reduce((list, d) => withSet(list, d, true), cur.expanded) };
}

// a robot that is gone takes its panes and buffers with it, a resource root is nobody's, and a second terminal
// the fleet no longer carries closes the pane that showed it (a dormant one keeps it); nothing pruned gives `ide` back
export const pruneIde = (ide: Record<string, IdeState>, f: FleetState, prev: FleetState): Record<string, IdeState> => {
  const next = Object.fromEntries(Object.entries(ide).filter(([id]) => id.startsWith('r:') || f.robots[id]).map(([id, s]) => {
    if (!prev.robots[id]?.second || f.robots[id]?.second || !shows(s.panes, 'terminal2')) return [id, s];
    return [id, { ...s, panes: withoutSecond(s.panes) }];
  }));
  const ids = Object.keys(next);
  return ids.length === Object.keys(ide).length && ids.every((id) => next[id] === ide[id]) ? ide : next;
};

// a markdown file `svall app show --preview` asked to see formatted; its editor clears the ask once it shows it
export type IdeSliceState = { ide: Record<string, IdeState>; previewAsk?: { id: string; path: string } };

export type IdeActions = {
  setPanes(id: string, panes: Panes): void;
  setRatio(id: string, ratio: number): void;
  openFile(id: string, path: string): void;
  closeFile(id: string, path: string): void;
  activateFile(id: string, path: string): void;
  reveal(id: string, path: string, folder?: boolean): void;
  setTop(id: string, top: string): void;
  toggleFolder(id: string, path: string): void;
  markFile(id: string, path: string, flags: { dirty?: boolean; conflict?: boolean; failed?: boolean }): void;
  askPreview(ask?: { id: string; path: string }): void;
};

export const createIdeSlice: StateCreator<App, [], [], IdeSliceState & IdeActions> = (set) => ({
  ide: {},
  previewAsk: undefined,
  askPreview: (previewAsk) => set({ previewAsk }),
  setPanes: (id, panes) => set((s) => ({ ide: { ...s.ide, [id]: { ...(s.ide[id] ?? emptyIde()), panes } } })),
  // a drag fires this on every mouse move; skip the render when the clamp or the snap gives the same ratio
  setRatio: (id, ratio) => set((s) => (s.ide[id]?.ratio === ratio ? {} : { ide: { ...s.ide, [id]: { ...(s.ide[id] ?? emptyIde()), ratio } } })),
  openFile: (id, path) => set((s) => {
    const cur = s.ide[id] ?? emptyIde();
    return { ide: { ...s.ide, [id]: revealIn({ ...cur, open: withSet(cur.open, path, true), active: path }, path, rootIn(s, id)) }, ...(id.startsWith('r:') && { resourcesShown: { rootId: id, path }, resourcesField: undefined }) };
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
  activateFile: (id, path) => set((s) => ({ ide: { ...s.ide, [id]: revealIn({ ...(s.ide[id] ?? emptyIde()), active: path }, path, rootIn(s, id)) } })),
  reveal: (id, path, folder) => set((s) => ({ ide: { ...s.ide, [id]: revealIn(s.ide[id] ?? emptyIde(), path, rootIn(s, id), folder) } })),
  // going up opens the folders down to where the tree stood
  setTop: (id, top) => set((s) => {
    const cur = s.ide[id] ?? emptyIde();
    const root = rootIn(s, id);
    if (root === undefined || cur.top === top) return {};
    return { ide: { ...s.ide, [id]: { ...cur, top, expanded: between(cur.top, top, root).reduce((list, d) => withSet(list, d, true), cur.expanded) } } };
  }),
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
