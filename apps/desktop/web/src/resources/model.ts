import type { ContextItem, FleetState, ResourceItem, ResourceKind, ResourceSource } from '@svall/protocol';
import { linkText } from '../map/tokenText.js';
import { islandsSorted } from '../selectors.js';

// what an island or a character carries on its card rather than on disk
export type CardKind = 'note' | 'agentInstructions' | 'links';
export type Kind = ResourceKind | CardKind;
export type What = Kind | 'all';

// short is the islet's sign, singular; colour is a CSS custom property; card marks what comes off the card
export const KINDS: { kind: Kind; label: string; short: string; colour: string; card?: true }[] = [
  { kind: 'docs', label: 'Docs', short: 'doc', colour: '--pt-earth' },
  { kind: 'agentProfiles', label: 'Agent profiles', short: 'profile', colour: '--sand' },
  { kind: 'note', label: 'Note', short: 'note', colour: '--pt-slate', card: true },
  { kind: 'agentInstructions', label: 'Agent instructions', short: 'instructions', colour: '--sand', card: true },
  { kind: 'links', label: 'Links', short: 'link', colour: '--pt-sky', card: true },
  { kind: 'instructions', label: 'Instructions', short: 'instructions', colour: '--sand' },
  { kind: 'skills', label: 'Skills', short: 'skill', colour: '--pt-sun' },
  { kind: 'agents', label: 'Agents', short: 'agent', colour: '--ink-cool' },
  { kind: 'commands', label: 'Commands', short: 'command', colour: '--ink-cool' },
  { kind: 'plugins', label: 'Plugins', short: 'plugin', colour: '--pt-moss' },
  { kind: 'mcp', label: 'MCP servers', short: 'mcp', colour: '--pt-sky' },
  { kind: 'hooks', label: 'Hooks', short: 'hook', colour: '--pt-coral' },
  { kind: 'settings', label: 'Settings', short: 'settings', colour: '--ink-cool' },
  { kind: 'autoMemory', label: 'Memory', short: 'memory', colour: '--ink-cool' },
];

export const kindOf = (kind: Kind) => KINDS.find((k) => k.kind === kind)!;

/** Which field of an island or a character a row stands for, or which of its links. */
export type FieldRef = { tier: 'island' | 'character'; id: string; field: 'note' | 'instructions' };
export type CardRef = FieldRef | { link: ContextItem; charId?: string };
export const isField = (r: CardRef): r is FieldRef => 'field' in r;
type Entity = FleetState['islands'][string] | FleetState['characters'][string];
export const entityOf = (s: { fleet: FleetState }, r: FieldRef): Entity | undefined =>
  (r.tier === 'character' ? s.fleet.characters : s.fleet.islands)[r.id];
export const fieldValue = (e: Entity, field: FieldRef['field']): string =>
  (field === 'instructions' ? e.instructions : 'note' in e ? e.note : e.description);
// the field's own name on the card; an island's note is its description, as the side card calls it
export const fieldLabel = (r: FieldRef): string => (r.field === 'instructions' ? 'Instructions' : r.tier === 'island' ? 'Description' : 'Note');
/** A kind's name in the What column and over the list; an island's note answers to Description there too. */
export const kindLabel = (kind: Kind, tier: ResourceSource['tier'] | undefined): string =>
  (kind === 'note' && tier === 'island' ? 'Description' : kindOf(kind).label);
export type Tier = ResourceSource['tier'];
export type CardItem = Omit<ResourceItem, 'reveal' | 'target' | 'open'> & { card: CardRef };
export type Item = ResourceItem | CardItem;
export type Group = { kind: Kind; items: Item[] };
/** A source as the shelf reads it: the scan's groups, and for an island or a character its card's as well. */
export type Source = Omit<ResourceSource, 'groups'> & { groups: Group[] };

export const isCard = (i: Item): i is CardItem => 'card' in i;

const itemsOf = (s: Source | undefined, kind: Kind): Item[] => s?.groups.find((g) => g.kind === kind)?.items ?? [];

export const countOf = (s: Source | undefined, what: What): number =>
  what === 'all' ? (s?.groups ?? []).reduce((n, g) => n + g.items.length, 0) : itemsOf(s, what).length;

export function visible(s: Source | undefined, what: What, query: string): Group[] {
  const q = query.trim().toLowerCase();
  const hit = (i: Item) => !q || i.name.toLowerCase().includes(q) || (i.detail ?? '').toLowerCase().includes(q);
  return KINDS.filter((k) => what === 'all' || k.kind === what)
    .map((k) => ({ kind: k.kind, items: itemsOf(s, k.kind).filter(hit) }))
    .filter((g) => g.items.length > 0);
}

// the head of the text, so a row says what is written without opening it
const preview = (text: string): string => text.trim().split('\n').find((l) => l.trim() !== '')?.slice(0, 140) ?? 'nothing written';

/** A source with the island's or character's own card among its groups; anything else is left as it is. */
export function withCard(s: ResourceSource, f: FleetState): Source {
  const tier = s.tier;
  if (tier !== 'island' && tier !== 'character') return s;
  const e = tier === 'character' ? f.characters[s.characterIds[0]] : f.islands[s.islandIds[0]];
  if (!e) return s;
  const id = e.id;
  const charId = s.characterIds[0];
  // a row id names the entity it came off, so the row chosen on one island does not stand chosen on the next
  const field = (which: 'note' | 'instructions'): Group => {
    const ref: FieldRef = { tier, id, field: which };
    return { kind: which === 'note' ? 'note' : 'agentInstructions', items: [{ id: `card:${id}:${which}`, name: fieldLabel(ref), detail: preview(fieldValue(e, which)), card: ref }] };
  };
  const card: Group[] = [
    field('note'),
    field('instructions'),
    { kind: 'links', items: e.context.map((l, n) => ({ id: `card:${id}:link:${n}`, name: linkText(l), detail: l.ref, card: { link: l, charId } })) },
  ];
  // the list reads in the What column's order because visible() walks KINDS, so these only have to be here
  return { ...s, groups: [...s.groups, ...card.filter((g) => g.items.length > 0)] };
}

// the source the shelf stands on: the chosen one, else the first, read with its card among its groups;
// a tier chosen in the tree is no source, so the shelf stands on none
export const shelfSource = (s: { resources: ResourceSource[]; resourcesWhere?: string; fleet: FleetState }): Source | undefined => {
  const rootId = s.resourcesWhere ?? s.resources[0]?.rootId;
  const found = s.resources.find((r) => r.rootId === rootId);
  return found && withCard(found, s.fleet);
};

// a tier chosen in the tree stands as a Where of its own, spelt so no root id can be mistaken for it
const TIER_WHERE = 'tier:';
export const tierWhere = (tier: Tier): string => `${TIER_WHERE}${tier}`;
export const whereTier = (where: string | undefined): Tier | undefined =>
  where?.startsWith(TIER_WHERE) ? (where.slice(TIER_WHERE.length) as Tier) : undefined;

export const sourceOfRoot = (sources: ResourceSource[], root: string | undefined): ResourceSource | undefined =>
  root === undefined ? undefined : sources.find((s) => s.root === root);


// the ladder, broad to narrow; one is the label of a single source of the tier
const TIERS: { tier: Tier; label: string; one: string; glyph: string; colour: string }[] = [
  { tier: 'global', label: 'Global', one: 'Global', glyph: '◎', colour: '--ink-cool' },
  { tier: 'fleet', label: 'Fleet', one: 'Fleet', glyph: '◆', colour: '--pt-coral' },
  { tier: 'repo', label: 'Repos', one: 'Repo', glyph: '▣', colour: '--pt-sky' },
  { tier: 'island', label: 'Islands', one: 'Island', glyph: '▲', colour: '--pt-moss' },
  { tier: 'character', label: 'Characters', one: 'Character', glyph: '●', colour: '--pt-sun' },
];

export const tierOf = (tier: Tier) => TIERS.find((t) => t.tier === tier)!;

export const shortPath = (p: string): string => p.replace(/^\/Users\/[^/]+/, '~');
const plural = (n: number, one: string): string => (n === 0 ? `no ${one}s` : n === 1 ? `1 ${one}` : `${n} ${one}s`);

/** The second line of a source's row: what tells it from another of the same name. */
export function qualifierOf(s: ResourceSource, f: FleetState): string {
  if (s.tier === 'fleet') return 'this window only';
  if (s.tier === 'island') return plural(s.characterIds.length, 'character');
  if (s.tier === 'character') { const c = f.characters[s.characterIds[0]]; return c?.repo?.branch ?? shortPath(c?.cwd ?? s.root); }
  return s.tier === 'repo' && s.docs === s.rootId ? 'no characters here' : shortPath(s.root);
}

export type WhereGroup = { tier: Tier; count: number; sections: { id?: string; heading?: string; sources: ResourceSource[] }[] };

// island rows in the fleet's own island order, home last; a source whose island the fleet has not got follows the rest
const inIslandOrder = (sources: ResourceSource[], f: FleetState): ResourceSource[] => {
  const order = islandsSorted(f).map((i) => i.id);
  const rank = (s: ResourceSource) => { const k = order.indexOf(s.islandIds[0]); return k === -1 ? order.length : k; };
  return [...sources].sort((a, b) => rank(a) - rank(b));
};

/** The Where column: one group a tier, characters sub-grouped by island; a query narrows every group by name and qualifier. */
export function whereGroups(sources: ResourceSource[], f: FleetState, query: string): WhereGroup[] {
  const q = query.trim().toLowerCase();
  const hit = (s: ResourceSource) => !q || s.name.toLowerCase().includes(q) || qualifierOf(s, f).toLowerCase().includes(q);
  return TIERS.map(({ tier }) => {
    const mine = sources.filter((s) => s.tier === tier && hit(s));
    const sections = tier === 'character'
      ? islandsSorted(f).map((i) => ({ id: i.id, heading: i.name, sources: mine.filter((s) => s.islandIds[0] === i.id) })).filter((sec) => sec.sources.length)
      : mine.length ? [{ sources: tier === 'island' ? inIslandOrder(mine, f) : mine }] : [];
    return { tier, count: mine.length, sections };
  });
}

/** The What column: All, then every kind whether the source holds any or not, so the column keeps its length.
 *  The card's kinds are only for an island or a character; nothing else has one. */
export function kindRows(s: Source | undefined): { what: What; label: string; colour?: string; n: number; zero: boolean }[] {
  const row = (what: What, label: string, colour?: string) => { const n = countOf(s, what); return { what, label, colour, n, zero: n === 0 }; };
  return [row('all', 'All'), ...KINDS.filter((k) => offers(s?.tier, k.kind)).map((k) => row(k.kind, kindLabel(k.kind, s?.tier), k.colour))];
}

/** Whether a tier is offered a kind at all: only an island and a character have a card, and only the fleet has agent profiles. */
export const offers = (tier: Tier | undefined, kind: Kind): boolean =>
  kind === 'agentProfiles' ? tier === 'fleet' : !kindOf(kind).card || tier === 'island' || tier === 'character';

/** Whether a row's content rides in the prompt or is read when wanted; configuration is neither. */
export const badgeOf = (kind: Kind, item: Pick<Item, 'name'>): 'attached' | 'lookup' | undefined =>
  kind === 'instructions' || kind === 'agentInstructions' ? 'attached'
    : kind === 'autoMemory' ? (item.name === 'MEMORY.md' ? 'attached' : 'lookup')
    : kind === 'docs' || kind === 'skills' || kind === 'agents' || kind === 'commands' ? 'lookup' : undefined;

export type Chip = { tier: Tier; label: string; rootIds: string[] };
export type Chain = { heading: string; chips: Chip[] };

const chip = (s: Omit<ResourceSource, 'groups'>): Chip => ({ tier: s.tier, label: s.name, rootIds: [s.rootId] });

/** What an agent standing at `s` reads, broad to narrow. An island's repository slot carries its crew's spread; a source above the islands has no chain. */
export function chainOf(sources: ResourceSource[], f: FleetState, s: Omit<ResourceSource, 'groups'>): Chain | undefined {
  if (s.tier !== 'island' && s.tier !== 'character') return undefined;
  const globals = sources.filter((x) => x.tier === 'global');
  // a character reads the global source of the agent it runs; an island stands for crew that may differ
  const kind = s.tier === 'character' ? f.characters[s.characterIds[0]]?.agent?.kind : undefined;
  const global = globals.find((x) => x.name.toLowerCase() === kind) ?? globals[0];
  const ours = sources.find((x) => x.tier === 'fleet');
  const island = f.islands[s.islandIds[0]];
  const crew = Object.values(f.characters).filter((c) => (s.tier === 'character' ? c.id === s.characterIds[0] : c.islandId === island?.id));
  const roots = island?.kind === 'home' ? [] : [...new Set(crew.map((c) => c.repo?.mainRoot ?? c.cwd))];
  const repos = roots.map((r) => sources.find((x) => x.tier === 'repo' && x.root === r)).filter((x): x is ResourceSource => !!x)
    .sort((a, b) => a.name.localeCompare(b.name));
  const repo: Chip[] = repos.length === 0 ? [] : repos.length === 1 ? [chip(repos[0])] : [{ tier: 'repo', label: `${repos.length} repos`, rootIds: repos.map((r) => r.rootId) }];
  const islandSource = s.tier === 'island' ? s : sources.find((x) => x.tier === 'island' && x.islandIds[0] === island?.id);
  return {
    heading: s.tier === 'character' ? `${s.name} reads, in order` : 'a character here reads',
    chips: [...(global ? [chip(global)] : []), ...(ours ? [chip(ours)] : []), ...repo, ...(islandSource ? [chip(islandSource)] : []), ...(s.tier === 'character' ? [chip(s)] : [])],
  };
}

/** The filename the app writes for a typed name, without its extension; undefined when nothing usable is left. */
export function docSlug(typed: string): string | undefined {
  // NFKD splits a letter from its accent, so the accent alone is dropped and the letter survives as ascii
  const plain = typed.trim().toLowerCase().normalize('NFKD').replace(/\p{Diacritic}/gu, '');
  const slug = plain.replace(/\.md$/, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return slug || undefined;
}

/** A .md directly in a folder that takes docs or agent profiles; every other file the shelf opens keeps the plain editor. */
export const isDoc = (sources: ResourceSource[], rootId: string, path: string): boolean =>
  path.endsWith('.md') && !path.includes('/') && sources.some((s) => s.docs === rootId || s.agentProfiles === rootId);

/** Whether a folder is the agent profiles', whose files are written and named like docs. */
export const isAgentProfiles = (sources: ResourceSource[], rootId: string): boolean => sources.some((s) => s.agentProfiles === rootId);

/** An island's or a character's source and the docs in it. */
export function docsOf(sources: ResourceSource[], tier: 'island' | 'character', id: string): { source?: ResourceSource; items: ResourceItem[] } {
  const source = sources.find((s) => s.tier === tier && (tier === 'island' ? s.islandIds[0] : s.characterIds[0]) === id);
  return { source, items: source?.groups.find((g) => g.kind === 'docs')?.items ?? [] };
}
