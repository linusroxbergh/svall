import { AgentKind, contextKind, DEFAULT_SIZE, HOME_ISLAND, keptSession, type Cell, type Column, type ContextItem, type HomeAction, type Params, type Result, type Size } from '@svall/protocol';
import { ApiError, type Api } from './api.js';
import { shim, type Bridge } from './bridge.js';
import type { DropTarget } from './drop.js';
import { withoutSecond } from './panes.js';
import type { FieldRef } from './resources/model.js';
import { robotsOf, islandCwd, islandsSorted, mapIslandsSorted, panesOf, selectedOf, startCwd, startOf } from './selectors.js';
import type { AppStore } from './store/index.js';

// what it takes to act on the fleet: the socket, the mirror, and the shell
export type Deps = { api: Api; store: AppStore; bridge: Bridge };
// the fleet calls need the socket and the mirror; only the keyboard also needs the shell
type ActionDeps = Pick<Deps, 'api' | 'store'>;

const toast = (d: ActionDeps) => (e: Error) => d.store.getState().showToast(e.message);

// making an island or robot puts the settings window away, so what was made is in sight
const closeSettings = (d: ActionDeps): void => { if (d.store.getState().settingsOpen) d.store.getState().toggleSettings(false); };

// a cwd taken from another robot can be gone (a removed worktree), so one the fleet refuses as not a
// directory gives way once to the fleet's default; an agent's start command only runs where it was meant to
export async function createRobot(api: Pick<Api, 'call'>, params: Params<'robot.create'>, fallback: string): Promise<Result<'robot.create'>> {
  try {
    return await api.call('robot.create', params);
  } catch (e) {
    if (params.cwd === fallback || params.command || !/not a directory/.test((e as Error).message)) throw e;
    return api.call('robot.create', { ...params, cwd: fallback });
  }
}

// a new robot opens its side card, whatever the side card was left at, and its terminal unless it is only selected
export const showCreated = (d: ActionDeps, id: string, how: 'focus' | 'select' = 'focus'): void => {
  const s = d.store.getState();
  if (how === 'focus') s.focus(id); else s.select(id);
  s.toggleSideCard(true);
};

// a crew member whose CLI svalld doesn't find only prints command not found; the toast says why, and a
// login shell that finds it still gets its chance
function warnUnfound(d: ActionDeps, command: string): boolean {
  const cli = command.trim().split(/\s+/)[0];
  const found = d.store.getState().fleet.agentsFound;
  const unfound = AgentKind.safeParse(cli).success && found !== undefined && !found.includes(cli as AgentKind);
  if (unfound) d.store.getState().showToast(`Mission control runs ${cli}, which svalld doesn't find. Install it, then run ${shim()} setup.`);
  return unfound;
}

// the new robot's id, or nothing when the fleet refused, the reason already on a toast
export async function newRobotOn(d: ActionDeps, islandId: string): Promise<string | undefined> {
  closeSettings(d);
  const f = d.store.getState().fleet;
  const dir = islandCwd(f, islandId);
  const start = startOf(f, islandId);
  if (start.command) warnUnfound(d, start.command);
  try {
    const c = await createRobot(d.api, { islandId, cwd: dir, ...start }, f.defaultCwd);
    showCreated(d, c.id);
    return c.id;
  } catch (e) {
    d.store.getState().showToast((e as Error).message);
    return undefined;
  }
}

// A robot row inserts before or after it, even across islands; an island row appends to its crew.
export function moveRobotTo(d: ActionDeps, id: string, target: DropTarget, after = false): void {
  const f = d.store.getState().fleet;
  const other = target.kind === 'robot' ? f.robots[target.id] : undefined;
  if (target.kind === 'robot' && (!other || other.id === id)) return;
  if (other) {
    d.api.call('robot.reorder', { id, targetId: other.id, after }).catch(toast(d));
    return;
  }
  d.api.call('robot.move', { id, islandId: target.id }).catch(toast(d));
}

// a hand move on the board: the robot stays in the column until it is let go, and its agent is told nothing
export function placeRobot(d: ActionDeps, id: string, columnId: string): Promise<unknown> {
  return d.api.call('robot.place', { id, columnId }).catch(toast(d));
}

export function releaseRobot(d: ActionDeps, id: string): void {
  d.api.call('robot.release', { id }).catch(toast(d));
}

// the first of New column, New column 2, … that no column is called yet, in any case
const freeColumnName = (cols: Column[]): string => {
  const taken = new Set(cols.map((k) => k.name.toLowerCase()));
  for (let n = 1; ; n++) {
    const name = n === 1 ? 'New column' : `New column ${n}`;
    if (!taken.has(name.toLowerCase())) return name;
  }
};

// the new column's id; it goes last
export async function addColumn(d: ActionDeps): Promise<string | undefined> {
  const name = freeColumnName(d.store.getState().fleet.columns);
  try {
    const cols = await d.api.call('column.add', { name });
    return cols.find((k) => k.name === name)?.id;
  } catch (e) {
    d.store.getState().showToast((e as Error).message);
    return undefined;
  }
}

export function renameColumn(d: ActionDeps, id: string, name: string): void {
  d.api.call('column.rename', { id, name }).catch(toast(d));
}

export function reorderColumn(d: ActionDeps, id: string, targetId: string, after: boolean): void {
  if (id !== targetId) d.api.call('column.reorder', { id, targetId, after }).catch(toast(d));
}

export function deleteColumn(d: ActionDeps, id: string, moveTo: string): void {
  d.api.call('column.delete', { id, moveTo }).catch(toast(d));
}

// an empty column goes at once, and the toast offers it back where it stood
export async function deleteEmptyColumn(d: ActionDeps, id: string): Promise<void> {
  const cols = d.store.getState().fleet.columns;
  const at = cols.findIndex((k) => k.id === id);
  if (at < 0 || cols.length < 2) return;
  const { name } = cols[at];
  const before = cols[at - 1]?.id;
  try {
    await d.api.call('column.delete', { id, moveTo: cols[at === 0 ? 1 : at - 1].id });
  } catch (e) {
    d.store.getState().showToast((e as Error).message);
    return;
  }
  const undo = async () => {
    try {
      const back = await d.api.call('column.add', { name, ...(before ? { afterId: before } : {}) });
      const made = back.find((k) => k.name === name);
      // a column added without afterId goes last, so the first comes back by a reorder
      if (!before && made && back[0].id !== made.id) await d.api.call('column.reorder', { id: made.id, targetId: back[0].id, after: false });
    } catch (e) {
      d.store.getState().showToast((e as Error).message);
    }
  };
  d.store.getState().showToast(`Deleted “${name}”`, 'ok', { label: 'Undo', run: () => void undo() });
}

// asking for the state a robot already has sends nothing; robot.star would move a starred one first
export function setStar(d: ActionDeps, id: string, on: boolean): void {
  const c = d.store.getState().fleet.robots[id];
  if (!c || on === (c.star !== undefined)) return;
  (on ? d.api.call('robot.star', { id }) : d.api.call('robot.unstar', { id })).catch(toast(d));
}

// without a target the robot goes first among the starred
export function starRobotAt(d: ActionDeps, id: string, targetId?: string, after?: boolean): void {
  if (id !== targetId) d.api.call('robot.star', { id, targetId, after }).catch(toast(d));
}

// dropped on a free cell a robot keeps that spot; without one the fleet stands it in the first free one
export const moveRobotToCell = (d: ActionDeps, id: string, islandId: string, cell?: Cell): void => {
  d.api.call('robot.move', { id, islandId, cell }).catch(toast(d));
};

// the island is centred on the drop cell; the fleet stands the robot in from its coast
export function newIslandAround(d: ActionDeps, id: string, cell: Cell): void {
  const c = d.store.getState().fleet.robots[id];
  if (!c) return;
  closeSettings(d);
  const size = DEFAULT_SIZE;
  const position = { x: cell.x - Math.floor(size.w / 2), y: cell.y - Math.floor(size.h / 2) };
  d.api.call('island.create', { name: islandName(c.cwd), position, size })
    .then((island) => d.api.call('robot.move', { id, islandId: island.id }))
    .catch(toast(d));
}

// the map holds the island where the drag left it until the fleet answers, so a refusal hands the
// caller its own undo before the toast
export const moveIsland = (d: ActionDeps, id: string, position: Cell, onRefused?: () => void): void => {
  d.api.call('island.update', { id, position }).catch((e: Error) => { onRefused?.(); toast(d)(e); });
};

export const resizeIsland = (d: ActionDeps, id: string, size: Size, onRefused?: () => void): void => {
  d.api.call('island.update', { id, size }).catch((e: Error) => { onRefused?.(); toast(d)(e); });
};

export function reorderIsland(d: ActionDeps, id: string, targetId: string, after: boolean): void {
  if (id !== targetId) d.api.call('island.reorder', { id, targetId, after }).catch(toast(d));
}

// folding is the island's own state, so the map and the sidebar read the same flag on every client
export function toggleIsland(d: ActionDeps, id: string): void {
  const island = d.store.getState().fleet.islands[id];
  if (!island) return;
  d.api.call('island.update', { id, collapsed: !island.collapsed }).catch(toast(d));
}

// the daemon lays the whole fleet out at once; the map refits to whatever comes back
export function arrangeIslands(d: ActionDeps, aspect?: number, homeRoom?: number): void {
  d.api.call('island.arrange', { aspect, homeRoom }).catch(toast(d));
}

// an island made on the map centres on the cell that asked for it; made from a button it has no cell,
// and the daemon picks the spot
export function newIsland(d: ActionDeps, cell?: Cell): void {
  closeSettings(d);
  const n = Object.values(d.store.getState().fleet.islands).filter((i) => i.kind !== 'home').length + 1;
  const position = cell && { x: cell.x - Math.floor(DEFAULT_SIZE.w / 2), y: cell.y - Math.floor(DEFAULT_SIZE.h / 2) };
  d.api.call('island.create', { name: `Island ${n}`, ...(position ? { position } : {}) })
    .then((i) => d.store.getState().selectIsland(i.id))
    .catch(toast(d));
}

const islandName = (cwd: string): string => (cwd === '~' ? 'island' : cwd.split('/').filter(Boolean).pop() ?? 'island');

// the selected island, else the current robot's island, else the first shown one, else the first hidden one,
// which comes back with the robot, else a fresh island
export async function newRobotTarget(d: ActionDeps): Promise<{ islandId: string; cwd: string }> {
  const s = d.store.getState();
  const current = s.selectedId ?? s.card ?? selectedOf(s);
  const islandSel = s.selectedIslandId;
  const base = islandSel ? robotsOf(s.fleet, islandSel)[0] : current ? s.fleet.robots[current] : undefined;
  const start = base ? startCwd(base) : s.fleet.defaultCwd;
  const islandId = islandSel || base?.islandId || mapIslandsSorted(s.fleet)[0]?.id
    || islandsSorted(s.fleet).find((i) => i.kind !== 'home')?.id
    || (await d.api.call('island.create', { name: islandName(start) })).id;
  const cwd = s.fleet.islands[islandId]?.kind === 'home' ? s.fleet.home.cwd : start;
  return { islandId, cwd };
}

// a named robot wherever the map last was, with its note and links written on once it exists;
// it is the caller that reports a refusal, so the dialog can stay open on one
export async function newNamedRobot(d: ActionDeps, p: { name: string; note: string; refs: string[] }): Promise<string> {
  closeSettings(d);
  const { islandId, cwd } = await newRobotTarget(d);
  const f = d.store.getState().fleet;
  const start = startOf(f, islandId);
  if (start.command) warnUnfound(d, start.command);
  const c = await createRobot(d.api, { islandId, cwd, ...(p.name ? { name: p.name } : {}), ...start }, f.defaultCwd);
  if (p.note || p.refs.length) {
    // the robot already exists, so a refused path is reported rather than retried
    await d.api.call('robot.update', {
      id: c.id,
      ...(p.note ? { note: p.note } : {}),
      ...(p.refs.length ? { context: p.refs.map((ref) => ({ kind: contextKind(ref), ref, label: '', source: 'manual' as const })) } : {}),
    }).catch(toast(d));
  }
  return c.id;
}

// the fleet answers a start only once the agent has booted, seconds later; the crew member stands on
// mission control long before that, so it is selected from the mirror. A selection made meanwhile is
// the user's, not ours: `before` is the one to yield to
function selectOnArrival(d: ActionDeps, before: string | undefined): () => void {
  const known = new Set(Object.keys(d.store.getState().fleet.robots));
  const stop = d.store.subscribe((s) => {
    const fresh = Object.values(s.fleet.robots).find((c) => c.islandId === HOME_ISLAND && !known.has(c.id));
    if (!fresh) return;
    stop();
    if (d.store.getState().selectedId === before) showCreated(d, fresh.id, 'select');
  });
  return stop;
}

// a fresh crew member in the home cwd, started with the home command and handed the prompt;
// without a label the daemon names it. false when the fleet refused, the reason already on a toast
export async function startHomeRobot(d: ActionDeps, p: { prompt: string; label?: string }): Promise<boolean> {
  closeSettings(d);
  const { home } = d.store.getState().fleet;
  const before = d.store.getState().selectedId;
  const stop = selectOnArrival(d, before);
  const unfound = warnUnfound(d, home.command);
  try {
    const c = await d.api.call('robot.create', { islandId: HOME_ISLAND, cwd: home.cwd, ...(p.label ? { name: p.label } : {}), command: home.command, run: p.prompt });
    // a crew member the mirror already has was chosen for, or yielded, on arrival
    const s = d.store.getState();
    if (s.selectedId === before && !s.fleet.robots[c.id]) showCreated(d, c.id, 'select');
    // an agent that never reported in was booting slowly or is waiting on a question of its own; either
    // way the crew member is there and the prompt is still the user's to send, so it is not thrown away
    if (!unfound) {
      if (c.runSent === false) {
        d.store.getState().showToast(`${c.name} started, prompt not sent`, 'ok',
          { label: 'Send it', run: () => { d.api.call('robot.run', { id: c.id, text: p.prompt, enter: true }).catch(toast(d)); } });
      } else {
        d.store.getState().showToast(`${c.name} started`, 'ok');
      }
    }
    return true;
  } catch (e) {
    d.store.getState().showToast((e as Error).message);
    return false;
  } finally {
    stop();
  }
}

// a button names its skill as a slash command, Claude's form; codex takes the same skill as $name
export const skillPrompt = (command: string, prompt: string): string =>
  (/^codex(\s|$)/.test(command.trim()) ? prompt.replace(/^\/(?=[\w-]+(\s|$))/, '$') : prompt);

// a button on the home island carries its own label and prompt
export const startHomeAction = async (d: ActionDeps, action: HomeAction): Promise<void> => {
  await startHomeRobot(d, { prompt: skillPrompt(d.store.getState().fleet.home.command, action.prompt), label: action.label });
};

// an edit that never reached the fleet may have left with its field, so the toast keeps it to send again
const unsent = (d: ActionDeps, retry: () => void) => (e: Error) =>
  d.store.getState().showToast(e.message, 'error', e instanceof ApiError ? undefined : { label: 'Retry', run: retry });

export const saveRobot = (d: ActionDeps, id: string, patch: Omit<Params<'robot.update'>, 'id'>): void => {
  d.api.call('robot.update', { id, ...patch }).catch(unsent(d, () => saveRobot(d, id, patch)));
};

// a context write carries the whole list, so a failed one is only reported: sent again later it could drop items added meanwhile
export const saveRobotContext = (d: ActionDeps, id: string, context: ContextItem[]): void => {
  d.api.call('robot.update', { id, context }).catch(toast(d));
};

export const reviveRobot = (d: ActionDeps, id: string): Promise<boolean> =>
  d.api.call('robot.revive', { id }).then(() => true, (e: Error) => { toast(d)(e); return false; });

// a new session in the terminal's folder, told what the session that could not resume held
export const startFresh = (d: ActionDeps, id: string, second?: boolean): Promise<void> => {
  const c = d.store.getState().fleet.robots[id];
  const old = (second ? c?.second : c)?.agent;
  return d.api.call('robot.fresh', { id, ...(second && { term: 2 as const }) })
    .then(() => { if (c && old) d.store.getState().showToast(`${c.name} started fresh; ${keptSession(old)}`, 'ok'); }, toast(d));
};

// the pane waits on the terminal it asked for, so a refusal closes that pane again and says why
export const openSecondTerminal = (d: ActionDeps, id: string): void => {
  d.api.call('robot.second', { id }).catch((e: Error) => {
    const s = d.store.getState();
    const c = s.fleet.robots[id];
    if (c && !c.second) s.setPanes(id, withoutSecond(panesOf(s, id)));
    toast(d)(e);
  });
};

export const saveIsland = (d: ActionDeps, id: string, patch: Omit<Params<'island.update'>, 'id'>): void => {
  d.api.call('island.update', { id, ...patch }).catch(unsent(d, () => saveIsland(d, id, patch)));
};

export const saveIslandContext = (d: ActionDeps, id: string, context: ContextItem[]): void => {
  d.api.call('island.update', { id, context }).catch(toast(d));
};

// the island goes and the card that showed it goes with it; a refused delete leaves both
export const deleteIsland = (d: ActionDeps, id: string): void => {
  d.api.call('island.delete', { id }).catch(toast(d));
};

// everything the robot started ends; opening it again resumes its session, and one svalld cannot resume is refused
export const sleepRobot = (d: ActionDeps, id: string): Promise<void> =>
  d.api.call('robot.sleep', { id }).then(() => {}, toast(d));

// an island's or a robot's own field, written straight back to the fleet
export const saveEntityField = (d: ActionDeps, r: FieldRef, value: string): void => {
  if (r.tier === 'robot') saveRobot(d, r.id, r.field === 'note' ? { note: value } : { instructions: value });
  else saveIsland(d, r.id, r.field === 'note' ? { description: value } : { instructions: value });
};

export const activateBrowserTab = (d: ActionDeps, id: string, tab: string): void => { d.api.fire('browser.activate', { id, tab }); };

export const closeBrowserTab = (d: ActionDeps, id: string, tab: string): void => { d.api.fire('browser.close', { id, tab }); };

export const setScribe = (d: ActionDeps, enabled: boolean): void => {
  d.api.call('scribe.set', { enabled }).catch(toast(d));
};

// placing rides the scribe's passes, so turning it on turns on a scribe that is off
export const setPlacing = (d: ActionDeps, enabled: boolean): void => {
  const f = d.store.getState().fleet;
  if (enabled && (f.scribeOff || f.scribeAsk)) setScribe(d, true);
  d.api.call('placing.set', { enabled }).catch(toast(d));
};

// one scribe pass that only moves robots to the columns their work is at, Auto-place on or off
export async function placeNow(d: ActionDeps): Promise<void> {
  d.store.getState().showToast('Placing robots…', 'ok');
  try {
    const { lines } = await d.api.call('scribe.sweep', { columns: true });
    const moved = lines.filter((l) => l.includes('  column: ')).length;
    const failed = lines.filter((l) => l.includes('  failed: ')).length;
    const text = moved ? `Moved ${moved} robot${moved === 1 ? '' : 's'}` : 'Every robot is in its column';
    d.store.getState().showToast(failed ? `${text}; the scribe failed on ${failed}` : text, failed ? 'error' : 'ok');
  } catch (e) {
    toast(d)(e as Error);
  }
}

export const setWorktrees = (d: ActionDeps, enabled: boolean): void => {
  d.api.call('worktrees.set', { enabled }).catch(toast(d));
};

export const setMainAgent = (d: ActionDeps, agent: AgentKind): void => {
  d.api.call('mainAgent.set', { agent }).catch(toast(d));
};

export const setModel = (d: ActionDeps, of: 'scribe' | 'home', agent: AgentKind, model: string | undefined): void => {
  d.api.call('model.set', { of, agent, model }).catch(toast(d));
};

// only the label changes, and the window title with it; a refusal is the caller's to show
export const renameFleet = async (d: Pick<Deps, 'api' | 'bridge'>, name: string): Promise<void> => {
  await d.api.call('fleet.rename', { name });
  d.bridge.send({ type: 'retitle' });
};

export const setDormancy = (d: ActionDeps, hours: number): void => {
  d.api.call('dormancy.set', { hours }).catch(toast(d));
};

// the daemon holds the only answer, and `svall mobile` can change it while the app is open
export const loadMobileStatus = (d: ActionDeps): void => {
  d.api.call('mobile.get', {}).then((m) => d.store.getState().setMobile(m)).catch(() => {});
};

// a link that cannot be made comes back as a status carrying the reason, not as a rejection
export const serveFleet = (d: ActionDeps, enabled: boolean): Promise<void> =>
  d.api.call('mobile.set', { enabled })
    .then((m) => { d.store.getState().setMobile(m); if (m.error) d.store.getState().showToast(m.error); })
    .catch(toast(d));
