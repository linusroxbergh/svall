import type { Api } from '../api.js';
import type { AppStore } from '../store/index.js';
import { dropBuffer, getBuffer, isDirty, loadBuffer, markSaved, replaceText, select } from './buffers.js';
import { editorExtensions, languageFor } from './codemirror.js';

type FilesDeps = { api: Pick<Api, 'call'>; store: AppStore };

const name = (path: string): string => path.slice(path.lastIndexOf('/') + 1);

const saveListeners = new Set<(d: FilesDeps, id: string, path: string) => void>();

/** Runs after every successful write, whichever call made it — autosave, Cmd-S, or Overwrite. */
export function onSaved(listener: (d: FilesDeps, id: string, path: string) => void): void {
  saveListeners.add(listener);
}

/** Shows the file in the editor: from its buffer when it has one, else read from svalld. One that cannot be read opens no tab and says why. */
export async function openFile(d: FilesDeps, id: string, path: string): Promise<void> {
  if (!getBuffer(id, path)) {
    try {
      const [{ text, mtimeMs, root }, lang] = await Promise.all([d.api.call('fs.read', { id, path }), languageFor(name(path))]);
      loadBuffer(id, path, text, mtimeMs, [editorExtensions(() => { void saveFile(d, id, path); }), lang ?? []]).root = root;
    } catch (e) {
      d.store.getState().showToast(`${path}: ${(e as Error).message}`);
      return;
    }
  }
  d.store.getState().openFile(id, path);
}

/** The cursor goes to the first place `find` stands; text that is not there moves nothing. */
export function placeCursor(id: string, path: string, find: string): void {
  const at = getBuffer(id, path)?.state.doc.toString().indexOf(find) ?? -1;
  if (at >= 0) select(id, path, at);
}

/** Writes the buffer if the disk still has the mtime it was read at, or `over`, the newer one Overwrite writes over. */
export async function saveFile(d: FilesDeps, id: string, path: string, over?: number): Promise<void> {
  const b = getBuffer(id, path);
  if (!b) return;
  // the text that goes out is the text that counts as saved; typing goes on meanwhile
  const doc = b.state.doc;
  try {
    const r = await d.api.call('fs.write', { id, path, text: doc.toString(), mtimeMs: over ?? b.mtimeMs, root: b.root });
    // the tab may have closed meanwhile, and took its flags with it
    if (getBuffer(id, path) !== b) return;
    if (r.conflict) { b.diskMtimeMs = r.mtimeMs; d.store.getState().markFile(id, path, { conflict: true }); return; }
    markSaved(id, path, doc, r.mtimeMs);
    d.store.getState().markFile(id, path, { dirty: isDirty(b), conflict: false, failed: false });
    for (const listener of saveListeners) listener(d, id, path);
  } catch (e) {
    d.store.getState().markFile(id, path, { failed: true });
    d.store.getState().showToast(`Save failed: ${(e as Error).message}`);
  }
}

/** Takes the disk's text, dropping the buffer's edits. */
export async function reloadFile(d: FilesDeps, id: string, path: string): Promise<void> {
  try {
    const { text, mtimeMs, root } = await d.api.call('fs.read', { id, path });
    replaceText(id, path, text, mtimeMs);
    const b = getBuffer(id, path);
    if (b) b.root = root;
    d.store.getState().markFile(id, path, { dirty: false, conflict: false, failed: false });
  } catch (e) {
    d.store.getState().showToast(`${path}: ${(e as Error).message}`);
  }
}

/** Saves the buffer over whatever the disk has now. */
export async function overwriteFile(d: FilesDeps, id: string, path: string): Promise<void> {
  const b = getBuffer(id, path);
  if (!b) return;
  await saveFile(d, id, path, b.diskMtimeMs ?? b.mtimeMs);
}

/** Closes the tab and forgets the buffer, edits and all. */
export function closeFile(d: Pick<FilesDeps, 'store'>, id: string, path: string): void {
  dropBuffer(id, path);
  d.store.getState().closeFile(id, path);
}

/** The open files against the disk: a clean buffer follows it, a dirty one is flagged. A file that cannot be read is left as it is. */
export async function checkDisk(d: FilesDeps, id: string): Promise<void> {
  const open = d.store.getState().ide[id]?.open ?? [];
  await Promise.all(open.map(async (path) => {
    const b = getBuffer(id, path);
    if (!b) return;
    let disk: { text: string; mtimeMs: number; root: string };
    try { disk = await d.api.call('fs.read', { id, path }); } catch { return; }
    // the character may have moved to another checkout, where the same mtime is still another file;
    // back where the buffer was read, a conflict flagged while it was away no longer stands
    if (disk.mtimeMs === b.mtimeMs && disk.root === b.root) {
      if (b.diskMtimeMs !== undefined) { b.diskMtimeMs = undefined; d.store.getState().markFile(id, path, { conflict: false }); }
      return;
    }
    if (isDirty(b)) { b.diskMtimeMs = disk.mtimeMs; d.store.getState().markFile(id, path, { conflict: true }); return; }
    // a mounted view reports the replacement as an edit; the flag is settled here
    replaceText(id, path, disk.text, disk.mtimeMs);
    b.root = disk.root;
    d.store.getState().markFile(id, path, { dirty: false });
  }));
}
