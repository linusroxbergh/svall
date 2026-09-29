import type { ResourceItem } from '@svall/protocol';
import { openFolder, revealFile, type Bridge } from '../bridge.js';
import { openFile, placeCursor } from '../ide/files.js';
import type { ResourcesDeps } from './load.js';
import { isCard, isField, type Item } from './model.js';

export type ChooseDeps = ResourcesDeps & { bridge: Bridge };

const showInFinder = (bridge: Bridge, i: Pick<ResourceItem, 'reveal' | 'target'>): void =>
  (i.target === 'folder' ? openFolder(bridge, i.reveal) : revealFile(bridge, i.reveal));

/** A chosen row opens its file in the editor, or puts the card's own field there; a row that names
 *  no file of its own is only shown in Finder. A link is followed by the list, not from here. */
export async function chooseResource(d: ChooseDeps, i: Item): Promise<void> {
  if (isCard(i)) {
    if (isField(i.card)) { d.store.getState().showResourceField(i.card); d.store.getState().chooseResourceRow(i.id); }
    return;
  }
  if (!i.open) { showInFinder(d.bridge, i); return; }
  await openFile(d, i.open.rootId, i.open.path);
  d.store.getState().chooseResourceRow(i.id);
  if (i.open.find) placeCursor(i.open.rootId, i.open.path, i.open.find);
}
