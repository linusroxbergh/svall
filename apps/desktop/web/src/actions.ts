import { AgentKind, contextKind, DEFAULT_SIZE, HOME_ISLAND, type Cell, type Character, type ContextItem, type HomeAction, type Params, type Result, type Size } from '@svall/protocol';
import { ApiError, type Api } from './api.js';
import { shim, type Bridge } from './bridge.js';
import type { DropTarget } from './drop.js';
import { withoutSecond } from './panes.js';
import type { FieldRef } from './resources/model.js';
import { boardViewed, charactersOf, mapIslandsSorted, panesOf, selectedOf } from './selectors.js';
import type { AppStore } from './store/index.js';

// what it takes to act on the fleet: the socket, the mirror, and the shell
export type Deps = { api: Api; store: AppStore; bridge: Bridge };
// the fleet calls need the socket and the mirror; only the keyboard also needs the shell
type ActionDeps = Pick<Deps, 'api' | 'store'>;

const toast = (d: ActionDeps) => (e: Error) => d.store.getState().showToast(e.message);

// Settings stands where the side card would show a new island or character, so making one puts Settings away
const closeSettings = (d: ActionDeps): void => { if (d.store.getState().settingsOpen) d.store.getState().toggleSettings(false); };

// where a new character starts when it takes another one's directory: the repo itself, never the worktree that one sits in
const startCwd = (c: Character | undefined): string | undefined => (c?.repo?.isWorktree ? c.repo.mainRoot : c?.cwd);

// a cwd taken from another character can be gone (a removed worktree), so one the fleet refuses as not a
// directory gives way once to the fleet's default
export async function createCharacter(api: Pick<Api, 'call'>, params: Params<'char.create'>, fallback: string): Promise<Result<'char.create'>> {
  try {
    return await api.call('char.create', params);
  } catch (e) {
    if (params.cwd === fallback || !/not a directory/.test((e as Error).message)) throw e;
    return api.call('char.create', { ...params, cwd: fallback });
  }
}

// without an explicit cwd a new character inherits the one of the island's first character; home crew
// start in the home cwd, and an island with no crew to inherit from starts in the fleet's default cwd
export async function newCharacterOn(d: ActionDeps, islandId: string, cwd?: string): Promise<void> {
  closeSettings(d);
  const f = d.store.getState().fleet;
  const dir = cwd ?? (f.islands[islandId]?.kind === 'home' ? f.home.cwd : startCwd(charactersOf(f, islandId)[0]) ?? f.defaultCwd);
  try {
    const c = await createCharacter(d.api, { islandId, cwd: dir }, f.defaultCwd);
    d.store.getState().focus(c.id);
  } catch (e) {
    d.store.getState().showToast((e as Error).message);
  }
}

// A character row inserts before or after it, even across islands; an island row appends to its crew.
export function moveCharacterTo(d: ActionDeps, id: string, target: DropTarget, after = false): void {
  const f = d.store.getState().fleet;
  const other = target.kind === 'char' ? f.characters[target.id] : undefined;
  if (target.kind === 'char' && (!other || other.id === id)) return;
  if (other) {
    d.api.call('char.reorder', { id, targetId: other.id, after }).catch(toast(d));
    return;
  }
  d.api.call('char.move', { id, islandId: target.id }).catch(toast(d));
}

// dropped on a free cell a character keeps that spot; without one the fleet stands it in the first free one
export const moveCharacterToCell = (d: ActionDeps, id: string, islandId: string, cell?: Cell): void => {
  d.api.call('char.move', { id, islandId, cell }).catch(toast(d));
};

// the island is centred on the drop cell; the fleet stands the character in from its coast
export function newIslandAround(d: ActionDeps, id: string, cell: Cell): void {
  const c = d.store.getState().fleet.characters[id];
  if (!c) return;
  closeSettings(d);
  const size = DEFAULT_SIZE;
  const position = { x: cell.x - Math.floor(size.w / 2), y: cell.y - Math.floor(size.h / 2) };
  d.api.call('island.create', { name: islandName(c.cwd), position, size })
    .then((island) => d.api.call('char.move', { id, islandId: island.id }))
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
export function arrangeIslands(d: ActionDeps, aspect?: number): void {
  d.api.call('island.arrange', { aspect }).catch(toast(d));
}

// an island made on the map centres on the cell that asked for it; made from a button it has no cell,
// and the daemon picks the spot
export function newIsland(d: ActionDeps, cell?: Cell): void {
  closeSettings(d);
  const n = mapIslandsSorted(d.store.getState().fleet).length + 1;
  const position = cell && { x: cell.x - Math.floor(DEFAULT_SIZE.w / 2), y: cell.y - Math.floor(DEFAULT_SIZE.h / 2) };
  d.api.call('island.create', { name: `Island ${n}`, ...(position ? { position } : {}) })
    .then((i) => d.store.getState().selectIsland(i.id))
    .catch(toast(d));
}

const islandName = (cwd: string): string => (cwd === '~' ? 'island' : cwd.split('/').filter(Boolean).pop() ?? 'island');

// the selected island, else the current character's island, else the first one, else a fresh island
export async function newCharacterTarget(d: ActionDeps): Promise<{ islandId: string; cwd: string }> {
  const s = d.store.getState();
  const current = s.view === 'map' ? (s.selectedId ?? s.card ?? selectedOf(s)) : boardViewed(s);
  const islandSel = s.selectedIslandId;
  const base = islandSel ? charactersOf(s.fleet, islandSel)[0] : current ? s.fleet.characters[current] : undefined;
  const start = startCwd(base) ?? s.fleet.defaultCwd;
  const islandId = islandSel || base?.islandId || mapIslandsSorted(s.fleet)[0]?.id
    || (await d.api.call('island.create', { name: islandName(start) })).id;
  const cwd = s.fleet.islands[islandId]?.kind === 'home' ? s.fleet.home.cwd : start;
  return { islandId, cwd };
}

// a named character wherever the map last was, with its note and links written on once it exists;
// it is the caller that reports a refusal, so the dialog can stay open on one
export async function newNamedCharacter(d: ActionDeps, p: { name: string; note: string; refs: string[] }): Promise<string> {
  closeSettings(d);
  const { islandId, cwd } = await newCharacterTarget(d);
  const c = await createCharacter(d.api, { islandId, cwd, ...(p.name ? { name: p.name } : {}) }, d.store.getState().fleet.defaultCwd);
  if (p.note || p.refs.length) {
    // the character already exists, so a refused path is reported rather than retried
    await d.api.call('char.update', {
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
  const known = new Set(Object.keys(d.store.getState().fleet.characters));
  const stop = d.store.subscribe((s) => {
    const fresh = Object.values(s.fleet.characters).find((c) => c.islandId === HOME_ISLAND && !known.has(c.id));
    if (!fresh) return;
    stop();
    if (d.store.getState().selectedId === before) d.store.getState().select(fresh.id);
  });
  return stop;
}

// a fresh crew member in the home cwd, started with the home command and handed the prompt;
// without a label the daemon names it. false when the fleet refused, the reason already on a toast
export async function startHomeCharacter(d: ActionDeps, p: { prompt: string; label?: string }): Promise<boolean> {
  closeSettings(d);
  const { home } = d.store.getState().fleet;
  const before = d.store.getState().selectedId;
  const stop = selectOnArrival(d, before);
  // a crew member whose CLI svalld doesn't find only prints command not found; the toast says why, and a
  // login shell that finds it still gets its chance
  const cli = home.command.trim().split(/\s+/)[0];
  const found = d.store.getState().fleet.agentsFound;
  const unfound = AgentKind.safeParse(cli).success && found !== undefined && !found.includes(cli as AgentKind);
  if (unfound) d.store.getState().showToast(`Mission control runs ${cli}, which svalld doesn't find. Install it, then run ${shim()} setup.`);
  try {
    const c = await d.api.call('char.create', { islandId: HOME_ISLAND, cwd: home.cwd, ...(p.label ? { name: p.label } : {}), command: home.command, run: p.prompt });
    // a crew member the mirror already has was chosen for, or yielded, on arrival
    const s = d.store.getState();
    if (s.selectedId === before && !s.fleet.characters[c.id]) s.select(c.id);
    // an agent that never reported in was booting slowly or is waiting on a question of its own; either
    // way the crew member is there and the prompt is still the user's to send, so it is not thrown away
    if (!unfound) {
      if (c.runSent === false) {
        d.store.getState().showToast(`${c.name} started, prompt not sent`, 'ok',
          { label: 'Send it', run: () => { d.api.call('char.run', { id: c.id, text: p.prompt, enter: true }).catch(toast(d)); } });
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
  await startHomeCharacter(d, { prompt: skillPrompt(d.store.getState().fleet.home.command, action.prompt), label: action.label });
};

// an edit that never reached the fleet may have left with its field, so the toast keeps it to send again
const unsent = (d: ActionDeps, retry: () => void) => (e: Error) =>
  d.store.getState().showToast(e.message, 'error', e instanceof ApiError ? undefined : { label: 'Retry', run: retry });

export const saveCharacter = (d: ActionDeps, id: string, patch: Omit<Params<'char.update'>, 'id'>): void => {
  d.api.call('char.update', { id, ...patch }).catch(unsent(d, () => saveCharacter(d, id, patch)));
};

// a context write carries the whole list, so a failed one is only reported: sent again later it could drop items added meanwhile
export const saveCharacterContext = (d: ActionDeps, id: string, context: ContextItem[]): void => {
  d.api.call('char.update', { id, context }).catch(toast(d));
};

export const reviveCharacter = (d: ActionDeps, id: string): Promise<boolean> =>
  d.api.call('char.revive', { id }).then(() => true, (e: Error) => { toast(d)(e); return false; });

export const deleteCharacter = (d: ActionDeps, id: string): void => { d.api.call('char.close', { id }).catch(toast(d)); };

// the pane waits on the terminal it asked for, so a refusal closes that pane again and says why
export const openSecondTerminal = (d: ActionDeps, id: string): void => {
  d.api.call('char.second', { id }).catch((e: Error) => {
    const s = d.store.getState();
    const c = s.fleet.characters[id];
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
  d.api.call('island.delete', { id })
    .then(() => { if (d.store.getState().selectedIslandId === id) d.store.getState().selectIsland(undefined); })
    .catch(toast(d));
};

// an island's or a character's own field, written straight back to the fleet
export const saveEntityField = (d: ActionDeps, r: FieldRef, value: string): void => {
  if (r.tier === 'character') saveCharacter(d, r.id, r.field === 'note' ? { note: value } : { instructions: value });
  else saveIsland(d, r.id, r.field === 'note' ? { description: value } : { instructions: value });
};

export const activateBrowserTab = (d: ActionDeps, id: string, tab: string): void => { d.api.fire('browser.activate', { id, tab }); };

export const closeBrowserTab = (d: ActionDeps, id: string, tab: string): void => { d.api.fire('browser.close', { id, tab }); };

export const setScribe = (d: ActionDeps, enabled: boolean): void => {
  d.api.call('scribe.set', { enabled }).catch(toast(d));
};

export const setMainAgent = (d: ActionDeps, agent: AgentKind): void => {
  d.api.call('mainAgent.set', { agent }).catch(toast(d));
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
