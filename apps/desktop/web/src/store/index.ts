import { createStore, type StoreApi } from 'zustand/vanilla';
import { createFleetSlice, type FleetActions, type FleetSliceState } from './fleet.js';
import { createIdeSlice, type IdeActions, type IdeSliceState } from './ide.js';
import { type AppStorage } from './persist.js';
import { createShelfSlice, type ShelfActions, type ShelfState } from './shelf.js';
import { createUiSlice, type UiActions, type UiState, type View } from './ui.js';

export type { AppStorage, FilesTree, HalfCard, ResourceCols, Section, SideWidths } from './persist.js';
export { DEFAULT_HALF_CARD, FILES_TREE_RANGE, HALF_CARD_RANGE, RESOURCE_COL_RANGE, SETTINGS_KEY, SIDE_WIDTH_RANGE, localAppStorage } from './persist.js';
export type { CardSize, View } from './ui.js';

export type AppState = FleetSliceState & UiState & ShelfState & IdeSliceState;
export type AppActions = FleetActions & UiActions & ShelfActions & IdeActions;
export type App = AppState & AppActions;
export type AppStore = StoreApi<App>;

export function createAppStore(storage?: AppStorage, initialView?: View): AppStore {
  const view: View = initialView ?? storage?.getView() ?? 'map';
  return createStore<App>((...a) => ({
    ...createFleetSlice(...a),
    ...createUiSlice(storage, view)(...a),
    ...createShelfSlice(storage)(...a),
    ...createIdeSlice(...a),
  }));
}
