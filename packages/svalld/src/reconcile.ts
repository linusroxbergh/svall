import { DEFAULT_SIZE, randomPortrait, type Cell, type Robot, type FleetState, type TerminalSlot } from '@svall/protocol';
import { dropBrief, loseSecond, markDormant, markSlotDormant } from './dormancy.js';
import { isRobotId, newId } from './ids.js';
import { defaultPosition, placeOnIsland } from './layout.js';
import type { LiveWindow } from './tmux/tmux.js';

export const RECOVERED_ISLAND = 'i_recovered';

// the tmux window of a robot's second terminal
export const secondName = (id: string): string => `${id}-2`;

// each robot's windows as the fleet knew them before a listing was taken
export type Before = Map<string, { main?: string; second?: string }>;

export const snapshot = (state: FleetState): Before =>
  new Map(Object.values(state.robots).map((c) => [c.id, { main: c.tmux?.windowId, second: c.second?.tmux?.windowId }]));

// the slot a live window leaves behind: at the window's own path, with nothing left to revive.
// tmux reports no path while a setuid program such as sudo runs in the pane
function attachSlot(slot: TerminalSlot | undefined, w: LiveWindow): TerminalSlot {
  const next = { unread: false, ...slot, cwd: w.path || (slot?.cwd ?? ''), tmux: { windowId: w.windowId, paneId: w.paneId } };
  delete next.resumeError;
  delete next.revive;
  return next;
}

type Settle = (key: string, slot: TerminalSlot, command: string, dormant: (s: TerminalSlot) => void) => void;

// `atShell` says, by window name, whether the last poll saw the agent quit to its shell
type Sync = { settle?: Settle; atShell?: (key: string) => boolean };

/** Matches a robot's second terminal, main window and pane directory to a listing taken after `before`; a slot the
 *  fleet changed while tmux answered is left as it stands. Returns the main window the robot stands on, when listed. */
export function syncWindow(c: Robot, byName: ReadonlyMap<string, LiveWindow>, before: Before, o: Sync = {}): LiveWindow | undefined {
  const { settle, atShell } = o;
  const was = before.get(c.id);
  if (was?.second === c.second?.tmux?.windowId) {
    const w2 = byName.get(secondName(c.id));
    if (w2 && !w2.dead) {
      c.second = attachSlot(c.second, w2);
      settle?.(secondName(c.id), c.second, w2.command, (s) => markSlotDormant(s));
    } else if (c.second?.tmux) {
      loseSecond(c, undefined, atShell?.(secondName(c.id)));
    }
  }
  if (was?.main !== c.tmux?.windowId) return undefined;
  const w = byName.get(c.id);
  if (!w || w.dead) {
    // one already dormant keeps the revive it was given, flags and all
    if (c.tmux || !c.revive) markDormant(c); else dropBrief(c);
    return undefined;
  }
  const samePane = c.tmux?.paneId === w.paneId;
  c.tmux = { windowId: w.windowId, paneId: w.paneId };
  delete c.resumeError;
  delete c.revive;
  // only a pane that moved moves the robot, and an empty path is tmux not knowing, as under sudo.
  // A pane the robot had all along with no path on record has not moved, so its cwd stays
  if (w.path && c.panePath !== w.path) {
    if (c.panePath !== undefined || !samePane) c.cwd = w.path;
    c.panePath = w.path;
  }
  settle?.(c.id, c, w.command, () => markDormant(c));
  // shown only where there is no agent's own activity to show
  if (!c.agent) c.shell.lastOutputAt = w.activity;
  return w;
}

/** `runsHere` names the robots whose windows this machine holds; one placed elsewhere is left as its machine reports it. */
export function reconcile(state: FleetState, live: LiveWindow[], now: number, before = snapshot(state), runsHere: (c: Robot) => boolean = () => true) {
  const byName = new Map(live.map((w) => [w.name, w]));
  const knownIds = new Set(Object.keys(state.robots));
  const secondNames = new Set(Object.keys(state.robots).map(secondName));
  // a window held, when the listing was taken, by a robot closed since goes with it, and is nobody's to adopt
  const held = new Set([...before].filter(([id]) => !knownIds.has(id)).flatMap(([, b]) => [b.main, b.second]));
  // a row with no name, or one the listing could not split into its fields, is no window to adopt
  const strays = live.filter((w) => w.name && w.paneId && typeof w.path === 'string' && !knownIds.has(w.name) && !secondNames.has(w.name) && !held.has(w.windowId));
  // a stray named like a robot id keeps that id, so the SVALL_ROBOT_ID its agent carries still reaches it
  const taken = new Set(knownIds);
  const strayIds = strays.map((w) => {
    const id = isRobotId(w.name) && !taken.has(w.name) ? w.name : newId('c');
    taken.add(id);
    return { w, id };
  });
  // a stray kept under its own id takes its second window back, as its second terminal
  const seconds = new Map(strayIds.filter(({ w, id }) => id === w.name).map(({ id }) => [secondName(id), id]));
  const adopted = strayIds.filter(({ w }) => !seconds.has(w.name));
  // filled as the strays are adopted: a window renamed to an id no robot holds would be recovered
  // all over again on the next pass, under the id as its name
  const renames: { windowId: string; name: string }[] = [];
  // the strays the recovered island had no room for, for the caller to log; the rest are adopted
  const unplaced: string[] = [];

  const mutate = (draft: FleetState) => {
    for (const c of Object.values(draft.robots)) if (runsHere(c)) syncWindow(c, byName, before);
    // a robot whose island is gone joins the recovered island, keeping all it carries
    const orphans = Object.values(draft.robots).filter((c) => !draft.islands[c.islandId]).map((c) => c.id);
    if ((adopted.length || orphans.length) && !draft.islands[RECOVERED_ISLAND]) {
      draft.islands[RECOVERED_ISLAND] = {
        id: RECOVERED_ISLAND, name: 'recovered', description: '', instructions: '', context: [],
        position: defaultPosition(draft), size: DEFAULT_SIZE, seed: 0,
      };
    }
    // tried on a copy: a placement the island has no room for leaves the fleet as it was, and the rest of the reconcile standing
    const place = (exceptId?: string): Cell => {
      const trial = structuredClone(draft);
      const cell = placeOnIsland(trial, RECOVERED_ISLAND, exceptId);
      draft.islands = trial.islands;
      draft.robots = trial.robots;
      return cell;
    };
    for (const { w, id } of adopted) {
      let cell: Cell;
      try { cell = place(); }
      catch (e) { unplaced.push(`stray window ${w.name}: ${String(e)}`); continue; }
      draft.robots[id] = {
        id, islandId: RECOVERED_ISLAND, cell, name: w.name,
        portrait: randomPortrait(new Set(Object.values(draft.robots).map((c) => c.portrait))),
        note: '', instructions: '', cwd: w.path, context: [],
        tmux: { windowId: w.windowId, paneId: w.paneId },
        shell: { lastOutputAt: w.activity || now }, unread: false,
      };
      if (id !== w.name) renames.push({ windowId: w.windowId, name: id });
    }
    for (const [name, id] of seconds) {
      const w2 = byName.get(name);
      if (draft.robots[id] && w2 && !w2.dead) draft.robots[id].second = attachSlot(undefined, w2);
    }
    for (const id of orphans) {
      try {
        const cell = place(id);
        draft.robots[id].cell = cell;
        draft.robots[id].islandId = RECOVERED_ISLAND;
      } catch (e) { unplaced.push(`robot ${id}: ${String(e)}`); }
    }
  };
  return { mutate, renames, unplaced };
}
