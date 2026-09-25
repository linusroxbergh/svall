import { EditorState, Text, type Extension, type TransactionSpec } from '@codemirror/state';
import { EditorView } from '@codemirror/view';

// the text of an open file as the editor holds it, what the disk last had, and when;
// diskMtimeMs is the disk's newer mtime while a conflict stands, the one Overwrite saves with; root is the folder it was read under
export type Buffer = { state: EditorState; saved: Text; mtimeMs: number; diskMtimeMs?: number; root?: string };

const buffers = new Map<string, Buffer>();
const views = new Map<string, EditorView>();
const listeners = new Map<string, Set<(text: string) => void>>();
const key = (id: string, path: string) => `${id}\0${path}`;
const notify = (k: string, text: string): void => { for (const listener of listeners.get(k) ?? []) listener(text); };

export const isDirty = (b: Buffer): boolean => !b.state.doc.eq(b.saved);

export function loadBuffer(id: string, path: string, text: string, mtimeMs: number, extensions: Extension): Buffer {
  const state = EditorState.create({ doc: text, extensions });
  const b = { state, saved: state.doc, mtimeMs };
  buffers.set(key(id, path), b);
  return b;
}

export const getBuffer = (id: string, path: string): Buffer | undefined => buffers.get(key(id, path));

/** A preview follows edits and disk replacements even when its CodeMirror view is unmounted. */
export function subscribeBuffer(id: string, path: string, listener: (text: string) => void): () => void {
  const k = key(id, path);
  const group = listeners.get(k) ?? new Set<(text: string) => void>();
  group.add(listener);
  listeners.set(k, group);
  const current = buffers.get(k);
  if (current) listener(current.state.doc.toString());
  return () => { group.delete(listener); if (group.size === 0) listeners.delete(k); };
}

/** Keeps the editor's latest state; answers whether it now differs from the disk. */
export function setState(id: string, path: string, state: EditorState): boolean {
  const b = buffers.get(key(id, path));
  if (!b) return false;
  const changed = !b.state.doc.eq(state.doc);
  b.state = state;
  if (changed) notify(key(id, path), state.doc.toString());
  return isDirty(b);
}

/** Moves the selection, through the mounted view when there is one so it scrolls there. */
export function select(id: string, path: string, at: number): void {
  const k = key(id, path);
  const b = buffers.get(k);
  if (!b) return;
  const view = views.get(k);
  if (view) { view.dispatch({ selection: { anchor: at }, scrollIntoView: true }); b.state = view.state; }
  else b.state = b.state.update({ selection: { anchor: at } }).state;
}

/** Applies `spec` through the mounted view when there is one, else to the state; answers whether the buffer now differs from the disk. */
export function editBuffer(id: string, path: string, spec: TransactionSpec): boolean {
  const k = key(id, path);
  const b = buffers.get(k);
  if (!b) return false;
  const view = views.get(k);
  if (view) view.dispatch(spec);
  else {
    const tr = b.state.update(spec);
    b.state = tr.state;
    if (tr.docChanged) notify(k, b.state.doc.toString());
  }
  return isDirty(b);
}

/** Hands the keyboard to the file's mounted view; false when it has none. */
export function focusBuffer(id: string, path: string): boolean {
  const view = views.get(key(id, path));
  view?.focus();
  return view !== undefined;
}

/** Puts the disk's text in the buffer as one change, so undo can bring the edits back. */
export function replaceText(id: string, path: string, text: string, mtimeMs: number): void {
  const b = buffers.get(key(id, path));
  if (!b) return;
  const spec = { changes: { from: 0, to: b.state.doc.length, insert: text } };
  const view = views.get(key(id, path));
  if (view) { view.dispatch(spec); b.state = view.state; }
  else { b.state = b.state.update(spec).state; notify(key(id, path), b.state.doc.toString()); }
  b.saved = b.state.doc;
  b.mtimeMs = mtimeMs;
  b.diskMtimeMs = undefined;
}

/** `doc` is the text that was written; what was typed while the save was under way stays unsaved. */
export function markSaved(id: string, path: string, doc: Text, mtimeMs: number): void {
  const b = buffers.get(key(id, path));
  if (!b) return;
  b.saved = doc;
  b.mtimeMs = mtimeMs;
  b.diskMtimeMs = undefined;
}

const drop = (k: string): void => { views.get(k)?.destroy(); views.delete(k); buffers.delete(k); listeners.delete(k); };

/** A closed file keeps nothing: opening it again reads the disk. */
export const dropBuffer = (id: string, path: string): void => drop(key(id, path));

export function dropBuffers(id: string): void {
  for (const k of [...buffers.keys()]) if (k.startsWith(`${id}\0`)) drop(k);
}

/** Shows the buffer in `parent`; every transaction lands back in the buffer and reports the dirty state. */
export function mountView(id: string, path: string, parent: HTMLElement, onChange: (dirty: boolean) => void): EditorView {
  const k = key(id, path);
  const b = buffers.get(k);
  if (!b) throw new Error(`no buffer for ${path}`);
  const view = new EditorView({
    state: b.state, parent,
    dispatchTransactions: (trs, v) => { v.update(trs); if (trs.some((tr) => tr.docChanged)) onChange(setState(id, path, v.state)); else setState(id, path, v.state); },
  });
  views.get(k)?.destroy();
  views.set(k, view);
  return view;
}

export function unmountView(id: string, path: string): void {
  const k = key(id, path);
  const view = views.get(k);
  if (!view) return;
  const b = buffers.get(k);
  if (b) b.state = view.state;
  view.destroy();
  views.delete(k);
}
