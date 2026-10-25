import { columnOf } from '@svall/protocol';
import { deleteEmptyColumn, placeRobot, releaseRobot, setPlacing, setStar, stepColumn } from './actions.js';
import { app, deps } from './boot.js';
import { scribePlaces } from './selectors.js';
import type { MenuEntry } from './store/ui.js';

type Press = Pick<MouseEvent, 'clientX' | 'clientY' | 'preventDefault'>;

// the page draws the menu in its own look, so the browser's stays away
const showMenu = (e: Press, items: MenuEntry[]): void => {
  e.preventDefault();
  app.store.getState().openMenu({ x: e.clientX, y: e.clientY, items });
};

// Rename leads where the caller has a field to rename in
const renameFirst = (rename?: () => void) => (rename ? [{ title: 'Rename', run: rename }] : []);

const starEntry = (id: string): MenuEntry => {
  const starred = app.store.getState().fleet.robots[id]?.star !== undefined;
  return { title: starred ? 'Unstar' : 'Star', run: () => setStar(deps(), id, !starred) };
};
const deleteEntry = (id: string): MenuEntry => ({ title: 'Delete', danger: true, run: () => app.store.getState().setClosingRobot(id) });

// the right-click menus the sidebar and the map share; Delete only asks, and the confirmation does the deleting
export const robotMenu = (e: Press, id: string, rename?: () => void): void =>
  showMenu(e, [...renameFirst(rename), starEntry(id), deleteEntry(id)]);

// the board's leads with opening the terminal and renaming in the card, and adds the columns to move the robot to
// and a hand move to hand back to the scribe
export const boardRobotMenu = (e: Press, id: string, rename: () => void): void => {
  const f = app.store.getState().fleet;
  const c = f.robots[id];
  if (!c) return;
  const here = columnOf(f, c).id;
  showMenu(e, [
    { title: 'Open terminal', run: () => app.store.getState().focus(id) },
    { title: 'Rename', run: rename },
    starEntry(id),
    { title: 'Move to', items: f.columns.map((k) => ({ title: k.name, checked: k.id === here, run: () => { if (k.id !== here) void placeRobot(deps(), id, k.id); } })) },
    { title: 'Let the scribe place it', run: c.columnSource === 'manual' ? () => releaseRobot(deps(), id) : undefined },
    deleteEntry(id),
  ]);
};

// the daemon deletes only an empty island, so one with a crew shows Delete greyed out
export const islandMenu = (e: Press, id: string, empty: boolean, rename?: () => void): void =>
  showMenu(e, [...renameFirst(rename), { title: 'Delete', danger: true, run: empty ? () => app.store.getState().setDeletingIsland(id) : undefined }]);

// a column with robots asks where they go before it is deleted; the board keeps its last column
export const columnMenu = (e: Press, id: string, o: { rename(): void; collapse(): void; addAfter(): void }): void => {
  const f = app.store.getState().fleet;
  const at = f.columns.findIndex((k) => k.id === id);
  const crowded = Object.values(f.robots).some((c) => columnOf(f, c).id === id);
  const remove = () => (crowded ? app.store.getState().setDeletingColumn(id) : void deleteEmptyColumn(deps(), id));
  showMenu(e, [
    { title: 'Rename', run: o.rename },
    { title: 'Move left', run: at > 0 ? () => stepColumn(deps(), id, -1) : undefined },
    { title: 'Move right', run: at < f.columns.length - 1 ? () => stepColumn(deps(), id, 1) : undefined },
    { title: 'Collapse', run: o.collapse },
    { title: 'Add column after', run: o.addAfter },
    { title: 'Delete', danger: true, run: f.columns.length > 1 ? remove : undefined },
  ]);
};

// the board's Auto-place chip: who places robots, with the scribe to pick only while it runs
export const placingMenu = (x: number, y: number): void => {
  const f = app.store.getState().fleet;
  const on = scribePlaces(f);
  const scribe = !f.scribeOff && !f.scribeAsk;
  app.store.getState().openMenu({ x, y, bare: true, items: [
    { title: 'Off', note: 'by hand only', checked: !on, run: () => setPlacing(deps(), false) },
    { title: 'Scribe', checked: on, run: scribe ? () => setPlacing(deps(), true) : undefined },
    { title: 'Scribe settings…', sep: true, run: () => app.store.getState().toggleSettings(true, 'fleet') },
  ] });
};
