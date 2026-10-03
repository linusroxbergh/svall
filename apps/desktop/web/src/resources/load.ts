import type { FleetState } from '@svall/protocol';
import type { Api } from '../api.js';
import type { AppStore } from '../store/index.js';

export type ResourcesDeps = { api: Pick<Api, 'call'>; store: AppStore };

/** What the listing is made of, as one string: the roots, and every island and character by id, name and place. It is asked again only when this moves. */
export const listingKey = (f: FleetState): string => [
  ...[...new Set(Object.values(f.characters).map((c) => c.repo?.mainRoot ?? c.cwd))].sort(),
  ...Object.values(f.islands).map((i) => `i:${i.id}:${i.name}`).sort(),
  ...Object.values(f.characters).map((c) => `c:${c.id}:${c.name}:${c.islandId}:${c.agentProfile ?? ''}`).sort(),
].join('\n');

export async function loadResources(d: ResourcesDeps): Promise<void> {
  try { d.store.getState().setResources((await d.api.call('resources.get', {})).sources); }
  catch { /* the side card's button and the signs' counts wait for the next ask */ }
}

export function followResources(d: ResourcesDeps): () => void {
  let key: string | undefined;
  const check = (s = d.store.getState(), prev?: typeof s) => {
    if (!s.loaded || s.fleet === prev?.fleet) return;
    const next = listingKey(s.fleet);
    if (next === key) return;
    key = next;
    void loadResources(d);
  };
  check();
  return d.store.subscribe(check);
}
