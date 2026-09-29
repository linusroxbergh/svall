import { bareUrl, linkKind, type ContextItem, type FleetState } from '@svall/protocol';
import type { Config } from '../config.js';
import { pool } from '../pool.js';
import type { Store } from '../store.js';
import { prFirst } from '../context/items.js';
import { lookupPr as defaultLookupPr } from './gh.js';
import { originUrl as defaultOriginUrl, resolveRepo } from './git.js';
import { linearLink } from './linear.js';

export type Deps = {
  lookupPr: (cwd: string, branch: string) => Promise<ContextItem | undefined>;
  originUrl: (cwd: string) => Promise<string | undefined>;
};
const defaults: Deps = { lookupPr: defaultLookupPr, originUrl: defaultOriginUrl };

// how many characters may be out asking git and gh at once
export const CONCURRENCY = 4;
// the ticks a full pass over the fleet is spread across, so no one tick carries the whole crew
export const SLICES = 10;

/** The share of the fleet this tick looks at; SLICES consecutive ticks cover all of it, each once. */
export const slice = (ids: string[], tick: number): string[] =>
  ids.filter((_, i) => i % SLICES === tick % SLICES);

// the repository path behind the url: everything the host is not
const repoLabel = (url: string): string => { try { return new URL(url).pathname.replace(/^\/+/, ''); } catch { return url; } };

type Change = (d: FleetState) => void;

/** What a character's links should become, as a change to apply; nothing when the character is gone. */
async function linkChange(store: Store, config: Config, charId: string, deps: Partial<Deps>): Promise<Change | undefined> {
  const { lookupPr, originUrl } = { ...defaults, ...deps };
  const c = store.state.characters[charId];
  if (!c) return undefined;
  const repo = await resolveRepo(c.cwd);
  // a detached HEAD names no branch to find a PR or ticket by: in the checkout on record, as mid-rebase, the links stand
  const detached = repo?.branch === 'HEAD';
  const hold = detached && c.repo?.root === repo.root;
  const auto: ContextItem[] = [];
  // a lookup that failed says nothing of the PR, so the one on record stands while the character keeps to its branch
  let failed = false;
  if (repo && !hold) {
    const pr = detached ? undefined : await lookupPr(c.cwd, repo.branch).catch(() => { failed = true; return undefined; });
    if (pr) auto.push(pr);
    const lin = linearLink(repo.branch, config.linear);
    if (lin) auto.push(lin);
    // the change first, then the ticket; the repository alone is too coarse to be worth a chip beside a PR
    if (!pr) {
      const origin = await originUrl(c.cwd);
      const linkedPr = origin && c.context.some((it) => it.kind === 'pr' && bareUrl(it.ref).startsWith(`${bareUrl(origin).slice(0, -1)}/pull/`));
      if (origin && !linkedPr) auto.push({ kind: linkKind(origin), ref: origin, label: repoLabel(origin), source: 'auto' });
    }
  }
  return (d) => {
    const cur = d.characters[charId];
    // a character that moved while its links were being read is left to the refresh that follows the move
    if (!cur || cur.cwd !== c.cwd) return;
    if (repo) cur.repo = repo; else delete cur.repo;
    if (hold) return;
    // a checkout recorded detached, as mid-rebase, is taken to have come back to the branch it left
    const sameBranch = c.repo?.root === repo?.root && (c.repo?.branch === repo?.branch || c.repo?.branch === 'HEAD');
    const carried = failed && sameBranch ? cur.context.filter((l) => l.source === 'auto' && l.kind === 'pr') : [];
    const all = [...carried, ...auto];
    // a pin survives the rebuild of auto items by matching on ref, as the scheme and the trailing slash may differ
    const pins = new Set(cur.context.filter((l) => l.pinned).map((l) => bareUrl(l.ref)));
    // one chip per ref: another source's item naming a link found here stays as it is, with the PR state read for it,
    // or the one it has when the lookup failed
    const found = new Map(all.map((a) => [bareUrl(a.ref), a]));
    const kept = cur.context.filter((l) => l.source !== 'auto').map(({ prState, ...l }) => {
      const read = found.get(bareUrl(l.ref))?.prState ?? (failed ? prState : undefined);
      return read ? { ...l, prState: read } : l;
    });
    const held = new Set(kept.map((l) => bareUrl(l.ref)));
    cur.context = prFirst([
      ...kept,
      ...all.filter((a) => !held.has(bareUrl(a.ref))).map((a) => (pins.has(bareUrl(a.ref)) ? { ...a, pinned: true as const } : a)),
    ]);
  };
}

export async function refreshLinks(store: Store, config: Config, charId: string, deps: Partial<Deps> = {}): Promise<void> {
  const change = await linkChange(store, config, charId, deps);
  if (change) store.update(change);
}

/** A slice of the fleet at once: bounded while it asks, and one state change when it answers. */
export async function refreshMany(store: Store, config: Config, ids: string[], deps: Partial<Deps> = {}): Promise<void> {
  const changes = (await pool(ids, CONCURRENCY, (id) => linkChange(store, config, id, deps))).filter((c) => c !== undefined);
  if (changes.length) store.update((d) => { for (const change of changes) change(d); });
}
