import type { FleetState } from '@svall/protocol';
import type { Api } from '../api.js';
import type { AppStore } from '../store/index.js';
import { theme } from '../theme.js';

export type ResourcesDeps = { api: Pick<Api, 'call'>; store: AppStore };

/** What the listing is made of, as one string: the roots, and every island and character by id, name and place. It is asked again only when this moves. */
export const listingKey = (f: FleetState): string => [
  ...[...new Set(Object.values(f.characters).map((c) => c.repo?.mainRoot ?? c.cwd))].sort(),
  ...Object.values(f.islands).map((i) => `i:${i.id}:${i.name}`).sort(),
  ...Object.values(f.characters).map((c) => `c:${c.id}:${c.name}:${c.islandId}:${c.agentProfile ?? ''}`).sort(),
].join('\n');

// svalld walks every root for each read, so a store has one read out at a time, and keeps the last for a moment;
// a read started after another is the one whose answer counts
type Reading = { out?: Promise<void>; freshUntil: number; n: number };
const readings = new WeakMap<AppStore, Reading>();
const readingOf = (s: AppStore): Reading => {
  let r = readings.get(s);
  if (!r) readings.set(s, r = { freshUntil: 0, n: 0 });
  return r;
};

async function read(d: ResourcesDeps, r: Reading): Promise<void> {
  const n = ++r.n;
  try {
    const { sources } = await d.api.call('resources.get', {});
    if (n !== r.n) return;
    d.store.getState().setResources(sources);
    r.freshUntil = Date.now() + theme.resourcesFreshMs;
  } catch { /* the side card's button and the signs' counts wait for the next ask */ }
}

/** Reads the listing now: after something in it was made, renamed, deleted or saved, or when the user asks. */
export function reloadResources(d: ResourcesDeps): Promise<void> {
  const r = readingOf(d.store);
  const p = read(d, r);
  r.out = p;
  void p.then(() => { if (r.out === p) r.out = undefined; });
  return p;
}

/** Has the listing read unless it is being read or was a moment ago, so a burst of asks costs one read. */
export function loadResources(d: ResourcesDeps): Promise<void> {
  const r = readingOf(d.store);
  if (r.out) return r.out;
  if (Date.now() < r.freshUntil) return Promise.resolve();
  return reloadResources(d);
}

export function followResources(d: ResourcesDeps): () => void {
  let key: string | undefined;
  const check = (s = d.store.getState(), prev?: typeof s) => {
    if (!s.loaded || s.fleet === prev?.fleet) return;
    const next = listingKey(s.fleet);
    if (next === key) return;
    key = next;
    void reloadResources(d);
  };
  check();
  return d.store.subscribe(check);
}
