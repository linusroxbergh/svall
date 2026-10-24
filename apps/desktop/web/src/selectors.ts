import { byCell, byIslandOrder, starredOf, type Robot, type ContextItem, type FleetState, type Island } from '@svall/protocol';
import { SINGLE, type Panes } from './panes.js';

export type DisplayStatus = 'working' | 'idle' | 'blocked' | 'done' | 'shell';

export const islandsSorted = (f: FleetState): Island[] => Object.values(f.islands).sort(byIslandOrder);

// the islands the map draws in the panned world; home is drawn in screen space, and a folded island not at all
export const mapIslands = (f: FleetState): Island[] => Object.values(f.islands).filter((i) => i.kind !== 'home' && !i.collapsed);

export const mapIslandsSorted = (f: FleetState): Island[] => mapIslands(f).sort(byIslandOrder);

export const homeIsland = (f: FleetState): Island | undefined => Object.values(f.islands).find((i) => i.kind === 'home');

// mission control's crew start with the home command, the main agent's unless fleet.json names another; anywhere
// else a new robot is a shell
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

// with no directory asked for, home crew start in the home cwd, others where their island's first robot
// started, and on an island with no crew in the fleet's default
export const islandCwd = (f: FleetState, islandId: string): string => {
  const first = robotsOf(f, islandId)[0];
  return f.islands[islandId]?.kind === 'home' ? f.home.cwd : first ? startCwd(first) : f.defaultCwd;
};

export const stripOrder = (f: FleetState): Robot[] => {
  let strip = strips.get(f);
  if (!strip) strips.set(f, (strip = islandsSorted(f).flatMap((i) => robotsOf(f, i.id))));
  return strip;
};

const islandOf = (f: FleetState, id: string | undefined): Island | undefined => (id ? f.islands[f.robots[id]?.islandId ?? ''] : undefined);

export const STARRED = 'sidebar.starred';

type SidebarRow = { c: Robot; starred: boolean };

// the robot rows the sidebar shows, top to bottom: the starred while their section is open, then each open island's crew
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

// why a handover could not resume a terminal that lies dormant, shown only while the fleet asks for handover
export const resumeErrorOf = (s: { shell?: { handoverEnabled?: boolean } }, slot: { tmux?: unknown; resumeError?: string } | undefined): string | undefined =>
  (s.shell?.handoverEnabled && slot && !slot.tmux ? slot.resumeError : undefined);

// one terminal's status: 1 is the main terminal, 2 the second
export const slotStatus = (c: Robot, term: 1 | 2): DisplayStatus => {
  const slot = term === 2 ? c.second : c;
  const s = slot?.agent?.status ?? 'shell';
  // with its window gone nothing runs and nothing waits on the user, whatever the agent last reported
  return slot && !slot.tmux && (s === 'working' || s === 'blocked') ? 'idle' : s;
};

// what the robot shows when its sessions differ: the one that needs the user soonest
const URGENCY: DisplayStatus[] = ['blocked', 'working', 'done', 'idle', 'shell'];

export const statusOf = (c: Robot): DisplayStatus => {
  const all = c.second ? [slotStatus(c, 1), slotStatus(c, 2)] : [slotStatus(c, 1)];
  return URGENCY.find((s) => all.includes(s)) ?? 'shell';
};

export const isUnread = (c: Robot): boolean => c.unread || !!c.second?.unread;

export { contextPctOf } from '@svall/protocol';

export const DISPLAY_STATUSES: DisplayStatus[] = ['working', 'idle', 'blocked', 'done', 'shell'];

// what needs the user first: blocked, then finished and unread, then the rest by how alive they are
const PRIORITY: DisplayStatus[] = ['blocked', 'done', 'working', 'idle', 'shell'];
const priorityOf = (c: Robot): number => {
  const s = statusOf(c);
  return s === 'done' && !isUnread(c) ? PRIORITY.indexOf('idle') + 0.5 : PRIORITY.indexOf(s);
};

export function robotsByPriority(f: FleetState): Robot[] {
  const order = stripOrder(f);
  return order.map((c, i) => ({ c, i })).sort((a, b) => priorityOf(a.c) - priorityOf(b.c) || a.i - b.i).map((x) => x.c);
}

// a robot wants the user when it is stuck, or when it has news nobody has read
export const wantsUser = (c: Robot): boolean => isUnread(c) || statusOf(c) === 'blocked';

// the PR the work is on: the branch's own, the one svalld reads a state for, else the first among the links
export const mainPr = (c: Robot): ContextItem | undefined =>
  c.context.find((it) => it.kind === 'pr' && it.prState) ?? c.context.find((it) => it.kind === 'pr');
export const inReview = (c: Robot): boolean => mainPr(c)?.prState === 'open';
export const isMonitoring = (c: Robot): boolean => Boolean(c.agent?.monitors?.length || c.second?.agent?.monitors?.length);
export const subagentCount = (c: Robot): number => (c.agent?.subagents?.length ?? 0) + (c.second?.agent?.subagents?.length ?? 0);

// the island wears the status of its most pressing robot
export function islandStatus(f: FleetState, islandId: string): DisplayStatus | undefined {
  const first = robotsOf(f, islandId).reduce<Robot | undefined>((top, c) => (top && priorityOf(top) <= priorityOf(c) ? top : c), undefined);
  return first ? statusOf(first) : undefined;
}

export function countsByStatus(f: FleetState): Record<DisplayStatus, number> {
  const out = { working: 0, idle: 0, blocked: 0, done: 0, shell: 0 };
  for (const c of Object.values(f.robots)) out[statusOf(c)] += 1;
  return out;
}

// the board always has a selection: the explicit one, else the remembered focus, else the first robot
export const selectedOf = (s: { fleet: FleetState; selectedId?: string; focusedId?: string }): string | undefined => {
  if (s.selectedId && s.fleet.robots[s.selectedId]) return s.selectedId;
  if (s.focusedId && s.fleet.robots[s.focusedId]) return s.focusedId;
  return stripOrder(s.fleet)[0]?.id;
};

export type BoardSelection = { fleet: FleetState; selectedId?: string; focusedId?: string; selectedIslandId?: string };

// the robot whose terminal the board shows: on a selected island its remembered focus or its first
// robot, nothing when the island is empty; otherwise the board's selection
export function boardViewed(s: BoardSelection): string | undefined {
  const island = s.selectedIslandId ? s.fleet.islands[s.selectedIslandId] : undefined;
  if (!island) return selectedOf(s);
  const focused = s.focusedId ? s.fleet.robots[s.focusedId] : undefined;
  return focused?.islandId === island.id ? focused.id : robotsOf(s.fleet, island.id)[0]?.id;
}

// the island the board's tab bar shows: the selected one, else the viewed robot's
export const boardIsland = (s: BoardSelection): Island | undefined =>
  (s.selectedIslandId && s.fleet.islands[s.selectedIslandId]) || islandOf(s.fleet, boardViewed(s));

export const panesOf = (s: { ide: Record<string, { panes: Panes }> }, id: string | undefined): Panes => (id && s.ide[id]?.panes) || SINGLE;

// the shell draws terminals and browser tabs above the page, so anything the page spreads over one
// only reads as on top once that surface is hidden. An overlay that covers a rect takes a cutout instead
export const isVeiled = (s: { namingRobot: boolean; missionPrompt: boolean; closingRobot?: string; sleepingRobot?: string; deletingIsland?: string; fleetPicker?: string; resourcesOpen: boolean; hostOpen: boolean; handoverOpen: boolean; fleet: FleetState }): boolean =>
  s.namingRobot || s.missionPrompt || s.closingRobot !== undefined || s.sleepingRobot !== undefined || s.deletingIsland !== undefined || s.fleetPicker !== undefined
  || s.resourcesOpen || s.hostOpen || s.handoverOpen || !!s.fleet.scribeAsk;

// the name a fleet's home directory gives it: ~/.svall (or ~/.svall-dev) is the private fleet, ~/.svall-work is work
export const directoryName = (home: string): string => {
  const base = home.replace(/\/+$/, '').split('/').pop() ?? '';
  return base === '.svall' || base === '.svall-dev' ? 'private' : base.replace(/^\.svall-(dev-)?/, '');
};
