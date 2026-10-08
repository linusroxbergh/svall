import type { Deps } from './actions.js';
import { openBeside, opensInside, type BrowserManager } from './browser.js';
import { commitFocused } from './Field.js';
import { chordOf, resolve, type KeyAction } from './keys.js';
import { isTerminal, mainLeft, showBrowser, shows, toggleBrowserRight } from './panes.js';
import { boardViewed, charactersOf, firstOfNextIsland, isVeiled, neighbor, panesOf, selectedOf, STARRED } from './selectors.js';
import { canFill, zoomBy } from './settings.js';
import type { AppState, AppStore } from './store/index.js';
import { secondKey, viewedId } from './terminals.js';

// the keys also open a character's link, in the browser that comes up with the socket
type KeyDeps = Deps & { browser?: BrowserManager };

// keyboard focus goes back to a surface whenever something closes over it: the browser when it is the
// left pane, otherwise whichever terminal is up
export function refocusSurface({ store, bridge }: Pick<Deps, 'store' | 'bridge'>): void {
  const s = store.getState();
  const id = viewedId(s);
  if (!bridge.present || !id) return;
  const p = panesOf(s, id);
  const tab = s.fleet.characters[id]?.browser?.active;
  if (p.left === 'browser' && tab) bridge.send({ type: 'browser.focus', tab });
  else {
    const up = [p.left, p.right].find(isTerminal);
    if (up) bridge.send({ type: 'term.focus', id: up === 'terminal2' ? secondKey(id) : id });
  }
}

// navigation moves the selection; the board's terminal and the map's open card follow it
function goTo({ store }: Deps, id?: string, starred = false): void {
  if (!id) return;
  commitFocused();
  const st = store.getState();
  if (st.view === 'board' || st.card) st.focus(id); else st.select(id, st.sideCardOpen);
  st.setStarredRow(starred ? id : undefined);
}

// the character the keys act on: the selection on the map, the viewed one on the board
const currentOf = (s: AppState): string | undefined => (s.view === 'map' ? (s.selectedId ?? s.card ?? selectedOf(s)) : boardViewed(s));

const nextOf = (s: AppState, id: string | undefined, step: 1 | -1) =>
  neighbor(s.fleet, id, step, !s.sections[STARRED]?.shut, s.starredRow === id);

// an island picked on the map selects no character, so the walk starts at its first
const islandFirst = (s: AppState): string | undefined => {
  const i = s.view === 'map' && !s.selectedId && s.selectedIslandId ? s.fleet.islands[s.selectedIslandId] : undefined;
  return i && !i.collapsed ? charactersOf(s.fleet, i.id)[0]?.id : undefined;
};

export async function closeCharacter(ctx: Deps, id: string): Promise<void> {
  const s = ctx.store.getState();
  // closing the current character moves on first, so the removal patch never catches the terminal view without one
  if (id === currentOf(s)) {
    const next = nextOf(s, id, 1);
    if (next) goTo(ctx, next.c.id, next.starred);
    else s.select(undefined);
  }
  await ctx.api.call('char.close', { id });
}

function closeAllModals(store: AppStore): void {
  const s = store.getState();
  s.setNamingCharacter(false); s.setMissionPrompt(false); s.setClosingCharacter(undefined); s.setDeletingIsland(undefined); s.setFleetPicker(undefined); s.toggleKeys(false);
}

export function openFleetPicker(store: AppStore): void {
  closeAllModals(store);
  store.getState().setFleetPicker('menu');
}

export async function dispatchKey(action: KeyAction, ctx: KeyDeps): Promise<void> {
  const { store, bridge } = ctx;
  const s = store.getState();
  const f = s.fleet;
  const current = currentOf(s);
  const go = (id?: string) => goTo(ctx, id);
  const walk = (step: 1 | -1) => {
    const first = islandFirst(s);
    if (first && step === 1) return goTo(ctx, first);
    const r = nextOf(s, first ?? current, step);
    goTo(ctx, r?.c.id, r?.starred);
  };
  const closeModals = () => closeAllModals(store);

  switch (action.type) {
    // one modal at a time: the backdrops share a layer, so a second would mount unseen and take the keys
    case 'newCharacter': closeModals(); store.getState().setNamingCharacter(true); return;
    case 'missionControl': closeModals(); store.getState().setMissionPrompt(true); return;
    case 'openFleets': openFleetPicker(store); return;
    case 'arrange': if (s.view === 'map') store.getState().askArrange(); return;
    case 'closeCharacter': {
      // a second Cmd+W answers the dialog the first one opened
      if (s.closingCharacter) {
        store.getState().setClosingCharacter(undefined);
        await closeCharacter(ctx, s.closingCharacter).catch((e: Error) => store.getState().showToast(e.message));
        return;
      }
      if (s.view === 'map' && s.card) { store.getState().closeCard(); return; }
      if (!current) return;
      // the close key sits among the ones that walk the fleet, so a character closed by key is confirmed first
      closeModals();
      store.getState().setClosingCharacter(current);
      return;
    }
    case 'prevCharacter': walk(-1); return;
    case 'nextCharacter': walk(1); return;
    case 'toggleView': commitFocused(); store.getState().setView(s.view === 'map' ? 'board' : 'map'); return;
    case 'toggleCardSize': if (s.view === 'map') store.getState().toggleCardSize(); return;
    case 'toggleSettings':
      commitFocused();
      store.getState().toggleSettings();
      if (!store.getState().settingsOpen) refocusSurface(ctx);
      return;
    case 'toggleResources':
      commitFocused();
      store.getState().toggleResources();
      if (!store.getState().resourcesOpen) refocusSurface(ctx);
      return;
    case 'zoom': {
      const { settings, setSettings } = store.getState();
      setSettings({ zoom: action.steps === 0 ? 1 : zoomBy(settings.zoom, action.steps) });
      return;
    }
    case 'toggleSideCard':
      commitFocused();
      store.getState().toggleSideCard();
      if (!store.getState().sideCardOpen) refocusSurface(ctx);
      return;
    case 'showPane': {
      const id = viewedId(s);
      if (!id) return;
      store.getState().setPanes(id, mainLeft(panesOf(s, id), action.pane));
      if (action.pane === 'terminal') refocusSurface(ctx);
      return;
    }
    case 'nextIsland': go(firstOfNextIsland(f, current)?.id); return;
    case 'toggleBrowser': {
      const id = viewedId(s);
      if (!id) return;
      store.getState().setPanes(id, toggleBrowserRight(panesOf(s, id)));
      if (!shows(panesOf(store.getState(), id), 'browser')) refocusSurface(ctx);
      return;
    }
    case 'focusAddress': {
      const id = viewedId(s);
      if (!id) return;
      store.getState().setPanes(id, showBrowser(panesOf(s, id)));
      store.getState().focusAddress();
      return;
    }
    case 'openLink': {
      const item = current ? f.characters[current]?.context.find(opensInside) : undefined;
      if (current && item && ctx.browser) openBeside(store, ctx.browser, current, item.ref);
      return;
    }
    case 'fillLogin': {
      const id = viewedId(s);
      const tab = id ? f.characters[id]?.browser?.active : undefined;
      if (tab && shows(panesOf(s, id), 'browser') && canFill(s) && bridge.present) bridge.send({ type: 'browser.fill', tab });
      return;
    }
    case 'none': return;
  }
}

export function installKeyHandlers(ctx: KeyDeps, win: Window = window): () => void {
  const map = () => resolve(ctx.store.getState().settings.bindings);
  // a chord pressed while settings waits for one is the answer to that, not a command
  const run = (chord: string) => {
    if (ctx.store.getState().capturingKey) return;
    const a = map()[chord];
    if (a) dispatchKey(a, ctx).catch((e: Error) => console.warn(`${a.type}: ${e.message}`));
  };
  // Esc: the terminal card first, then the side card; the board keeps its selection so the terminal stays put
  const closeCard = () => {
    const st = ctx.store.getState();
    if (st.capturingKey) { st.setCapturingKey(undefined); return; }
    if (st.resourcesOpen) { st.toggleResources(false); refocusSurface(ctx); return; }
    if (st.usageOpen) { st.toggleUsage(false); refocusSurface(ctx); return; }
    if (st.mobileOpen) { st.toggleMobile(false); refocusSurface(ctx); return; }
    if (st.settingsOpen) { st.toggleSettings(false); refocusSurface(ctx); return; }
    if (st.view === 'map' && st.card) { st.closeCard(); return; }
    if (st.view === 'board') st.toggleSideCard(false);
    else { st.select(undefined); st.selectIsland(undefined); }
    refocusSurface(ctx);
  };
  const tag = (e: KeyboardEvent) => (e.target as { tagName?: string } | null)?.tagName ?? '';
  const field = (e: KeyboardEvent) => /^(INPUT|TEXTAREA|SELECT)$/.test(tag(e));
  // a control the user reached with Tab keeps Enter; one left focused by a mouse click does not.
  // the browser calls any focused control :focus-visible once a key is down, so it is read as the focus lands
  let keyFocused = false;
  const onFocus = (e: FocusEvent) => { keyFocused = Boolean((e.target as Element | null)?.matches?.(':focus-visible')); };
  win.addEventListener('focusin', onFocus);
  const control = (e: KeyboardEvent): boolean => field(e) || (/^(BUTTON|A)$/.test(tag(e)) && keyFocused);
  // the editor owns its keys: Enter inserts a line, Escape closes its search panel
  const inEditor = (e: KeyboardEvent): boolean => Boolean((e.target as Element | null)?.closest?.('.cm-editor'));
  // plain keys the page itself handles: Esc closes the card, Enter opens the selection (board: the surface takes the keys, map: the card)
  const onPlain = (e: KeyboardEvent): boolean => {
    if (inEditor(e)) return false;
    if (e.key === 'Escape') {
      // a field saves on blur, which never fires once the card has unmounted
      if (field(e)) (e.target as HTMLElement).blur();
      closeCard();
      return true;
    }
    const s = ctx.store.getState();
    // behind an overlay or a popup the selection is out of sight, so Enter is theirs
    if (e.key === 'Enter' && !control(e) && !e.metaKey && !isVeiled(s) && !s.linkAsk && !s.usageOpen && !s.mobileOpen) {
      // the key is spent here: a control still holding the focus must not activate on it as well
      if (s.view === 'board') { e.preventDefault(); refocusSurface(ctx); return true; }
      if (s.view === 'map' && s.selectedId) { e.preventDefault(); s.focus(s.selectedId); return true; }
    }
    return false;
  };

  if (ctx.bridge.present) {
    // the shell swallows the list it was given and nothing else, so a chord changed in settings has to reach it again
    const register = () => ctx.bridge.send({ type: 'keys.register', chords: Object.keys(map()) });
    register();
    const unwatch = ctx.store.subscribe((s, prev) => { if (s.settings.bindings !== prev.settings.bindings) register(); });
    const off = ctx.bridge.onMessage((m) => { if (m.type === 'key') run(m.chord); });
    const onKey = (e: KeyboardEvent) => { onPlain(e); };
    win.addEventListener('keydown', onKey);
    return () => { off(); unwatch(); win.removeEventListener('keydown', onKey); win.removeEventListener('focusin', onFocus); };
  }

  const onKey = (e: KeyboardEvent) => {
    if (onPlain(e)) return;
    const chord = chordOf(e);
    if (!chord || !map()[chord]) return;
    e.preventDefault();
    run(chord);
  };
  win.addEventListener('keydown', onKey);
  return () => { win.removeEventListener('keydown', onKey); win.removeEventListener('focusin', onFocus); };
}
