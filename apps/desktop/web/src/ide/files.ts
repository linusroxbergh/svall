import type { Api } from '../api.js';
import type { Bridge } from '../bridge.js';
import { pick, shows, type Surface } from '../panes.js';
import { accountHome, basename, shortPath } from '../paths.js';
import { panesOf } from '../selectors.js';
import type { AppStore } from '../store/index.js';
import { dropBuffer, getBuffer, isDirty, key, loadBuffer, markSaved, replaceText, select, type Buffer } from './buffers.js';
import { readsOn } from '../placement.js';
import { EditorView } from '@codemirror/view';
import { editorExtensions, languageFor, readOnlyExtensions } from './codemirror.js';
import { rootIn } from '../store/ide.js';
import { absOf, isAbsolute, placeOf, resolve, rootOf } from './where.js';

type FilesDeps = { api: Pick<Api, 'call'>; store: AppStore };

const saveListeners = new Set<(d: FilesDeps, id: string, path: string) => void>();
const saves = new Map<string, Promise<void>>();
// the latest disk check started for each buffer
const checks = new WeakMap<Buffer, number>();

/** Runs after every successful write, whichever call made it — autosave, Cmd-S, or Overwrite. */
export function onSaved(listener: (d: FilesDeps, id: string, path: string) => void): void {
  saveListeners.add(listener);
}

async function load(d: FilesDeps, id: string, path: string): Promise<void> {
  if (getBuffer(id, path)) return;
  const [{ text, mtimeMs, root }, lang] = await Promise.all([d.api.call('fs.read', { id, path }), languageFor(basename(path))]);
  // a file on a worker opens read-only, as it is edited in the robot's terminal there
  const on = readsOn(d.store.getState().fleet, id);
  const shown = on ? [readOnlyExtensions(), EditorView.lineWrapping] : editorExtensions(() => { void saveFile(d, id, path); });
  Object.assign(loadBuffer(id, path, text, mtimeMs, [shown, lang ?? []]), { root, on });
}

/** Shows the file in the editor: from its buffer when it has one, else read from svalld. One that cannot be read opens no tab and says why. */
export async function openFile(d: FilesDeps, id: string, path: string): Promise<void> {
  // an absolute path under the root opens as its place there, so the file has one tab
  const root = rootIn(d.store.getState(), id);
  const place = root !== undefined && isAbsolute(path) ? placeOf(path, root) : path;
  try { await load(d, id, place); } catch (e) {
    d.store.getState().showToast(`${place}: ${(e as Error).message}`);
    return;
  }
  d.store.getState().openFile(id, place);
}

/** A path followed in the robot's terminal `beside`, as its agent prints it: relative to its cwd, and maybe ending in :line or :line:col.
 *  Files opens on the other side, a file at its line, a folder as the tree's top; a file the editor cannot show goes to the Mac. */
export async function openPath(d: FilesDeps & { bridge: Pick<Bridge, 'present' | 'send'> }, id: string, text: string, beside: Surface): Promise<void> {
  const c = d.store.getState().fleet.robots[id];
  if (!c) return;
  const root = rootOf(c);
  // the terminal's link takes in the stop that ends a sentence, and the spaces that end a line
  const [, name, line] = /^(.*?)(?::(\d+))?(?::\d+)?$/.exec(text.trimEnd().replace(/[.!?;]+$/, ''))!;
  // git gives the root by its real path, so a cwd below a link other than /private's is not under it; the root stands in
  const cwd = placeOf(c.cwd, root);
  const abs = resolve(name, isAbsolute(cwd) ? root : absOf(cwd, root), accountHome(root) ?? accountHome(d.store.getState().shell?.home));
  const path = placeOf(abs, root);
  const panes = panesOf(d.store.getState(), id);
  if (!shows(panes, 'files')) d.store.getState().setPanes(id, pick(panes, panes.right === beside ? 'left' : 'right', 'files'));
  try { await load(d, id, path); } catch (e) {
    const code = (e as { code?: string }).code;
    const s = d.store.getState();
    if (code === 'binary' || code === 'too_large') {
      s.reveal(id, path);
      if (d.bridge.present) d.bridge.send({ type: 'openFile', path: abs });
    } else if (code === 'not_found' && await d.api.call('fs.list', { id, path }).then(() => true, () => false)) s.reveal(id, path, true);
    else s.showToast(code === 'not_found' ? `${shortPath(abs)} is not there` : (e as Error).message);
    return;
  }
  d.store.getState().openFile(id, path);
  if (line) placeLine(id, path, Number(line));
}

/** The cursor goes to the first place `find` stands; text that is not there moves nothing. */
export function placeCursor(id: string, path: string, find: string): void {
  const at = getBuffer(id, path)?.state.doc.toString().indexOf(find) ?? -1;
  if (at >= 0) select(id, path, at);
}

/** The cursor goes to the start of line `n`, or of the last line in a shorter file. */
function placeLine(id: string, path: string, n: number): void {
  const doc = getBuffer(id, path)?.state.doc;
  if (doc) select(id, path, doc.line(Math.min(Math.max(1, n), doc.lines)).from);
}

/** Writes the buffer if the disk still has the mtime it was read at, or with `over`, the newer one Overwrite writes over.
 *  A save made while another is out goes after it, with the mtime that one left. */
export function saveFile(d: FilesDeps, id: string, path: string, over = false): Promise<void> {
  const k = key(id, path);
  const prev = saves.get(k);
  const run = () => write(d, id, path, over);
  const p = prev ? prev.then(run, run) : run();
  saves.set(k, p);
  const settled = () => { if (saves.get(k) === p) saves.delete(k); };
  void p.then(settled, settled);
  return p;
}

async function write(d: FilesDeps, id: string, path: string, over: boolean): Promise<void> {
  const b = getBuffer(id, path);
  if (!b) return;
  // the text that goes out is the text that counts as saved; typing goes on meanwhile
  const doc = b.state.doc;
  try {
    const r = await d.api.call('fs.write', { id, path, text: doc.toString(), mtimeMs: over ? (b.diskMtimeMs ?? b.mtimeMs) : b.mtimeMs, root: b.root });
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
export function overwriteFile(d: FilesDeps, id: string, path: string): Promise<void> {
  return saveFile(d, id, path, true);
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
    const n = (checks.get(b) ?? 0) + 1;
    checks.set(b, n);
    let disk: { text: string; mtimeMs: number; root: string };
    try { disk = await d.api.call('fs.read', { id, path }); } catch { return; }
    // a tab opened again meanwhile holds another buffer; a check started since answers instead
    if (getBuffer(id, path) !== b || checks.get(b) !== n) return;
    // the robot may have moved to another checkout, where the same mtime is still another file;
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
