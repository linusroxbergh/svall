import { columnOf } from '@svall/protocol';
import { deleteEmptyColumn, placeNow, placeRobot, releaseRobot, setPlacing, setStar } from './actions.js';
import { app, deps } from './boot.js';
import { scribePlaces } from './selectors.js';
import type { MenuEntry } from './store/ui.js';

type Press = Pick<MouseEvent, 'clientX' | 'clientY' | 'preventDefault'>;

// the page draws the menu in its own look, so the browser's stays away
const showMenu = (e: Press, items: MenuEntry[]): void => {
  e.preventDefault();
  app.store.getState().openMenu({ x: e.clientX, y: e.clientY, items });
};

// Rename shows where the caller has a field to rename in
const renameEntry = (rename?: () => void) => (rename ? [{ title: 'Rename', run: rename }] : []);

const openEntry = (id: string): MenuEntry => ({ title: 'Open terminal', run: () => app.store.getState().focus(id) });
const starEntry = (id: string): MenuEntry => {
  const starred = app.store.getState().fleet.robots[id]?.star !== undefined;
  return { title: starred ? 'Unstar' : 'Star', run: () => setStar(deps(), id, !starred) };
};
const deleteEntry = (id: string): MenuEntry => ({ title: 'Delete', danger: true, run: () => app.store.getState().setClosingRobot(id) });

// the right-click menus the sidebar and the map share; Delete only asks, and the confirmation does the deleting
export const robotMenu = (e: Press, id: string, rename?: () => void): void =>
  showMenu(e, [openEntry(id), ...renameEntry(rename), starEntry(id), deleteEntry(id)]);

// the board's adds the columns to move the robot to and a hand move to hand back to the scribe
export const boardRobotMenu = (e: Press, id: string, rename: () => void): void => {
  const f = app.store.getState().fleet;
  const c = f.robots[id];
  if (!c) return;
  const here = columnOf(f, c).id;
  showMenu(e, [
    openEntry(id),
    { title: 'Rename', run: rename },
    starEntry(id),
    { title: 'Move to', items: f.columns.map((k) => ({ title: k.name, checked: k.id === here, run: () => { if (k.id !== here) void placeRobot(deps(), id, k.id); } })) },
    { title: 'Let the scribe place it', run: c.columnSource === 'manual' ? () => releaseRobot(deps(), id) : undefined },
    deleteEntry(id),
  ]);
};

// the daemon deletes only an empty island, so one with a crew shows Delete greyed out
export const islandMenu = (e: Press, id: string, empty: boolean, rename?: () => void): void =>
  showMenu(e, [...renameEntry(rename), { title: 'Delete', danger: true, run: empty ? () => app.store.getState().setDeletingIsland(id) : undefined }]);

// a column with robots asks where they go before it is deleted; the board keeps its last column
export const columnMenu = (e: Press, id: string, o: { rename(): void; collapse(): void }): void => {
  const f = app.store.getState().fleet;
  const crowded = Object.values(f.robots).some((c) => columnOf(f, c).id === id);
  const remove = () => (crowded ? app.store.getState().setDeletingColumn(id) : void deleteEmptyColumn(deps(), id));
  showMenu(e, [
    { title: 'Rename', run: o.rename },
    { title: 'Collapse', run: o.collapse },
    { title: 'Delete', danger: true, run: f.columns.length > 1 ? remove : undefined },
  ]);
};

// the board's Auto-place chip: a placing pass now, then who places robots; both need the scribe running
export const placingMenu = (x: number, y: number): void => {
  const f = app.store.getState().fleet;
  const on = scribePlaces(f);
  const scribe = !f.scribeOff && !f.scribeAsk;
  app.store.getState().openMenu({ x, y, bare: true, items: [
    { title: 'Place now', run: scribe ? () => void placeNow(deps()) : undefined },
    { title: 'Off', note: 'by hand only', checked: !on, sep: true, run: () => setPlacing(deps(), false) },
    { title: 'Scribe', checked: on, run: scribe ? () => setPlacing(deps(), true) : undefined },
    { title: 'Scribe settings…', sep: true, run: () => app.store.getState().toggleSettings(true, 'fleet') },
  ] });
};
