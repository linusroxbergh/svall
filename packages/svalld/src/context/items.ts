import fs from 'node:fs';
import { isPathRef, itemUrl, type ContextItem } from '@svall/protocol';
import { Invalid } from '../errors.js';
import { expandHome } from '../paths.js';

// a path item is stored absolute with the kind the filesystem says; a missing path is refused; a link
// is stored at the level worth a chip, so a view inside a PR reads as the PR.
// an item already in the stored list is kept as is, so one dead path never blocks the rest.
export function settleItems(items: ContextItem[], current: ContextItem[] = []): ContextItem[] {
  const stored = new Map(current.map((it) => [it.ref, it]));
  return items.map((raw) => {
    if (/[\n\r]/.test(raw.ref)) throw new Invalid(`context ref must not contain a newline: ${raw.ref}`);
    const it = isPathRef(raw.ref) ? raw : { ...raw, ref: itemUrl(raw.ref) };
    const kept = stored.get(it.ref);
    if (kept) return { ...it, ref: kept.ref, kind: kept.kind };
    if (!isPathRef(it.ref) && it.kind !== 'file' && it.kind !== 'folder') return it;
    const ref = expandHome(it.ref.trim());
    let dir: boolean;
    try { dir = fs.statSync(ref).isDirectory(); } catch { throw new Invalid(`no such file or folder: ${it.ref}`); }
    return { ...it, ref, kind: dir ? 'folder' : 'file' };
  });
}

// the PR the work is on leads a character's links: the branch's own, else the first the scribe found.
// A PR the user added stays where they put it
export function prFirst(items: ContextItem[]): ContextItem[] {
  const pr = items.find((it) => it.kind === 'pr' && it.source === 'auto') ?? items.find((it) => it.kind === 'pr' && it.source === 'scribe');
  return pr ? [pr, ...items.filter((it) => it !== pr)] : items;
}
