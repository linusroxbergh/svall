import { byCell, byIslandOrder, columnOf, placingOn, starredOf, type AgentKind, type Column, type Robot, type ContextItem, type FleetState, type Island } from '@svall/protocol';
import { SINGLE, type Panes } from './panes.js';
import { unreachableOf } from './placement.js';
import type { View } from './store/ui.js';

export type DisplayStatus = 'working' | 'idle' | 'blocked' | 'done' | 'shell' | 'moving' | 'unknown';

// a stable identity, so a selector defaulting to "no CLIs found" does not retrigger on every render
export const NO_AGENTS: AgentKind[] = [];

export const islandsSorted = (f: Pick<FleetState, 'islands'>): Island[] => Object.values(f.islands).sort(byIslandOrder);

// the islands the map draws in the panned world; home is drawn in screen space, and a folded island not at all
export const mapIslands = (f: FleetState): Island[] => Object.values(f.islands).filter((i) => i.kind !== 'home' && !i.collapsed);

export const mapIslandsSorted = (f: FleetState): Island[] => mapIslands(f).sort(byIslandOrder);

export const homeIsland = (f: FleetState): Island | undefined => Object.values(f.islands).find((i) => i.kind === 'home');

// mission control's crew start with the home command; anywhere else a new robot is a shell
export const startOf = (f: FleetState, islandId: string): { command?: string } =>
  (f.islands[islandId]?.kind === 'home' ? { command: f.home.command } : {});

// a fleet object is replaced only by a patch or a snapshot, while every row's selector asks again on every store change
const crews = new WeakMap<FleetState, Map<string, Robot[]>>();
const strips = new WeakMap<FleetState, Robot[]>();

export const robotsOf = (f: FleetState, islandId: string): Robot[] => {
  let byIsland = crews.get(f);
  if (!byIsland) crews.set(f, (byIsland = new Map()));
  let crew = byIsland.get(islandId);
  if (!crew) byIsland.set(islandId, (crew = Object.values(f.robots).filter((c) => c.islandId === islandId).sort(byCell)));
  return crew;
};

// where a new robot starts when it takes another one's directory: the repo itself, never the worktree that one sits in
export const startCwd = (c: Robot): string => (c.repo?.isWorktree ? c.repo.mainRoot : c.cwd);

export const islandCwd = (f: FleetState, islandId: string): string => {
  const first = robotsOf(f, islandId)[0];
  return f.islands[islandId]?.kind === 'home' ? f.home.cwd : first ? startCwd(first) : f.defaultCwd;
};

export const stripOrder = (f: FleetState): Robot[] => {
  let strip = strips.get(f);
  if (!strip) strips.set(f, (strip = islandsSorted(f).flatMap((i) => robotsOf(f, i.id))));
  return strip;
};

export const STARRED = 'sidebar.starred';

type SidebarRow = { c: Robot; starred: boolean };

const sidebarRows = (f: FleetState, starsOpen: boolean): SidebarRow[] => [
  ...(starsOpen ? starredOf(f).map((c) => ({ c, starred: true })) : []),
  ...islandsSorted(f).filter((i) => !i.collapsed).flatMap((i) => robotsOf(f, i.id).map((c) => ({ c, starred: false }))),
];

// the row before or after the selection's, wrapping around; a starred robot has a row in Starred and one on its island,
// `onStar` says which it is on, and the walk passes its other one
export function neighbor(f: FleetState, id: string | undefined, step: 1 | -1, starsOpen = false, onStar = false): SidebarRow | undefined {
  const rows = sidebarRows(f, starsOpen);
  const own = rows.findIndex((r) => r.c.id === id && r.starred === onStar);
  const i = own >= 0 ? own : rows.findIndex((r) => r.c.id === id);
  if (i < 0) return rows[0];
  const n = rows.length;
  for (let k = 1; k < n; k++) {
    const r = rows[(((i + step * k) % n) + n) % n];
    if (r.c.id !== id) return r;
  }
  return undefined;
}

export function firstOfNextIsland(f: FleetState, id: string | undefined): Robot | undefined {
  const islands = islandsSorted(f);
  const current = id ? f.robots[id]?.islandId : undefined;
  const i = islands.findIndex((x) => x.id === current);
  for (let k = 1; k <= islands.length; k++) {
    const island = islands[(i + k) % islands.length];
    const first = island.collapsed ? undefined : robotsOf(f, island.id)[0];
    if (first) return first;
  }
  return undefined;
}

// why a terminal that lies dormant could not resume
export const resumeErrorOf = (slot: { tmux?: unknown; resumeError?: string } | undefined): string | undefined =>
  slot && !slot.tmux ? slot.resumeError : undefined;

// one terminal's status: 1 is the main terminal, 2 the second
export const slotStatus = (c: Robot, term: 1 | 2): DisplayStatus => {
  const slot = term === 2 ? c.second : c;
  const s = slot?.agent?.status ?? 'shell';
  // with its window gone nothing runs and nothing waits on the user, whatever the agent last reported
  return slot && !slot.tmux && (s === 'working' || s === 'blocked') ? 'idle' : s;
};

// what the robot shows when its sessions differ: the one that needs the user soonest
const URGENCY: DisplayStatus[] = ['blocked', 'working', 'done', 'idle', 'shell'];

// a robot between machines is moving; given the fleet's machines, one on a worker out of reach is unknown
export const statusOf = (c: Robot, f?: Pick<FleetState, 'machines'>): DisplayStatus => {
  if (c.moving) return 'moving';
  if (f && unreachableOf(f, c)) return 'unknown';
  const all = c.second ? [slotStatus(c, 1), slotStatus(c, 2)] : [slotStatus(c, 1)];
  return URGENCY.find((s) => all.includes(s)) ?? 'shell';
};

export const isUnread = (c: Robot): boolean => c.unread || !!c.second?.unread;

export { contextPctOf } from '@svall/protocol';

export const DISPLAY_STATUSES: DisplayStatus[] = ['working', 'idle', 'blocked', 'done', 'shell'];

// what needs the user first: blocked, then finished and unread, then the rest by how alive they are
const PRIORITY: DisplayStatus[] = ['blocked', 'done', 'working', 'moving', 'idle', 'unknown', 'shell'];
const priorityOf = (c: Robot, f: FleetState): number => {
  const s = statusOf(c, f);
  return s === 'done' && !isUnread(c) ? PRIORITY.indexOf('idle') + 0.5 : PRIORITY.indexOf(s);
};

export function robotsByPriority(f: FleetState): Robot[] {
  const order = stripOrder(f);
  return order.map((c, i) => ({ c, i })).sort((a, b) => priorityOf(a.c, f) - priorityOf(b.c, f) || a.i - b.i).map((x) => x.c);
}

export const wantsUser = (c: Robot, f: Pick<FleetState, 'machines'>): boolean => isUnread(c) || statusOf(c, f) === 'blocked';

// the PR the work is on: the branch's own, the one svalld reads a state for, else the first among the links
export const mainPr = (c: Robot): ContextItem | undefined =>
  c.context.find((it) => it.kind === 'pr' && it.prState) ?? c.context.find((it) => it.kind === 'pr');
export const inReview = (c: Robot): boolean => mainPr(c)?.prState === 'open';
export const isMonitoring = (c: Robot): boolean => Boolean(c.agent?.monitors?.length || c.second?.agent?.monitors?.length);
export const subagentCount = (c: Robot): number => (c.agent?.subagents?.length ?? 0) + (c.second?.agent?.subagents?.length ?? 0);

// the island wears the status of its most pressing robot
export function islandStatus(f: FleetState, islandId: string): DisplayStatus | undefined {
  const first = robotsOf(f, islandId).reduce<Robot | undefined>((top, c) => (top && priorityOf(top, f) <= priorityOf(c, f) ? top : c), undefined);
  return first ? statusOf(first, f) : undefined;
}

export function countsByStatus(f: FleetState): Record<DisplayStatus, number> {
  const out = { working: 0, idle: 0, blocked: 0, done: 0, shell: 0, moving: 0, unknown: 0 };
  for (const c of Object.values(f.robots)) out[statusOf(c, f)] += 1;
  return out;
}

export const selectedOf = (s: { fleet: FleetState; selectedId?: string; focusedId?: string }): string | undefined => {
  if (s.selectedId && s.fleet.robots[s.selectedId]) return s.selectedId;
  if (s.focusedId && s.fleet.robots[s.focusedId]) return s.focusedId;
  return stripOrder(s.fleet)[0]?.id;
};

export type BoardColumn = { column: Column; robots: Robot[] };

// the board's columns left to right, each holding the robots `shown` keeps in the sidebar's order, except that one
// with an arrival number goes to the top, the highest first
export function boardColumns(f: FleetState, shown: (c: Robot) => boolean, arrived: ReadonlyMap<string, number>): BoardColumn[] {
  const cols = f.columns.map((column) => ({ column, robots: [] as Robot[] }));
  const byId = new Map(cols.map((k) => [k.column.id, k]));
  for (const c of stripOrder(f)) if (shown(c)) byId.get(columnOf(f, c).id)!.robots.push(c);
  for (const k of cols) k.robots.sort((a, b) => (arrived.get(b.id) ?? 0) - (arrived.get(a.id) ?? 0));
  return cols;
}

export const placesOf = (f: FleetState): Map<string, string> => new Map(Object.values(f.robots).map((c) => [c.id, columnOf(f, c).id]));

export const panesOf = (s: { ide: Record<string, { panes: Panes }> }, id: string | undefined): Panes => (id && s.ide[id]?.panes) || SINGLE;

// the board asks about the scribe's placing once the scribe's own ask is answered
export const placingAsking = (s: { view?: View; fleet: FleetState; fleetPicker?: string }): boolean =>
  s.view === 'board' && !!s.fleet.placingAsk && !s.fleet.scribeAsk && !s.fleetPicker;

// placing rides the scribe's passes, so with the scribe off nothing places robots
export const scribePlaces = (f: FleetState): boolean => placingOn(f) && !f.scribeOff && !f.scribeAsk;

// the shell draws terminals and browser tabs above the page, so anything the page spreads over one
// only reads as on top once that surface is hidden. An overlay that covers a rect takes a cutout instead
export const isVeiled = (s: { view?: View; namingRobot: boolean; missionPrompt: boolean; palette: boolean; closingRobot?: string; sleepingRobot?: string; deletingIsland?: string; deletingColumn?: string; fleetPicker?: string; moveSheet?: unknown; resourcesOpen: boolean; hostOpen: boolean; fleet: FleetState }): boolean =>
  s.namingRobot || s.missionPrompt || s.palette || s.closingRobot !== undefined || s.sleepingRobot !== undefined || s.deletingIsland !== undefined || s.deletingColumn !== undefined || s.fleetPicker !== undefined
  || s.moveSheet !== undefined || s.resourcesOpen || s.hostOpen || !!s.fleet.scribeAsk || placingAsking(s);

// the name a fleet's home directory gives it: ~/.svall (or ~/.svall-dev) is the private fleet, ~/.svall-work is work
export const directoryName = (home: string): string => {
  const base = home.replace(/\/+$/, '').split('/').pop() ?? '';
  return base === '.svall' || base === '.svall-dev' ? 'private' : base.replace(/^\.svall-(dev-)?/, '');
};
