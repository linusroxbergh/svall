import { DEFAULT_SIZE, HOME_ROW, cellKey, homeSizeFor, homeSlots, isSessionId, randomPortrait, type Cell, type Character, type FleetState, type Island, type TerminalSlot } from '@archipelago/protocol';
import { isCharId, newId } from './ids.js';
import { clearOf, crewGrid, crewOf, defaultPosition, freePosition, occupiedCells, placementOk, worldIslands } from './layout.js';
import type { LiveWindow } from './tmux/tmux.js';

export const RECOVERED_ISLAND = 'i_recovered';

// the tmux window of a character's second terminal
export const secondName = (id: string): string => `${id}-2`;

class IslandFull extends Error { code = 'invalid'; }

// flags are the launch flags to resume with, already quoted
export function reviveCommand(t: TerminalSlot, flags: string[] = []): string {
  if (!t.agent || !isSessionId(t.agent.sessionId)) return '';
  // a codex character's cwd follows its commands into worktrees; resumed from one, codex would stop to ask which directory
  const words = t.agent.kind === 'codex' ? ['codex', 'resume', '-c', 'tui.resume_cwd=session', ...flags] : ['claude', ...flags, '--resume'];
  return [...words, t.agent.sessionId].join(' ');
}

// a terminal without a window keeps its directory and the command that brings its session back
export function markSlotDormant(t: TerminalSlot, flags?: string[]): void {
  delete t.tmux;
  t.revive = { command: reviveCommand(t, flags) };
  // nothing runs until the revive, so no question is left open and no turn goes on; a finished result stays
  if (t.agent && (t.agent.status === 'blocked' || t.agent.status === 'working')) {
    t.agent.status = 'idle';
    delete t.agent.prompt;
    delete t.agent.promptId;
    delete t.agent.background;
  }
}

export function markDormant(c: Character, flags?: string[]): void {
  delete c.hint;
  markSlotDormant(c, flags);
}

// a plain side shell goes with its window; a second that ran an agent stays behind to be revived
export function loseSecond(c: Character): void {
  if (c.second?.agent) markSlotDormant(c.second);
  else delete c.second;
}

// the slot a live window leaves behind: at the window's own path, with nothing left to revive unless it is `carried`.
// tmux reports no path while a setuid program such as sudo runs in the pane
export function attachSlot(slot: TerminalSlot | undefined, w: LiveWindow, carried = false): TerminalSlot {
  const next = { unread: false, ...slot, cwd: w.path || (slot?.cwd ?? ''), tmux: { windowId: w.windowId, paneId: w.paneId } };
  delete next.resumeError;
  if (!carried) delete next.revive;
  return next;
}

// the island takes the ground a crew one larger needs and everyone lines up on it, as `arrange` lays out
// the fleet; the newcomer takes the cell the grid leaves at the end, and the islands the new shape reaches
// into are pushed aside
export function placeOnIsland(draft: FleetState, islandId: string, exceptId?: string): Cell {
  const island = draft.islands[islandId];
  if (island.kind === 'home') return placeOnHome(draft, island);
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

// the first free slot on the crew row; a full row widens the island by one slot, and it never shrinks
function placeOnHome(draft: FleetState, island: Island): Cell {
  const taken = occupiedCells(draft, island.id);
  const free = homeSlots(island.size.w).find((x) => !taken.has(cellKey({ x, y: HOME_ROW })));
  if (free !== undefined) return { x: free, y: HOME_ROW };
  island.size = homeSizeFor(homeSlots(island.size.w).length + 1);
  return { x: homeSlots(island.size.w).at(-1)!, y: HOME_ROW };
}

// `known` is the characters still on the window they had when the live window list was taken; one created
// or revived since is absent from that list and must not be marked dormant. `hadSecond` is the same for second
// terminals: one opened since is absent from the listing and must not be lost. A terminal a handover
// has yet to start is `carried`, and keeps the command that resumes it.
export function reconcile(
  state: FleetState,
  live: LiveWindow[],
  now: number,
  known = new Set(Object.keys(state.characters)),
  hadSecond = new Set(Object.values(state.characters).filter((c) => c.second).map((c) => c.id)),
  carried: (id: string, term?: 2) => boolean = () => false,
) {
  const byName = new Map(live.map((w) => [w.name, w]));
  const knownIds = new Set(Object.keys(state.characters));
  const secondNames = new Set(Object.keys(state.characters).map(secondName));
  const strays = live.filter((w) => !knownIds.has(w.name) && !secondNames.has(w.name));
  // a stray named like a character id keeps that id, so the ARCHI_CHAR_ID its agent carries still reaches it
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
    for (const c of Object.values(draft.characters)) {
      const w2 = byName.get(secondName(c.id));
      if (w2 && !w2.dead) c.second = attachSlot(c.second, w2, carried(c.id, 2));
      else if (c.second?.tmux && hadSecond.has(c.id)) loseSecond(c);
      const w = byName.get(c.id);
      if (w) {
        const samePane = c.tmux?.paneId === w.paneId;
        c.tmux = { windowId: w.windowId, paneId: w.paneId };
        // as in the poll: only a pane that moved moves the character, and an empty path is tmux not knowing.
        // A pane the character had all along with no path on record has not moved, so its cwd stays
        if (w.path && c.panePath !== w.path) {
          if (c.panePath !== undefined || !samePane) c.cwd = w.path;
          c.panePath = w.path;
        }
        c.shell.lastOutputAt = w.activity;
        delete c.resumeError;
        if (!carried(c.id)) delete c.revive;
      } else if (known.has(c.id) && (c.tmux || !c.revive)) {
        // one already dormant keeps the revive it was given, flags and all
        markDormant(c);
      }
    }
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
      if (draft.characters[id] && w2 && !w2.dead) draft.characters[id].second = attachSlot(undefined, w2);
    }
    for (const c of orphans) {
      try { c.cell = placeOnIsland(draft, RECOVERED_ISLAND, c.id); c.islandId = RECOVERED_ISLAND; }
      catch (e) { unplaced.push(`character ${c.id}: ${String(e)}`); }
    }
  };
  return { mutate, renames, unplaced };
}
