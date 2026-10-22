import path from 'node:path';
import { Command } from 'commander';
import { expandHome } from '@svall/svalld/paths';
import { bareUrl, contextKind, isPathRef, itemUrl, type ContextItem } from '@svall/protocol';

// a token with a scheme or an absolute path starts an item; everything else is the label of the item before it
const startsItem = (token: string): boolean => /^[a-z][a-z0-9+.-]*:\/\//i.test(token) || isPathRef(token);

export function parseContext(spec: string): ContextItem[] {
  const parts = spec.trim().split(/\s+/).filter(Boolean);
  const items: { ref: string; label: string[] }[] = [];
  // words before the first ref are a label written ahead of its link; they name the first item when nothing follows it
  const lead: string[] = [];
  for (const part of parts) {
    if (startsItem(part)) items.push({ ref: part, label: [] });
    else if (items.length) items[items.length - 1].label.push(part);
    else lead.push(part);
  }
  if (!items.length) throw new Error(`bad --context "${spec}", expected <ref>[ label]`);
  if (lead.length && !items[0].label.length) items[0].label = lead;
  return items.map(({ ref, label }) => ({ kind: contextKind(ref), ref, label: label.join(' ') || ref, source: 'manual' }));
}

export type ContextFlags = { context: string[]; pin: string[]; unpin: string[]; drop: string[] };
const repeat = (v: string, acc: string[]) => [...acc, v];

// a ref as svalld stores it: a path expanded and resolved, a link at the level worth a chip; so a ~ path or a view
// inside a PR given here matches the stored item, and an item given as ~/x in the same command matches its own ref
const refKey = (ref: string): string => (isPathRef(ref) ? path.resolve(expandHome(ref.trim())) : bareUrl(itemUrl(ref)));

// --context replaces the manual items (auto and scribe kept); --pin/--unpin set or clear pinned by ref; --drop removes by ref.
export function editContext(current: ContextItem[], o: ContextFlags): ContextItem[] | undefined {
  if (!o.context.length && !o.pin.length && !o.unpin.length && !o.drop.length) return undefined;
  const items = o.context.length ? [...current.filter((it) => it.source !== 'manual'), ...o.context.flatMap(parseContext)] : [...current];
  const known = new Set(items.map((it) => refKey(it.ref)));
  for (const [flag, refs] of [['--pin', o.pin], ['--unpin', o.unpin], ['--drop', o.drop]] as const) {
    const missing = refs.find((ref) => !known.has(refKey(ref)));
    if (missing !== undefined) throw new Error(`${flag} ${missing} matches no context item`);
  }
  const pin = o.pin.map(refKey), unpin = o.unpin.map(refKey), drop = o.drop.map(refKey);
  return items.filter((it) => !drop.includes(refKey(it.ref))).map((it) => {
    const ref = refKey(it.ref);
    if (pin.includes(ref)) return { ...it, pinned: true as const };
    if (unpin.includes(ref)) { const { pinned: _p, ...rest } = it; return rest; }
    return it;
  });
}

export function contextOptions(cmd: Command): Command {
  return cmd
    .option('--context <spec>', '<ref>[ label]..., repeatable; each URL or absolute path starts a new item; replaces the manual items', repeat, [] as string[])
    .option('--pin <ref>', 'mark an item to read before starting, repeatable', repeat, [] as string[])
    .option('--unpin <ref>', 'unmark a pinned item, repeatable', repeat, [] as string[])
    .option('--drop <ref>', 'remove an item, repeatable', repeat, [] as string[])
    .option('--instructions <text>', 'agent-only instructions');
}
