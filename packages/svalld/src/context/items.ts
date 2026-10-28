import fs from 'node:fs';
import { bareUrl, isPathRef, itemUrl, type ContextItem } from '@svall/protocol';
import { Invalid } from '../errors.js';
import { expandHome } from '../paths.js';

// every link refresh reads each ref over again
export const MAX_REF = 4096;

// a link is stored at the level worth a chip, so a view inside a PR reads as the PR. an item already stored is kept
// as is, so one dead path never blocks the rest
export function settleItems(items: ContextItem[], current: ContextItem[] = []): ContextItem[] {
  const stored = new Map(current.map((it) => [it.ref, it]));
  return items.map((raw) => {
    if (/[\n\r]/.test(raw.ref)) throw new Invalid(`context ref must not contain a newline: ${raw.ref}`);
    const it = isPathRef(raw.ref) ? raw : { ...raw, ref: itemUrl(raw.ref) };
    const kept = stored.get(it.ref);
    if (kept) return { ...it, ref: kept.ref, kind: kept.kind };
    if (it.ref.length > MAX_REF) throw new Invalid(`a context ref may run to ${MAX_REF} characters: ${it.ref.slice(0, 80)}…`);
    if (!isPathRef(it.ref) && it.kind !== 'file' && it.kind !== 'folder') return it;
    const ref = expandHome(it.ref.trim());
    let dir: boolean;
    try { dir = fs.statSync(ref).isDirectory(); } catch { throw new Invalid(`no such file or folder: ${it.ref}`); }
    return { ...it, ref, kind: dir ? 'folder' : 'file' };
  });
}

// a scribe or branch link a person names as removed is remembered, so neither adds it back until it is added by hand
export function setContext(holder: { context: ContextItem[]; removedLinks?: string[] }, next: ContextItem[], removed: string[] = []): void {
  const kept = new Set(next.map((it) => bareUrl(it.ref)));
  const named = new Set(removed.map((ref) => bareUrl(itemUrl(ref))));
  const gone = holder.context.filter((it) => it.source !== 'manual' && named.has(bareUrl(it.ref))).map((it) => bareUrl(it.ref));
  const all = [...new Set([...(holder.removedLinks ?? []), ...gone])].filter((ref) => !kept.has(ref));
  holder.context = next;
  if (all.length) holder.removedLinks = all; else delete holder.removedLinks;
}

// the PR the work is on leads a robot's links: the branch's own, as the lookup shows it or the scribe holds it (the
// lookup reads a state for that PR alone), else the first the scribe found. A PR the user added stays where they put it
export function prFirst(items: ContextItem[]): ContextItem[] {
  const pr = items.find((it) => it.kind === 'pr' && it.source === 'auto')
    ?? items.find((it) => it.kind === 'pr' && it.source === 'scribe' && it.prState)
    ?? items.find((it) => it.kind === 'pr' && it.source === 'scribe');
  return pr ? [pr, ...items.filter((it) => it !== pr)] : items;
}
