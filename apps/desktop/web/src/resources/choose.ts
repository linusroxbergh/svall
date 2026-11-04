import type { ResourceItem } from '@svall/protocol';
import { openFolder, revealFile, type Bridge } from '../bridge.js';
import { openFile, placeCursor } from '../ide/files.js';
import { myMachine, rootMachine } from '../placement.js';
import type { ResourcesDeps } from './load.js';
import { isCard, isField, type Item } from './model.js';

type ChooseDeps = ResourcesDeps & { bridge: Bridge };

const showInFinder = (bridge: Bridge, i: Pick<ResourceItem, 'reveal' | 'target'>, machine: string | undefined): void =>
  (i.target === 'folder' ? openFolder(bridge, i.reveal, machine) : revealFile(bridge, i.reveal, machine));

/** A chosen row opens its file in the editor, or puts the card's own field there; a row that names no file of its own is only
 *  shown in Finder, and one whose root is on another machine not at all. A link is followed by the list, not from here. */
export async function chooseResource(d: ChooseDeps, i: Item, rootId = 'r:'): Promise<void> {
  if (isCard(i)) {
    if (isField(i.card)) { d.store.getState().showResourceField(i.card); d.store.getState().chooseResourceRow(i.id); }
    return;
  }
  if (!i.open) {
    const on = rootMachine(rootId, d.store.getState());
    if (on === myMachine(d.store.getState())) showInFinder(d.bridge, i, on);
    return;
  }
  await openFile(d, i.open.rootId, i.open.path);
  d.store.getState().chooseResourceRow(i.id);
  if (i.open.find) placeCursor(i.open.rootId, i.open.path, i.open.find);
}
