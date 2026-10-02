import { DEFAULT_SIZE, HOME_ROW, cellKey, homeSizeFor, homeSlots, isSessionId, randomPortrait, type Agent, type Cell, type Character, type FleetState, type Island } from '@svall/protocol';
import { isCharId, newId } from './ids.js';
import { clearOf, crewGrid, crewOf, defaultPosition, freePosition, occupiedCells, placementOk, worldIslands } from './layout.js';
import type { LiveWindow } from './tmux/tmux.js';

export const RECOVERED_ISLAND = 'i_recovered';

// the tmux window of a character's second terminal
export const secondName = (id: string): string => `${id}-2`;

class IslandFull extends Error { code = 'invalid'; }

// flags are the launch flags to resume with, already quoted
export function reviveCommand(c: Character, flags: string[] = []): string {
  if (!c.agent || !isSessionId(c.agent.sessionId)) return '';
  // a codex character's cwd follows its commands into worktrees; resumed from one, codex would stop to ask which directory
  const words = c.agent.kind === 'codex' ? ['codex', 'resume', '-c', 'tui.resume_cwd=session', ...flags] : ['claude', ...flags, '--resume'];
  return [...words, c.agent.sessionId].join(' ');
}

export function markDormant(c: Character, flags?: string[]): void {
  delete c.tmux;
  delete c.hint;
  c.revive = { command: reviveCommand(c, flags) };
  // nothing runs until the revive, so no question is left open and no turn goes on; a finished result stays
  if (c.agent && (c.agent.status === 'blocked' || c.agent.status === 'working')) {
    c.agent.status = 'idle';
    delete c.agent.prompt;
    delete c.agent.promptId;
    delete c.agent.background;
    delete c.agent.asking;
  }
}

// the island takes the ground a crew one larger needs and everyone lines up on it, as `arrange` lays out
// the fleet; the newcomer takes the cell the grid leaves at the end, and the islands the new shape reaches
// into are pushed aside. a hidden island comes back onto the map, so the newcomer is seen arriving
export function placeOnIsland(draft: FleetState, islandId: string, exceptId?: string): Cell {
  const island = draft.islands[islandId];
  if (island.kind === 'home') return placeOnHome(draft, island);
  delete island.collapsed;
  // a character re-placed on its own island is not its own crew, or the grid would size for it twice
  const crew = crewOf(draft, islandId).filter((id) => id !== exceptId);
  const { size, cells } = crewGrid(crew.length + 1, island.seed);
  island.size = size;
  crew.forEach((id, i) => { draft.characters[id].cell = cells[i]; });
  for (const o of worldIslands(draft)) {
    if (o.id !== islandId && !clearOf(o, island)) draft.islands[o.id].position = freePosition(draft, o);
  }
  // a neighbour the push could not clear would leave the two overlapping, a shape no other move can produce
  if (!placementOk(draft, island)) throw new IslandFull(`island ${island.name} is full`);
  return cells[crew.length];
}

// the first free slot on the crew row; a full row widens the island by one slot
function placeOnHome(draft: FleetState, island: Island): Cell {
  const taken = occupiedCells(draft, island.id);
  const free = homeSlots(island.size.w).find((x) => !taken.has(cellKey({ x, y: HOME_ROW })));
  if (free !== undefined) return { x: free, y: HOME_ROW };
  island.size = homeSizeFor(homeSlots(island.size.w).length + 1);
  return { x: homeSlots(island.size.w).at(-1)!, y: HOME_ROW };
}

// each character's windows as the fleet knew them before a listing was taken
export type Before = Map<string, { main?: string; second?: string }>;

export const snapshot = (state: FleetState): Before =>
  new Map(Object.values(state.characters).map((c) => [c.id, { main: c.tmux?.windowId, second: c.second?.tmux.windowId }]));

type Settle = (key: string, slot: { agent?: Agent }, command: string) => void;

/** Matches a character to a listing taken after `before`: its second terminal, its main window and the directory
 *  its pane moved to. A window opened, closed or replaced while tmux answered is absent from the listing, so that
 *  slot is left as it stands. Returns the main window the character stands on, when the listing has it. */
export function syncWindow(c: Character, byName: ReadonlyMap<string, LiveWindow>, before: Before, settle?: Settle): LiveWindow | undefined {
  const was = before.get(c.id);
  if (was?.second === c.second?.tmux.windowId) {
    const w2 = byName.get(secondName(c.id));
    if (w2 && !w2.dead) {
      c.second = { unread: false, ...c.second, tmux: { windowId: w2.windowId, paneId: w2.paneId } };
      settle?.(secondName(c.id), c.second, w2.command);
    } else {
      delete c.second;
    }
  }
  if (was?.main !== c.tmux?.windowId) return undefined;
  const w = byName.get(c.id);
  if (!w || w.dead) {
    // one already dormant keeps the revive it was given, flags and all
    if (c.tmux || !c.revive) markDormant(c);
    return undefined;
  }
  const samePane = c.tmux?.paneId === w.paneId;
  c.tmux = { windowId: w.windowId, paneId: w.paneId };
  delete c.revive;
  // only a pane that moved moves the character, and an empty path is tmux not knowing, as under sudo.
  // A pane the character had all along with no path on record has not moved, so its cwd stays
  if (w.path && c.panePath !== w.path) {
    if (c.panePath !== undefined || !samePane) c.cwd = w.path;
    c.panePath = w.path;
  }
  settle?.(c.id, c, w.command);
  // shown only where there is no agent's own activity to show
  if (!c.agent) c.shell.lastOutputAt = w.activity;
  return w;
}

export function reconcile(state: FleetState, live: LiveWindow[], now: number, before = snapshot(state)) {
  const byName = new Map(live.map((w) => [w.name, w]));
  const knownIds = new Set(Object.keys(state.characters));
  const secondNames = new Set(Object.keys(state.characters).map(secondName));
  const strays = live.filter((w) => !knownIds.has(w.name) && !secondNames.has(w.name));
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
    for (const c of Object.values(draft.characters)) syncWindow(c, byName, before);
    // a character whose island is gone joins the recovered island, keeping all it carries
    const orphans = Object.values(draft.characters).filter((c) => !draft.islands[c.islandId]);
    if ((adopted.length || orphans.length) && !draft.islands[RECOVERED_ISLAND]) {
      draft.islands[RECOVERED_ISLAND] = {
        id: RECOVERED_ISLAND, name: 'recovered', description: '', instructions: '', context: [],
        position: defaultPosition(draft), size: DEFAULT_SIZE, seed: 0,
      };
    }
    for (const { w, id } of adopted) {
      let cell: Cell;
      // one stray the island cannot hold leaves the others, and the whole reconcile, standing
      try { cell = placeOnIsland(draft, RECOVERED_ISLAND); }
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
      if (draft.characters[id] && w2 && !w2.dead) draft.characters[id].second = { tmux: { windowId: w2.windowId, paneId: w2.paneId }, unread: false };
    }
    for (const c of orphans) {
      try { c.cell = placeOnIsland(draft, RECOVERED_ISLAND, c.id); c.islandId = RECOVERED_ISLAND; }
      catch (e) { unplaced.push(`character ${c.id}: ${String(e)}`); }
    }
  };
  return { mutate, renames, unplaced };
}
