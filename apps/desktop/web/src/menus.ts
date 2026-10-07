import { toggleStar } from './actions.js';
import { app, deps } from './boot.js';
import type { MenuEntry } from './store/ui.js';

type Press = Pick<MouseEvent, 'clientX' | 'clientY' | 'preventDefault'>;

// the page draws the menu in its own look, so the browser's stays away
const showMenu = (e: Press, items: MenuEntry[]): void => {
  e.preventDefault();
  app.store.getState().openMenu({ x: e.clientX, y: e.clientY, items });
};

// Rename leads where the caller has a field to rename in
const renameFirst = (rename?: () => void) => (rename ? [{ title: 'Rename', run: rename }] : []);

// the right-click menus the sidebar and the map share; Delete only asks, and the confirmation does the deleting
export const characterMenu = (e: Press, id: string, rename?: () => void): void => {
  const starred = app.store.getState().fleet.characters[id]?.star !== undefined;
  showMenu(e, [...renameFirst(rename), { title: starred ? 'Unstar' : 'Star', run: () => toggleStar(deps(), id) },
    { title: 'Delete', danger: true, run: () => app.store.getState().setClosingCharacter(id) }]);
};

// the daemon deletes only an empty island, so one with a crew shows Delete greyed out
export const islandMenu = (e: Press, id: string, empty: boolean, rename?: () => void): void =>
  showMenu(e, [...renameFirst(rename), { title: 'Delete', danger: true, run: empty ? () => app.store.getState().setDeletingIsland(id) : undefined }]);
