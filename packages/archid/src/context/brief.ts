import { linkGlyph, type BrowserTab, type Character, type ContextItem, type Island } from '@archipelago/protocol';
import type { DocEntry, DocFolder } from '../docs.js';
import type { HookName } from '../hooks/receiver.js';
import { oneLine } from '../text.js';

const headline = (name: string, text: string): string => (text ? `${name} — ${text}` : name);

const itemLine = (it: ContextItem): string => {
  const label = it.label && it.label !== it.ref ? `${it.label} ` : '';
  const marks = [it.prState, it.pinned && 'pinned'].filter(Boolean);
  const tail = marks.length ? ` (${marks.join(', ')})` : '';
  return `- ${linkGlyph(it.kind)} ${label}${it.ref}${tail}`;
};

const section = (title: string, items: ContextItem[]): string[] => (items.length ? [`${title}:`, ...items.map(itemLine)] : []);

// a fragment is the page's own state, a sign-in's token among it; what is left of a long url is cut short, on one line
const tabLine = (t: BrowserTab, active: boolean): string => `- ${t.title ? `${t.title} ` : ''}${clip(oneLine(t.url.split('#')[0]))}${active ? ' (active)' : ''}`;

const DESCRIPTION_MAX = 200;
const clip = (s: string): string => (s.length > DESCRIPTION_MAX ? `${s.slice(0, DESCRIPTION_MAX - 1)}…` : s);

// a name is whatever the filesystem holds, so it is flattened before it can forge a line of its own
const flat = (s: string): string => s.replace(/\s+/g, ' ').trim();

// one line a doc: the brief reaches a session as a line diff, so the path travels with the name
const docLine = (d: DocEntry): string => {
  const name = flat(d.name);
  return `- ${d.description ? `${name} — ${clip(d.description)}` : name} (${flat(d.path)})`;
};

function docLines(folders: DocFolder[]): string[] {
  if (!folders.length) return [];
  const listed = folders.filter((f) => f.docs.length);
  return [
    ...listed.flatMap((f) => [`Docs (${f.tier}):`, ...f.docs.map(docLine)]),
    ...(listed.length ? ["Read a doc when its description matches what you're doing."] : []),
    'Leave a note for the next agent as <name>.md with a `description:` frontmatter line, in the narrowest folder it applies to:',
    ...folders.map((f) => `- ${f.tier}: ${f.dir}`),
  ];
}

// markdown the session reads at start; without doc folders it is empty when neither side has anything to say
export function renderBrief(island: Island, character?: Character, folders: DocFolder[] = []): string {
  const head = [
    `Island: ${headline(island.name, island.description)}`,
    island.instructions && `Island instructions: ${island.instructions}`,
    character && `Character: ${headline(character.name, character.note)}`,
    character?.instructions && `Character instructions: ${character.instructions}`,
  ].filter((l): l is string => Boolean(l));
  const items = [...section('Context (island)', island.context), ...(character ? section('Context (character)', character.context) : [])];
  const docs = docLines(folders);
  const tabs = character?.browser?.tabs.length ? ['Browser tabs:', ...character.browser.tabs.map((t) => tabLine(t, t.id === character.browser?.active))] : [];
  const said = island.description || island.instructions || items.length || docs.length || tabs.length || character?.note || character?.instructions;
  if (!said) return '';
  const pinned = [...island.context, ...(character?.context ?? [])].some((it) => it.pinned);
  const show = character ? `\`archi char show ${character.id}\`` : `\`archi island show ${island.id}\``;
  const foot = `${pinned ? 'Read pinned items before starting. ' : ''}${show} reprints this.`;
  const body = [items, docs, tabs].filter((b) => b.length).flatMap((b, i) => (i ? ['', ...b] : b));
  return ['# Archipelago context', ...head, '', ...(body.length ? [...body, ''] : []), foot].join('\n');
}

// removed lines, then added, each in the order of its source; multiset by line text
function lineChanges(prev: string, next: string): { removed: string[]; added: string[] } {
  const count = (lines: string[]) => lines.reduce((m, l) => m.set(l, (m.get(l) ?? 0) + 1), new Map<string, number>());
  const a = prev ? prev.split('\n') : [], b = next ? next.split('\n') : [];
  const inB = count(b), inA = count(a);
  const removed = a.filter((l) => { const n = inB.get(l) ?? 0; if (n) { inB.set(l, n - 1); return false; } return true; });
  const added = b.filter((l) => { const n = inA.get(l) ?? 0; if (n) { inA.set(l, n - 1); return false; } return true; });
  return { removed, added };
}

export function briefDiff(prev: string, next: string): string {
  if (prev === next) return '';
  const { removed, added } = lineChanges(prev, next);
  // a reorder leaves the same lines in a different order: nothing to say
  if (!removed.length && !added.length) return '';
  return ['# Archipelago context changed', ...removed.map((l) => `- ${l}`), ...added.map((l) => `+ ${l}`)].join('\n');
}

// the delivered brief as if the change from before to after had reached the session too, so the next diff
// carries every other pending change and not this one; a change to a line still pending goes out with it
export function carryBrief(delivered: string | undefined, before: string, after: string): string | undefined {
  if (delivered === before) return after;
  if (delivered === undefined) return before ? undefined : after;
  const { removed, added } = lineChanges(before, after);
  const lines = delivered ? delivered.split('\n') : [];
  for (const l of removed) { const i = lines.indexOf(l); if (i === -1) return delivered; lines.splice(i, 1); }
  return [...lines, ...added].join('\n');
}

// what the session gets for this hook, and what to remember as delivered
export function briefReply(name: HookName, brief: string, delivered: string | undefined): { reply?: string; delivered?: string } {
  if (name !== 'SessionStart' && name !== 'UserPromptSubmit') return {};
  if (name === 'SessionStart' || delivered === undefined) return brief ? { reply: brief, delivered: brief } : {};
  if (delivered === brief) return {};
  return { reply: briefDiff(delivered, brief), delivered: brief };
}
