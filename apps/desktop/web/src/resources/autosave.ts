import { frontmatter } from '@svall/protocol';
import { getBuffer, isDirty, subscribeBuffer, type Buffer } from '../ide/buffers.js';
import { onSaved, saveFile } from '../ide/files.js';
import { theme } from '../theme.js';
import { loadResources, type ResourcesDeps } from './load.js';
import { isAgentProfiles } from './model.js';

const key = (id: string, path: string): string => `${id}\0${path}`;
const watched = new WeakSet<Buffer>();
// every doc watched, with the deps its saves go through
const docs = new Map<string, { d: ResourcesDeps; id: string; path: string }>();
const timers = new Map<string, ReturnType<typeof setTimeout>>();
const inflight = new Map<string, Promise<void>>();
// the description each watched buffer's listing row last showed, so any write that changes it — autosave, Cmd-S, Overwrite — is noticed once
const lastDescription = new Map<string, string | undefined>();

async function save(d: ResourcesDeps, id: string, path: string): Promise<void> {
  const b = getBuffer(id, path);
  // a doc whose conflict stands waits for Reload or Overwrite
  if (!b || !isDirty(b) || b.diskMtimeMs !== undefined) return;
  await saveFile(d, id, path);
  // what was typed while the write was out goes in the next one; a write that failed waits for the next edit or ⌘S
  if (!d.store.getState().ide[id]?.failed.includes(path)) schedule(d, id, path);
}

// chains onto whatever save is already running for this doc, so an edit made mid-write lands in a second write with the mtime the first one left;
// a save that failed is swallowed here, not carried into the next one
function startSave(d: ResourcesDeps, id: string, path: string): Promise<void> {
  const k = key(id, path);
  const prev = inflight.get(k) ?? Promise.resolve();
  const p = prev.catch(() => {}).then(() => save(d, id, path));
  inflight.set(k, p);
  const settled = () => { if (inflight.get(k) === p) inflight.delete(k); };
  void p.then(settled, settled);
  return p;
}

function schedule(d: ResourcesDeps, id: string, path: string): void {
  const k = key(id, path);
  clearTimeout(timers.get(k));
  timers.delete(k);
  const b = getBuffer(id, path);
  if (!b || !isDirty(b)) return;
  timers.set(k, setTimeout(() => { timers.delete(k); void startSave(d, id, path); }, theme.docSaveMs));
}

// runs after every successful write; a watched doc's changed description sends the listing back for another read, and so does
// any agent profile's write, since its body decides whether it can be used
function noticeSave(d: ResourcesDeps, id: string, path: string): void {
  const b = getBuffer(id, path);
  if (!b || !watched.has(b)) return;
  const k = key(id, path);
  const now = frontmatter(b.saved.toString()).description;
  if (now === lastDescription.get(k) && !isAgentProfiles(d.store.getState().resources, id)) return;
  lastDescription.set(k, now);
  void loadResources(d);
}
onSaved(noticeSave);

/** Saves the open doc a moment after each edit. A buffer is watched once; one read again after a close is a new buffer. */
export function watchDoc(d: ResourcesDeps, id: string, path: string): void {
  const b = getBuffer(id, path);
  if (!b || watched.has(b)) return;
  watched.add(b);
  docs.set(key(id, path), { d, id, path });
  lastDescription.set(key(id, path), frontmatter(b.saved.toString()).description);
  subscribeBuffer(id, path, () => schedule(d, id, path));
}

// saves an open doc now, after any save in flight, whether or not one was waiting; a closed one only has the save in flight to wait out
function flush(k: string): Promise<void> {
  clearTimeout(timers.get(k));
  timers.delete(k);
  const w = docs.get(k);
  const b = w && getBuffer(w.id, w.path);
  if (w && b && watched.has(b)) return startSave(w.d, w.id, w.path);
  return inflight.get(k) ?? Promise.resolve();
}

/** Writes the doc's unsaved edits now, waiting out a save already in flight so everything typed before this call lands. */
export async function flushDoc(id: string, path: string): Promise<void> {
  await flush(key(id, path));
}

/** Writes every doc's unsaved edits now. */
export async function flushDocs(): Promise<void> {
  await Promise.all([...docs.keys()].map(flush));
}
