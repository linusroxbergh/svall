import { getBuffer, replaceText } from '../ide/buffers.js';
import { closeFile, openFile } from '../ide/files.js';
import { flushDoc } from './autosave.js';
import { loadResources, type ResourcesDeps } from './load.js';
import { docSlug } from './model.js';

const DESCRIPTION = 'description: ';

/** What a new doc holds: a doc is named for its file, so only the description is left to write. */
export const skeleton = (): string => `---\n${DESCRIPTION}\n---\n\n`;

const bare = (path: string): string => path.replace(/\.md$/, '');
const unsaved = (d: ResourcesDeps, rootId: string, path: string): boolean => d.store.getState().ide[rootId]?.dirty.includes(path) ?? false;
const refuse = (d: ResourcesDeps, text: string): false => { d.store.getState().showToast(text); return false; };

// the docs this session made, until the editor lets go of each; only such a doc left blank is thrown away
const fresh = new Set<string>();
const key = (rootId: string, path: string): string => `${rootId}\0${path}`;
export const isFresh = (rootId: string, path: string): boolean => fresh.has(key(rootId, path));

/** Writes <slug>.md under the root and opens it. A taken or empty name is said, and nothing is written. */
export async function createDoc(d: ResourcesDeps, rootId: string, typed: string): Promise<boolean> {
  const slug = docSlug(typed);
  if (!slug) return refuse(d, 'It needs a name');
  const path = `${slug}.md`;
  try { await d.api.call('docs.create', { id: rootId, path, text: skeleton() }); }
  catch (e) { return refuse(d, (e as Error).message); }
  fresh.add(key(rootId, path));
  await loadResources(d);
  await openFile(d, rootId, path);
  return true;
}

/** Renames the file; the editor follows a doc that was open. One with unsaved edits is left alone. */
export async function renameDoc(d: ResourcesDeps, rootId: string, path: string, typed: string): Promise<boolean> {
  const slug = docSlug(typed);
  if (!slug) return refuse(d, 'It needs a name');
  const to = `${slug}.md`;
  if (to === path) return true;
  await flushDoc(rootId, path);
  if (unsaved(d, rootId, path)) return refuse(d, `Save ${bare(path)} before renaming it`);
  try { await d.api.call('docs.rename', { id: rootId, path, to }); }
  catch (e) { return refuse(d, (e as Error).message); }
  const wasOpen = d.store.getState().ide[rootId]?.open.includes(path) ?? false;
  if (wasOpen) closeFile(d, rootId, path);
  await loadResources(d);
  if (wasOpen) await openFile(d, rootId, to);
  return true;
}

/** Unlinks the file and offers, for as long as the toast stands, to put its text back. One with unsaved edits is left alone. */
export async function deleteDoc(d: ResourcesDeps, rootId: string, path: string): Promise<void> {
  await flushDoc(rootId, path);
  if (unsaved(d, rootId, path)) { refuse(d, `Save ${bare(path)} before deleting it`); return; }
  // a doc svalld cannot read still goes; it is only the offer to put it back that needs the text
  let text: string | undefined;
  try { ({ text } = await d.api.call('fs.read', { id: rootId, path })); } catch { text = undefined; }
  try { await d.api.call('docs.delete', { id: rootId, path }); }
  catch (e) { refuse(d, (e as Error).message); return; }
  closeFile(d, rootId, path);
  await loadResources(d);
  const put = text;
  const undo = put === undefined ? undefined : () => {
    void d.api.call('docs.create', { id: rootId, path, text: put }).then(() => loadResources(d), (e: Error) => d.store.getState().showToast(e.message));
  };
  d.store.getState().showToast(`Deleted ${bare(path)}`, 'ok', undo && { label: 'Undo', run: undo });
}

/** As the editor lets go of a doc: one this session made and nobody wrote in is deleted, anything else waiting is saved. */
export async function letGo(d: ResourcesDeps, rootId: string, path: string): Promise<void> {
  const made = fresh.delete(key(rootId, path));
  // what waits is written first, so the disk holds no earlier save of this doc's own
  await flushDoc(rootId, path);
  if (!made || getBuffer(rootId, path)?.state.doc.toString() !== skeleton()) return;
  // something else may have written the file meanwhile: that text is kept and shown, and a file already gone is only closed
  let disk: { text: string; mtimeMs: number };
  try { disk = await d.api.call('fs.read', { id: rootId, path }); }
  catch (e) { if ((e as { code?: string }).code === 'not_found') closeFile(d, rootId, path); return; }
  if (disk.text !== skeleton()) {
    replaceText(rootId, path, disk.text, disk.mtimeMs);
    d.store.getState().markFile(rootId, path, { dirty: false, conflict: false });
    return;
  }
  try { await d.api.call('docs.delete', { id: rootId, path }); }
  catch (e) { refuse(d, (e as Error).message); return; }
  closeFile(d, rootId, path);
  await loadResources(d);
  d.store.getState().showToast(`Discarded empty ${bare(path)}`, 'ok');
}
