import { app } from './boot.js';
import { showMenu } from './bridge.js';

type Press = Pick<MouseEvent, 'clientX' | 'clientY' | 'preventDefault'>;

// the right-click menus the sidebar and the map share; Delete only asks, and the confirmation does the deleting
export const characterMenu = (e: Press, id: string): void =>
  showMenu(app.bridge, e, [{ title: 'Delete', run: () => app.store.getState().setClosingCharacter(id) }]);

// the daemon deletes only an empty island, so one with a crew shows Delete greyed out
export const islandMenu = (e: Press, id: string, empty: boolean): void =>
  showMenu(app.bridge, e, [{ title: 'Delete', run: empty ? () => app.store.getState().setDeletingIsland(id) : undefined }]);
