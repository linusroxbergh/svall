import { byIslandOrder, type Character, type FleetState, type Island } from '@svall/protocol';
import { mapIslands } from './map/layout.js';
import { SINGLE, type Panes } from './panes.js';

export type DisplayStatus = 'working' | 'idle' | 'blocked' | 'done' | 'shell';

const byCell = (a: Character, b: Character) => a.cell.y - b.cell.y || a.cell.x - b.cell.x || a.id.localeCompare(b.id);

export const islandsSorted = (f: FleetState): Island[] => Object.values(f.islands).sort(byIslandOrder);

// the islands the map draws in the panned world, in the same order; home is drawn in screen space, and a folded island not at all
export const mapIslandsSorted = (f: FleetState): Island[] => mapIslands(f).sort(byIslandOrder);

export const homeIsland = (f: FleetState): Island | undefined => Object.values(f.islands).find((i) => i.kind === 'home');

// mission control's crew start with the home command, the main agent's unless config.json names another; anywhere
// else a new character is a shell
export const startOf = (f: FleetState, islandId: string): { command?: string } =>
  (f.islands[islandId]?.kind === 'home' ? { command: f.home.command } : {});

// a fleet object only changes with a patch, while every row's selector asks again on every store change
const crews = new WeakMap<FleetState, Map<string, Character[]>>();
const strips = new WeakMap<FleetState, Character[]>();

export const charactersOf = (f: FleetState, islandId: string): Character[] => {
  let byIsland = crews.get(f);
  if (!byIsland) crews.set(f, (byIsland = new Map()));
  let crew = byIsland.get(islandId);
  if (!crew) byIsland.set(islandId, (crew = Object.values(f.characters).filter((c) => c.islandId === islandId).sort(byCell)));
  return crew;
};

// where a new character starts when it takes another one's directory: the repo itself, never the worktree that one sits in
export const startCwd = (c: Character): string => (c.repo?.isWorktree ? c.repo.mainRoot : c.cwd);

// with no directory asked for, home crew start in the home cwd, others where their island's first character
// started, and on an island with no crew in the fleet's default
export const islandCwd = (f: FleetState, islandId: string): string => {
  const first = charactersOf(f, islandId)[0];
  return f.islands[islandId]?.kind === 'home' ? f.home.cwd : first ? startCwd(first) : f.defaultCwd;
};

export const stripOrder = (f: FleetState): Character[] => {
  let strip = strips.get(f);
  if (!strip) strips.set(f, (strip = islandsSorted(f).flatMap((i) => charactersOf(f, i.id))));
  return strip;
};

const islandOf = (f: FleetState, id: string | undefined): Island | undefined => (id ? f.islands[f.characters[id]?.islandId ?? ''] : undefined);

// the previous or next character across the whole fleet, in strip order, wrapping past collapsed islands
export function neighbor(f: FleetState, id: string | undefined, step: 1 | -1): Character | undefined {
  const all = stripOrder(f);
  const open = (c: Character) => !f.islands[c.islandId]?.collapsed;
  const i = all.findIndex((c) => c.id === id);
  if (i < 0) return all.find(open);
  const n = all.length;
  for (let k = 1; k <= n; k++) {
    const c = all[(((i + step * k) % n) + n) % n];
    if (open(c)) return c;
  }
  return undefined;
}

export function firstOfNextIsland(f: FleetState, id: string | undefined): Character | undefined {
  const islands = islandsSorted(f);
  const current = id ? f.characters[id]?.islandId : undefined;
  const i = islands.findIndex((x) => x.id === current);
  for (let k = 1; k <= islands.length; k++) {
    const island = islands[(i + k) % islands.length];
    const first = island.collapsed ? undefined : charactersOf(f, island.id)[0];
    if (first) return first;
  }
  return undefined;
}

// one terminal's status: 1 is the main terminal, 2 the second
export const slotStatus = (c: Character, term: 1 | 2): DisplayStatus => {
  if (term === 2) return c.second?.agent?.status ?? 'shell';
  const s = c.agent?.status ?? 'shell';
  // with its window gone nothing runs and nothing waits on the user, whatever the agent last reported
  return !c.tmux && (s === 'working' || s === 'blocked') ? 'idle' : s;
};

// what the character shows when its sessions differ: the one that needs the user soonest
const URGENCY: DisplayStatus[] = ['blocked', 'working', 'done', 'idle', 'shell'];

export const statusOf = (c: Character): DisplayStatus => {
  const all = c.second ? [slotStatus(c, 1), slotStatus(c, 2)] : [slotStatus(c, 1)];
  return URGENCY.find((s) => all.includes(s)) ?? 'shell';
};

export const isUnread = (c: Character): boolean => c.unread || !!c.second?.unread;

export { contextPctOf } from '@svall/protocol';

export const DISPLAY_STATUSES: DisplayStatus[] = ['working', 'idle', 'blocked', 'done', 'shell'];

// what needs the user first: blocked, then finished and unread, then the rest by how alive they are
const PRIORITY: DisplayStatus[] = ['blocked', 'done', 'working', 'idle', 'shell'];
const priorityOf = (c: Character): number => {
  const s = statusOf(c);
  return s === 'done' && !isUnread(c) ? PRIORITY.indexOf('idle') + 0.5 : PRIORITY.indexOf(s);
};

export function charactersByPriority(f: FleetState): Character[] {
  const order = stripOrder(f);
  return order.map((c, i) => ({ c, i })).sort((a, b) => priorityOf(a.c) - priorityOf(b.c) || a.i - b.i).map((x) => x.c);
}

// a character wants the user when it is stuck, or when it has news nobody has read
export const wantsUser = (c: Character): boolean => isUnread(c) || statusOf(c) === 'blocked';

// the island wears the status of its most pressing character
export function islandStatus(f: FleetState, islandId: string): DisplayStatus | undefined {
  const first = charactersByPriority(f).find((c) => c.islandId === islandId);
  return first ? statusOf(first) : undefined;
}

export function countsByStatus(f: FleetState): Record<DisplayStatus, number> {
  const out = { working: 0, idle: 0, blocked: 0, done: 0, shell: 0 };
  for (const c of Object.values(f.characters)) out[statusOf(c)] += 1;
  return out;
}

// the board always has a selection: the explicit one, else the remembered focus, else the first character
export const selectedOf = (s: { fleet: FleetState; selectedId?: string; focusedId?: string }): string | undefined => {
  if (s.selectedId && s.fleet.characters[s.selectedId]) return s.selectedId;
  if (s.focusedId && s.fleet.characters[s.focusedId]) return s.focusedId;
  return stripOrder(s.fleet)[0]?.id;
};

export type BoardSelection = { fleet: FleetState; selectedId?: string; focusedId?: string; selectedIslandId?: string };

// the character whose terminal the board shows: on a selected island its remembered focus or its first
// character, nothing when the island is empty; otherwise the board's selection
export function boardViewed(s: BoardSelection): string | undefined {
  const island = s.selectedIslandId ? s.fleet.islands[s.selectedIslandId] : undefined;
  if (!island) return selectedOf(s);
  const focused = s.focusedId ? s.fleet.characters[s.focusedId] : undefined;
  return focused?.islandId === island.id ? focused.id : charactersOf(s.fleet, island.id)[0]?.id;
}

// the island the board's tab bar shows: the selected one, else the viewed character's
export const boardIsland = (s: BoardSelection): Island | undefined =>
  (s.selectedIslandId && s.fleet.islands[s.selectedIslandId]) || islandOf(s.fleet, boardViewed(s));

export const panesOf = (s: { ide: Record<string, { panes: Panes }> }, id: string | undefined): Panes => (id && s.ide[id]?.panes) || SINGLE;

// the shell draws terminals and browser tabs above the page, so anything the page spreads over one
// only reads as on top once that surface is hidden. An overlay that covers a rect takes a cutout instead
export const isVeiled = (s: { namingCharacter: boolean; missionPrompt: boolean; closingCharacter?: string; deletingIsland?: string; fleetPicker?: string; keysOpen: boolean; resourcesOpen: boolean; fleet: FleetState }): boolean =>
  s.namingCharacter || s.missionPrompt || s.closingCharacter !== undefined || s.deletingIsland !== undefined || s.fleetPicker !== undefined
  || s.keysOpen || s.resourcesOpen || !!s.fleet.scribeAsk;

// the name a fleet's home directory gives it: ~/.svall (or ~/.svall-dev) is the private fleet, ~/.svall-work is work
export const directoryName = (home: string): string => {
  const base = home.replace(/\/+$/, '').split('/').pop() ?? '';
  return base === '.svall' || base === '.svall-dev' ? 'private' : base.replace(/^\.svall-(dev-)?/, '');
};
