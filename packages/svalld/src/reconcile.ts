import { DEFAULT_SIZE, randomPortrait, type Cell, type Character, type FleetState, type TerminalSlot } from '@svall/protocol';
import { loseSecond, markDormant, markSlotDormant } from './dormancy.js';
import { isCharId, newId } from './ids.js';
import { defaultPosition, placeOnIsland } from './layout.js';
import type { LiveWindow } from './tmux/tmux.js';

export const RECOVERED_ISLAND = 'i_recovered';

// the tmux window of a character's second terminal
export const secondName = (id: string): string => `${id}-2`;

// each character's windows as the fleet knew them before a listing was taken
export type Before = Map<string, { main?: string; second?: string }>;

export const snapshot = (state: FleetState): Before =>
  new Map(Object.values(state.characters).map((c) => [c.id, { main: c.tmux?.windowId, second: c.second?.tmux?.windowId }]));

// the slot a live window leaves behind: at the window's own path, with nothing left to revive unless it is `carried`.
// tmux reports no path while a setuid program such as sudo runs in the pane
export function attachSlot(slot: TerminalSlot | undefined, w: LiveWindow, carried = false): TerminalSlot {
  const next = { unread: false, ...slot, cwd: w.path || (slot?.cwd ?? ''), tmux: { windowId: w.windowId, paneId: w.paneId } };
  delete next.resumeError;
  if (!carried) delete next.revive;
  return next;
}

/** The terminals a handover has yet to start: each keeps the agent and resume command it carries to it. */
export type Carried = (id: string, term?: 2) => boolean;

type Settle = (key: string, slot: TerminalSlot, command: string, carried: boolean, dormant: (s: TerminalSlot) => void) => void;

// without `adoptCarried`, as in the poll, a dormant terminal a handover has yet to start is the handover's to open,
// whatever window is listed for it
type Sync = { carried?: Carried; adoptCarried?: boolean; settle?: Settle };

/** Matches a character's second terminal, main window and pane directory to a listing taken after `before`; a slot the
 *  fleet changed while tmux answered is left as it stands. Returns the main window the character stands on, when listed. */
export function syncWindow(c: Character, byName: ReadonlyMap<string, LiveWindow>, before: Before, o: Sync = {}): LiveWindow | undefined {
  const { carried = () => false, adoptCarried = false, settle } = o;
  const was = before.get(c.id);
  if (was?.second === c.second?.tmux?.windowId) {
    const w2 = byName.get(secondName(c.id));
    const held = carried(c.id, 2);
    if (w2 && !w2.dead) {
      if (c.second?.tmux || !held || adoptCarried) {
        c.second = attachSlot(c.second, w2, held);
        settle?.(secondName(c.id), c.second, w2.command, held, (s) => markSlotDormant(s));
      }
    } else if (c.second?.tmux) {
      loseSecond(c);
    }
  }
  if (was?.main !== c.tmux?.windowId) return undefined;
  const w = byName.get(c.id);
  if (!w || w.dead) {
    // one already dormant keeps the revive it was given, flags and all
    if (c.tmux || !c.revive) markDormant(c);
    return undefined;
  }
  const held = carried(c.id);
  if (!c.tmux && held && !adoptCarried) return undefined;
  const samePane = c.tmux?.paneId === w.paneId;
  c.tmux = { windowId: w.windowId, paneId: w.paneId };
  delete c.resumeError;
  // a live terminal keeps the resume a handover carried only until the handover has answered for it
  if (!held) delete c.revive;
  // only a pane that moved moves the character, and an empty path is tmux not knowing, as under sudo.
  // A pane the character had all along with no path on record has not moved, so its cwd stays
  if (w.path && c.panePath !== w.path) {
    if (c.panePath !== undefined || !samePane) c.cwd = w.path;
    c.panePath = w.path;
  }
  settle?.(c.id, c, w.command, held, () => markDormant(c));
  // shown only where there is no agent's own activity to show
  if (!c.agent) c.shell.lastOutputAt = w.activity;
  return w;
}

export function reconcile(state: FleetState, live: LiveWindow[], now: number, before = snapshot(state), carried: Carried = () => false) {
  const byName = new Map(live.map((w) => [w.name, w]));
  const knownIds = new Set(Object.keys(state.characters));
  const secondNames = new Set(Object.keys(state.characters).map(secondName));
  // a row with no name, or one the listing could not split into its fields, is no window to adopt
  const strays = live.filter((w) => w.name && w.paneId && typeof w.path === 'string' && !knownIds.has(w.name) && !secondNames.has(w.name));
  // a stray named like a character id keeps that id, so the SVALL_CHAR_ID its agent carries still reaches it
  const taken = new Set(knownIds);
  const strayIds = strays.map((w) => {
    const id = isCharId(w.name) && !taken.has(w.name) ? w.name : newId('c');
    taken.add(id);
    return { w, id };
  });
  // a stray kept under its own id takes its second window back, as its second terminal
  const seconds = new Map(strayIds.filter(({ w, id }) => id === w.name).map(({ id }) => [secondName(id), id]));
  const adopted = strayIds.filter(({ w }) => !seconds.has(w.name));
  // filled as the strays are adopted: a window renamed to an id no character holds would be recovered
  // all over again on the next pass, under the id as its name
  const renames: { windowId: string; name: string }[] = [];
  // the strays the recovered island had no room for, for the caller to log; the rest are adopted
  const unplaced: string[] = [];

  const mutate = (draft: FleetState) => {
    for (const c of Object.values(draft.characters)) syncWindow(c, byName, before, { carried, adoptCarried: true });
    // a character whose island is gone joins the recovered island, keeping all it carries
    const orphans = Object.values(draft.characters).filter((c) => !draft.islands[c.islandId]).map((c) => c.id);
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
      draft.characters = trial.characters;
      return cell;
    };
    for (const { w, id } of adopted) {
      let cell: Cell;
      try { cell = place(); }
      catch (e) { unplaced.push(`stray window ${w.name}: ${String(e)}`); continue; }
      draft.characters[id] = {
        id, islandId: RECOVERED_ISLAND, cell, name: w.name,
        portrait: randomPortrait(new Set(Object.values(draft.characters).map((c) => c.portrait))),
        note: '', instructions: '', cwd: w.path, context: [],
        tmux: { windowId: w.windowId, paneId: w.paneId },
        shell: { lastOutputAt: w.activity || now }, unread: false,
      };
      if (id !== w.name) renames.push({ windowId: w.windowId, name: id });
    }
    for (const [name, id] of seconds) {
      const w2 = byName.get(name);
      if (draft.characters[id] && w2 && !w2.dead) draft.characters[id].second = attachSlot(undefined, w2);
    }
    for (const id of orphans) {
      try {
        const cell = place(id);
        draft.characters[id].cell = cell;
        draft.characters[id].islandId = RECOVERED_ISLAND;
      } catch (e) { unplaced.push(`character ${id}: ${String(e)}`); }
    }
  };
  return { mutate, renames, unplaced };
}
