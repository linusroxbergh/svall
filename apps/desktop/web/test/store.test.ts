import { describe, expect, it } from 'vitest';
import type { ResourceSource } from '@svall/protocol';
import { isVeiled, panesOf } from '../src/selectors.js';
import type { Tier } from '../src/resources/model.js';
import { DEFAULT_SETTINGS, type Settings } from '../src/settings.js';
import { createAppStore, FILES_TREE_RANGE, RESOURCE_COL_RANGE, SIDE_WIDTH_RANGE, type AppStorage, type FilesTree, type HalfCard, type ResourceCols, type SideWidths, type View } from '../src/store/index.js';
import { chr, fleet } from './fixtures.js';

type Mem = AppStorage & { focus?: string; view?: View; sidebar?: boolean; half?: HalfCard; cols?: ResourceCols; sides?: SideWidths; tree?: FilesTree; settings?: Settings; groups?: Tier[] };

const memStorage = (): Mem => {
  const s: Mem = {
    getFocus: () => s.focus, setFocus: (id) => { s.focus = id; }, getView: () => s.view, setView: (v) => { s.view = v; },
    getSidebarOpen: () => s.sidebar, setSidebarOpen: (v) => { s.sidebar = v; },
    getHalfCard: () => s.half, setHalfCard: (v) => { s.half = v; },
    getResourceCols: () => s.cols, setResourceCols: (v) => { s.cols = v; },
    getSideWidths: () => s.sides, setSideWidths: (v) => { s.sides = v; },
    getFilesTree: () => s.tree, setFilesTree: (v) => { s.tree = v; },
    getSettings: () => s.settings, setSettings: (v) => { s.settings = v; },
    getResourceGroups: () => s.groups, setResourceGroups: (v) => { s.groups = v; },
  };
  return s;
};

const shellInfo = (ghosttyKeys?: Record<string, string>) => ({ home: '/h', log: [], op: false, ghosttyKeys });

describe('store', () => {
  it('mirrors the fleet through patches', () => {
    const store = createAppStore();
    store.getState().setFleet(fleet());
    expect(store.getState().loaded).toBe(true);
    store.getState().applyPatch([{ op: 'add', path: '/characters/c9', value: chr('c9', 'i_a', { x: 1, y: 0 }) }, { op: 'replace', path: '/characters/c0/unread', value: true }]);
    expect(store.getState().fleet.characters.c9.name).toBe('c9');
    expect(store.getState().fleet.characters.c0.unread).toBe(true);
  });
  it('ignores patches until the snapshot has loaded', () => {
    const store = createAppStore();
    store.getState().applyPatch([{ op: 'replace', path: '/characters/c0/unread', value: true }]);
    expect(store.getState().fleet.characters).toEqual({});
    store.getState().setFleet(fleet());
    store.getState().applyPatch([{ op: 'replace', path: '/characters/c0/unread', value: true }]);
    expect(store.getState().fleet.characters.c0.unread).toBe(true);
  });
  it('focus opens the card on the map, selects, and persists', () => {
    const storage = memStorage();
    const store = createAppStore(storage);
    store.getState().setFleet(fleet());
    store.getState().focus('c1');
    expect(store.getState()).toMatchObject({ view: 'map', card: 'c1', focusedId: 'c1', selectedId: 'c1' });
    expect(storage.focus).toBe('c1');
    store.getState().select(undefined);
    expect(store.getState().sideCardOpen).toBe(false);
    store.getState().select('c0');
    expect(store.getState()).toMatchObject({ selectedId: 'c0', sideCardOpen: true });
    store.getState().setView('board');
    expect(store.getState()).toMatchObject({ view: 'board', card: undefined, selectedId: 'c0', sideCardOpen: true });
    store.getState().setView('map');
    store.getState().focus('c0');
    expect(store.getState()).toMatchObject({ view: 'map', card: 'c0', focusedId: 'c0' });
  });
  it('a return from the board asks the map for an automatic arrange, unless auto-arrange is off', () => {
    const store = createAppStore(memStorage(), 'board');
    store.getState().setView('map');
    expect(store.getState().arrangeAsk).toBe('auto');
    store.getState().arranged();
    store.getState().setView('map');
    expect(store.getState().arrangeAsk).toBe(false);
    store.getState().setView('board');
    expect(store.getState().arrangeAsk).toBe(false);
    store.getState().setSettings({ autoArrange: false });
    store.getState().setView('map');
    expect(store.getState().arrangeAsk).toBe(false);
  });
  it('focus on the board selects and remembers, and stays on the board', () => {
    const storage = memStorage();
    const store = createAppStore(storage, 'board');
    store.getState().setFleet(fleet());
    store.getState().selectIsland('i_e');
    store.getState().focus('c1');
    expect(store.getState()).toMatchObject({ view: 'board', card: undefined, focusedId: 'c1', selectedId: 'c1', selectedIslandId: undefined });
    expect(storage.focus).toBe('c1');
    expect(storage.view).toBeUndefined();
  });
  it('restores a remembered focus only if the character still exists', () => {
    const storage = memStorage();
    storage.focus = 'c1';
    const a = createAppStore(storage);
    a.getState().setFleet(fleet());
    expect(a.getState().focusedId).toBe('c1');
    storage.focus = 'gone';
    const b = createAppStore(storage);
    b.getState().setFleet(fleet());
    expect(b.getState().focusedId).toBeUndefined();
  });
  it('leaves the chords the user already spends in Ghostty, and takes the rest, on a new machine', () => {
    const store = createAppStore(memStorage());
    store.getState().setShell(shellInfo({ 'cmd+t': 'new_split:right' }));
    expect(store.getState().settings.bindings).toEqual({ newCharacter: null });
  });
  it('asks once: a later shell.info does not re-decide what the user has answered since', () => {
    const store = createAppStore(memStorage());
    store.getState().setShell(shellInfo({}));
    store.getState().setSettings({ bindings: { newCharacter: 'cmd+t' } });
    store.getState().setShell(shellInfo({ 'cmd+t': 'new_split:right' }));
    expect(store.getState().settings.bindings).toEqual({ newCharacter: 'cmd+t' });
  });
  it('leaves a machine that has been used alone, however its Ghostty config reads', () => {
    const storage = memStorage();
    storage.settings = { ...DEFAULT_SETTINGS };
    const store = createAppStore(storage);
    store.getState().setShell(shellInfo({ 'cmd+t': 'new_split:right' }));
    expect(store.getState().settings.bindings).toEqual({});
  });
  it('stops listening for a chord when the card that was waiting for one goes', () => {
    const store = createAppStore(memStorage());
    store.getState().setCapturingKey('quit');
    store.getState().toggleSettings(false);
    expect(store.getState().capturingKey).toBeUndefined();
    store.getState().toggleSettings(true);
    store.getState().setCapturingKey('quit');
    // the side card takes the settings' place, which closes them the same way
    store.getState().toggleSideCard(true);
    expect(store.getState().capturingKey).toBeUndefined();
  });
  it('closes the shortcut editor with the card it was opened from, and stops listening with it', () => {
    const store = createAppStore(memStorage());
    store.getState().toggleSettings(true);
    store.getState().toggleKeys(true);
    store.getState().setCapturingKey('quit');
    store.getState().toggleKeys(false);
    expect(store.getState()).toMatchObject({ keysOpen: false, capturingKey: undefined });

    store.getState().toggleKeys(true);
    store.getState().toggleSettings(false);
    expect(store.getState().keysOpen).toBe(false);
    // and it does not come back with the card
    store.getState().toggleSettings(true);
    expect(store.getState().keysOpen).toBe(false);

    // the side card takes the settings' place, which takes the editor with them
    store.getState().toggleKeys(true);
    store.getState().toggleSideCard(true);
    expect(store.getState().keysOpen).toBe(false);
  });
  it('keeps the shell info whether or not the chords come with it', () => {
    const store = createAppStore(memStorage());
    store.getState().setShell(shellInfo());
    expect(store.getState().shell).toMatchObject({ home: '/h' });
    expect(store.getState().settings.bindings).toEqual({});
  });
  it('starts active and follows the shell', () => {
    const store = createAppStore();
    expect(store.getState().active).toBe(true);
    store.getState().setActive(false);
    expect(store.getState().active).toBe(false);
  });
  it('tracks open terminals', () => {
    const store = createAppStore();
    store.getState().termOpened('c1', { x: 0, y: 0, width: 10, height: 10 });
    store.getState().termMoved('c1', { x: 1, y: 1, width: 10, height: 10 });
    expect(store.getState().terminals.c1).toEqual({ id: 'c1', rect: { x: 1, y: 1, width: 10, height: 10 } });
    store.getState().termGone('c1');
    expect(store.getState().terminals).toEqual({});
  });
  it('defaults to the map and remembers the last view', () => {
    const storage = memStorage();
    expect(createAppStore(storage).getState().view).toBe('map');
    const s = createAppStore(storage);
    s.getState().setView('board');
    expect(storage.view).toBe('board');
    expect(createAppStore(storage).getState().view).toBe('board');
    s.getState().setView('map');
    expect(storage.view).toBe('map');
    expect(createAppStore(storage, 'board').getState().view).toBe('board');
  });
  it('card and island selection', () => {
    const s = createAppStore();
    s.getState().setFleet(fleet());
    s.getState().focus('c1');
    expect(s.getState()).toMatchObject({ view: 'map', card: 'c1', focusedId: 'c1', selectedId: 'c1' });
    s.getState().toggleCardSize();
    expect(s.getState().cardSize).toBe('full');
    s.getState().selectIsland('i_a');
    expect(s.getState()).toMatchObject({ selectedIslandId: 'i_a', selectedId: undefined, sideCardOpen: true });
    s.getState().select('c0');
    expect(s.getState().selectedIslandId).toBeUndefined();
    s.getState().focus('c0');
    s.getState().setView('board');
    expect(s.getState().card).toBeUndefined();
    s.getState().showToast('nope');
    expect(s.getState().toast).toEqual({ text: 'nope', tone: 'error' });
    s.getState().showToast('on its way', 'ok');
    expect(s.getState().toast).toEqual({ text: 'on its way', tone: 'ok' });
    s.getState().clearToast();
    expect(s.getState().toast).toBeUndefined();
  });

  it('drops the card when its character disappears', () => {
    const s = createAppStore();
    s.getState().setFleet(fleet());
    s.getState().focus('c1');
    s.getState().applyPatch([{ op: 'remove', path: '/characters/c1' }]);
    expect(s.getState().card).toBeUndefined();
    s.getState().focus('c0');
    const next = fleet();
    delete next.characters.c0;
    s.getState().setFleet(next);
    expect(s.getState().card).toBeUndefined();
  });

  it('clears the selection when its character disappears', () => {
    const s = createAppStore();
    s.getState().setFleet(fleet());
    s.getState().select('c1');
    s.getState().applyPatch([{ op: 'remove', path: '/characters/c1' }]);
    expect(s.getState().selectedId).toBeUndefined();
    s.getState().select('c0');
    const next = fleet();
    delete next.characters.c0;
    s.getState().setFleet(next);
    expect(s.getState().selectedId).toBeUndefined();
  });

  it('remembers the sidebar and the half card', () => {
    const storage = memStorage();
    const store = createAppStore(storage);
    expect(store.getState().sidebarOpen).toBe(true);
    store.getState().toggleSidebar();
    expect(storage.sidebar).toBe(false);
    store.getState().setHalfCard({ w: 0.7, h: 0.4 });
    expect(storage.half).toEqual({ w: 0.7, h: 0.4 });
    expect(createAppStore(storage).getState()).toMatchObject({ sidebarOpen: false, halfCard: { w: 0.7, h: 0.4 } });
  });

  it('holds the resources columns inside their range, and writes them only when asked', () => {
    const storage = memStorage();
    const store = createAppStore(storage);
    store.getState().setResourceCols({ rail: 200, list: 9000 }, false);
    expect(store.getState().resourceCols).toEqual({ rail: 200, list: RESOURCE_COL_RANGE.list.max });
    expect(storage.cols).toBeUndefined();
    store.getState().setResourceCols(store.getState().resourceCols);
    expect(createAppStore(storage).getState().resourceCols).toEqual({ rail: 200, list: RESOURCE_COL_RANGE.list.max });
  });

  it('holds the sidebar widths inside their range, and writes them only when asked', () => {
    const storage = memStorage();
    const store = createAppStore(storage);
    store.getState().setSideWidths({ sidebar: 300, card: 9000 }, false);
    expect(store.getState().sideWidths).toEqual({ sidebar: 300, card: SIDE_WIDTH_RANGE.card.max });
    expect(storage.sides).toBeUndefined();
    store.getState().setSideWidths(store.getState().sideWidths);
    expect(createAppStore(storage).getState().sideWidths).toEqual({ sidebar: 300, card: SIDE_WIDTH_RANGE.card.max });
  });

  it('remembers the files tree folded or shown, and its width inside its range once written', () => {
    const storage = memStorage();
    const store = createAppStore(storage);
    expect(store.getState().filesTree).toEqual({ open: true });
    store.getState().toggleFilesTree();
    expect(storage.tree).toEqual({ open: false });
    store.getState().toggleFilesTree();
    expect(storage.tree).toEqual({ open: true });
    store.getState().setFilesTreeWidth(9000, false);
    expect(store.getState().filesTree).toEqual({ open: true, width: FILES_TREE_RANGE.max });
    expect(storage.tree).toEqual({ open: true });
    store.getState().setFilesTreeWidth(300);
    store.getState().toggleFilesTree(false);
    expect(createAppStore(storage).getState().filesTree).toEqual({ open: false, width: 300 });
  });

  it('remembers the settings', () => {
    const storage = memStorage();
    const store = createAppStore(storage);
    expect(store.getState().settings).toEqual(DEFAULT_SETTINGS);
    store.getState().setSettings({ cardOpacity: 0.5 });
    store.getState().setSettings({ zoom: 1.25 });
    expect(storage.settings).toEqual({ ...DEFAULT_SETTINGS, cardOpacity: 0.5, zoom: 1.25 });
    expect(createAppStore(storage).getState().settings).toEqual({ ...DEFAULT_SETTINGS, cardOpacity: 0.5, zoom: 1.25 });
  });

  it('the corner shows one panel at a time, so opening the phone link puts the usage away', () => {
    const store = createAppStore();
    store.getState().toggleUsage();
    expect(store.getState()).toMatchObject({ usageOpen: true, mobileOpen: false });
    store.getState().toggleMobile();
    expect(store.getState()).toMatchObject({ usageOpen: false, mobileOpen: true });
    store.getState().toggleMobile(false);
    expect(store.getState()).toMatchObject({ usageOpen: false, mobileOpen: false });
  });

  it('keeps the phone panel through turning the link off, and puts it away with the tab it hangs from', () => {
    const store = createAppStore();
    store.getState().setMobile({ serving: true, url: 'https://mac.ts.net:8443/', port: 8443, logins: [], phones: [] });
    store.getState().toggleMobile();
    expect(store.getState().mobileOpen).toBe(true);
    // the switch that turned it off is in the panel, which stays to turn it back on
    store.getState().setMobile({ serving: false, url: '', port: 8443, logins: [], phones: [] });
    expect(store.getState().mobileOpen).toBe(true);
    store.getState().setMobile({ serving: false, url: '', port: 8443, logins: [], phones: [], error: 'tailscale is not installed' });
    expect(store.getState().mobileOpen).toBe(false);
  });

  it('moves the phones onto the link it already holds, and waits for one when it holds none', () => {
    const store = createAppStore();
    const here = [{ login: 'me@example.com', since: 1 }];
    store.getState().setPhones(here);
    expect(store.getState().mobile).toBeUndefined();
    store.getState().setMobile({ serving: true, url: 'https://mac.ts.net:8443/', port: 8443, logins: [], phones: [] });
    store.getState().setPhones(here);
    expect(store.getState().mobile?.phones).toEqual(here);
  });

  it('the settings and the side card share one place, so opening the side card puts the settings away', () => {
    const store = createAppStore();
    store.getState().toggleSettings();
    expect(store.getState().settingsOpen).toBe(true);
    store.getState().toggleSideCard(true);
    expect(store.getState()).toMatchObject({ settingsOpen: false, sideCardOpen: true });
  });

  it('toggling the side card over the settings shows it, even when it was open underneath', () => {
    const store = createAppStore(undefined, 'board');
    store.getState().toggleSettings();
    store.getState().toggleSideCard();
    expect(store.getState()).toMatchObject({ settingsOpen: false, sideCardOpen: true, sideCardCollapsed: false });
  });

  it('the board opens the side card, and a collapse survives the switch', () => {
    const store = createAppStore(undefined, 'board');
    expect(store.getState().sideCardOpen).toBe(true);
    store.getState().toggleSideCard();
    store.getState().setView('map');
    store.getState().setView('board');
    expect(store.getState().sideCardOpen).toBe(false);
  });

  it('tracks native browser views by tab', () => {
    const store = createAppStore();
    const rect = { x: 0, y: 0, width: 10, height: 10 };
    store.getState().webviewOpened('t_1', rect);
    expect(store.getState().webviews.t_1).toEqual({ tab: 't_1', rect, url: '', title: '', loading: false, canGoBack: false, canGoForward: false });
    store.getState().webviewState('t_1', { url: 'https://a.test/', title: 'A', loading: true });
    store.getState().webviewMoved('t_1', { ...rect, width: 20 });
    expect(store.getState().webviews.t_1).toMatchObject({ url: 'https://a.test/', title: 'A', loading: true, rect: { ...rect, width: 20 } });
    // state for a view that was never opened is dropped, not created
    store.getState().webviewState('t_9', { title: 'x' });
    expect(store.getState().webviews.t_9).toBeUndefined();
    store.getState().webviewGone('t_1');
    expect(store.getState().webviews).toEqual({});
  });

  it('keeps panes per character, starts each on one terminal, and counts address-bar focus requests', () => {
    const store = createAppStore(memStorage());
    store.getState().setFleet(fleet());
    expect(panesOf(store.getState(), 'c1')).toEqual({ left: 'terminal' });
    store.getState().setPanes('c1', { left: 'terminal', right: 'browser' });
    store.getState().setRatio('c1', 0.6);
    expect(panesOf(store.getState(), 'c1')).toEqual({ left: 'terminal', right: 'browser' });
    expect(store.getState().ide.c1.ratio).toBe(0.6);
    // a drag that lands on the same ratio changes nothing, so nothing subscribed to the pane re-renders
    const held = store.getState().ide.c1;
    store.getState().setRatio('c1', 0.6);
    expect(store.getState().ide.c1).toBe(held);
    // panes are the character's own: another one is still on its terminal
    expect(panesOf(store.getState(), 'c2')).toEqual({ left: 'terminal' });
    expect(store.getState().addressFocus).toBe(false);
    store.getState().focusAddress();
    expect(store.getState().addressFocus).toBe(true);
    store.getState().addressFocused();
    expect(store.getState().addressFocus).toBe(false);
  });

  it('closes a pane that was showing a second terminal when the fleet drops it', () => {
    const store = createAppStore();
    const second = { tmux: { windowId: '@2', paneId: '%2' }, unread: false };
    const withSecond = fleet();
    withSecond.characters.c1 = { ...withSecond.characters.c1, second };
    store.getState().setFleet(withSecond);
    store.getState().setPanes('c1', { left: 'terminal', right: 'terminal2' });
    store.getState().setPanes('c0', { left: 'terminal', right: 'terminal2' });
    store.getState().setFleet(fleet());
    expect(panesOf(store.getState(), 'c1')).toEqual({ left: 'terminal' });
    // c0 never had one: its pane is waiting for the terminal to start, and stays
    expect(panesOf(store.getState(), 'c0')).toEqual({ left: 'terminal', right: 'terminal2' });
    store.getState().setFleet(withSecond);
    store.getState().setPanes('c1', { left: 'terminal2' });
    store.getState().setFleet(fleet());
    expect(panesOf(store.getState(), 'c1')).toEqual({ left: 'terminal' });
  });
  it('closes that pane when the second terminal goes in a patch', () => {
    const store = createAppStore();
    const withSecond = fleet();
    withSecond.characters.c1 = { ...withSecond.characters.c1, second: { tmux: { windowId: '@2', paneId: '%2' }, unread: false } };
    store.getState().setFleet(withSecond);
    store.getState().setPanes('c1', { left: 'terminal', right: 'terminal2' });
    store.getState().applyPatch([{ op: 'remove', path: '/characters/c1/second' }]);
    expect(store.getState().fleet.characters.c1.second).toBeUndefined();
    expect(panesOf(store.getState(), 'c1')).toEqual({ left: 'terminal' });
  });
  it('keeps open files and folders per character, and forgets a character that goes', () => {
    const store = createAppStore();
    store.getState().setFleet(fleet());
    const s = () => store.getState();
    expect(s().ide.c1).toBeUndefined();
    s().openFile('c1', 'src/a.ts');
    s().openFile('c1', 'src/b.ts');
    s().openFile('c1', 'src/a.ts');
    expect(s().ide.c1).toMatchObject({ open: ['src/a.ts', 'src/b.ts'], active: 'src/a.ts' });
    s().toggleFolder('c1', 'src');
    expect(s().ide.c1.expanded).toEqual(['src']);
    s().toggleFolder('c1', 'src');
    expect(s().ide.c1.expanded).toEqual([]);
    s().markFile('c1', 'src/a.ts', { dirty: true });
    s().markFile('c1', 'src/a.ts', { conflict: true });
    expect(s().ide.c1).toMatchObject({ dirty: ['src/a.ts'], conflict: ['src/a.ts'] });
    // every keystroke marks the file again; a mark that changes nothing renders nothing
    const marked = s().ide;
    s().markFile('c1', 'src/a.ts', { dirty: true });
    s().markFile('c1', 'src/b.ts', { dirty: false });
    expect(s().ide).toBe(marked);
    s().markFile('c1', 'src/a.ts', { dirty: false, conflict: false });
    expect(s().ide.c1).toMatchObject({ dirty: [], conflict: [] });
    // closing the active file activates its neighbour on the left, the first one on the right
    s().closeFile('c1', 'src/a.ts');
    expect(s().ide.c1).toMatchObject({ open: ['src/b.ts'], active: 'src/b.ts' });
    s().closeFile('c1', 'src/b.ts');
    expect(s().ide.c1).toMatchObject({ open: [], active: undefined });
    s().applyPatch([{ op: 'remove', path: '/characters/c1' }]);
    expect(s().ide.c1).toBeUndefined();
    expect(s().ide.c0).toBeUndefined();
  });
  it('opens the settings on a machine that has none of its own, once', () => {
    const storage = memStorage();
    const store = createAppStore(storage);
    expect(store.getState().settingsOpen).toBe(true);
    // a launch that only asks spends nothing: the answer is the card being closed
    expect(storage.settings).toBeUndefined();
    store.getState().setFleet(fleet());
    store.getState().toggleSettings(false);
    expect(storage.settings).toEqual(DEFAULT_SETTINGS);
    expect(createAppStore(storage).getState().settingsOpen).toBe(false);
    // nowhere to remember the answer: a page without a store is not asked every load
    expect(createAppStore().getState().settingsOpen).toBe(false);
  });
  it('a card the fleet never arrived under has not been answered', () => {
    const storage = memStorage();
    const store = createAppStore(storage);
    // the connect screen stands where the card would be, so there was nothing on screen to close
    store.getState().toggleSettings(false);
    expect(storage.settings).toBeUndefined();
    expect(createAppStore(storage).getState().settingsOpen).toBe(true);
  });
  it('a closed settings card writes the settings it shows, on any launch', () => {
    const storage = memStorage();
    const store = createAppStore(storage);
    store.getState().setFleet(fleet());
    store.getState().setSettings({ zoom: 1.1 });
    store.getState().toggleSettings(false);
    expect(storage.settings).toEqual({ ...DEFAULT_SETTINGS, zoom: 1.1 });
    const later = createAppStore(storage);
    later.getState().setFleet(fleet());
    later.getState().toggleSettings(false);
    expect(storage.settings).toEqual({ ...DEFAULT_SETTINGS, zoom: 1.1 });
  });
});

const source = (rootId: string): ResourceSource =>
  ({ rootId, root: rootId.slice(2), name: rootId, tier: 'repo', islandIds: [], characterIds: [], groups: [] });

describe('resources', () => {
  it('opens on the map with the filter it is given, and keeps the last filter otherwise', () => {
    const store = createAppStore(undefined, 'board');
    store.getState().setFleet(fleet());
    store.getState().toggleResources(true, { what: 'skills' });
    expect(store.getState()).toMatchObject({ resourcesOpen: true, resourcesWhat: 'skills', view: 'map' });
    store.getState().toggleResources(false);
    store.getState().toggleResources();
    expect(store.getState()).toMatchObject({ resourcesOpen: true, resourcesWhat: 'skills' });
  });
  it('closes the corner panels as it opens, and says when a close leaves the keyboard on the page', () => {
    const store = createAppStore();
    store.getState().toggleUsage(true);
    store.getState().toggleResources(true);
    expect(store.getState().usageOpen).toBe(false);
    store.getState().toggleResources(false, { keepPageFocus: true });
    expect(store.getState()).toMatchObject({ resourcesOpen: false, keepPageFocus: true });
  });
  it('closes with the map, so the board is never veiled by a shelf that is not there', () => {
    const store = createAppStore();
    store.getState().setFleet(fleet());
    store.getState().toggleResources(true);
    store.getState().setView('board');
    expect(store.getState().resourcesOpen).toBe(false);
    expect(isVeiled(store.getState())).toBe(false);
  });
  it('lets go of a where whose source is no longer listed', () => {
    const store = createAppStore();
    store.getState().setResources([source('r:/a'), source('r:/b')]);
    store.getState().setResourcesFilter({ where: 'r:/b' });
    store.getState().setResources([source('r:/a')]);
    expect(store.getState().resourcesWhere).toBeUndefined();
    store.getState().setResourcesFilter({ where: 'r:/a' });
    store.getState().setResources([source('r:/a')]);
    expect(store.getState().resourcesWhere).toBe('r:/a');
  });
  it('falls back to All when the source it moves to is offered no such kind', () => {
    const store = createAppStore();
    const isle = { ...source('r:/d/islands/i1'), tier: 'island' as const, islandIds: ['i1'] };
    store.getState().setResources([isle, source('r:/a')]);
    store.getState().setResourcesFilter({ where: isle.rootId, what: 'agentInstructions' });
    expect(store.getState().resourcesWhat).toBe('agentInstructions');
    store.getState().setResourcesFilter({ where: 'r:/a' });
    expect(store.getState().resourcesWhat).toBe('all');
    // a kind every source is offered rides along untouched
    store.getState().setResourcesFilter({ where: isle.rootId, what: 'skills' });
    store.getState().setResourcesFilter({ where: 'r:/a' });
    expect(store.getState().resourcesWhat).toBe('skills');
  });
  it('stays open when a corner panel closes', () => {
    const store = createAppStore();
    store.getState().toggleResources(true);
    store.getState().toggleUsage(false);
    store.getState().toggleMobile(false);
    expect(store.getState().resourcesOpen).toBe(true);
  });
  it('keeps a resource root editor state when the fleet changes', () => {
    const store = createAppStore();
    store.getState().setFleet(fleet());
    store.getState().openFile('r:/h/.claude', 'CLAUDE.md');
    store.getState().openFile('gone', 'a.ts');
    store.getState().setFleet(fleet());
    expect(Object.keys(store.getState().ide)).toEqual(['r:/h/.claude']);
  });
  it('remembers which resource file is showing', () => {
    const store = createAppStore();
    store.getState().openFile('r:/h/.claude', 'CLAUDE.md');
    store.getState().openFile('c1', 'a.ts');
    expect(store.getState().resourcesShown).toEqual({ rootId: 'r:/h/.claude', path: 'CLAUDE.md' });
  });
});

describe('resourcesNaming', () => {
  it('is set by opening the shelf to start a doc, and cleared once the field has taken it', () => {
    const store = createAppStore();
    store.getState().toggleResources(true, { where: 'r:/d/islands/i1', what: 'docs', naming: true });
    expect(store.getState().resourcesNaming).toBe(true);
    store.getState().setResourcesNaming(false);
    expect(store.getState().resourcesNaming).toBe(false);
    store.getState().toggleResources(true, { where: 'r:/d/islands/i1' });
    expect(store.getState().resourcesNaming).toBe(false);
  });
});

describe('toast action', () => {
  it('carries an action, and running it clears the toast', () => {
    const store = createAppStore();
    let ran = 0;
    store.getState().showToast('Deleted plan', 'ok', { label: 'Undo', run: () => { ran++; } });
    expect(store.getState().toast).toMatchObject({ text: 'Deleted plan', tone: 'ok', action: { label: 'Undo' } });
    store.getState().runToastAction();
    expect(ran).toBe(1);
    expect(store.getState().toast).toBeUndefined();
  });
  it('does nothing when the toast has no action', () => {
    const store = createAppStore();
    store.getState().showToast('Copied', 'ok');
    store.getState().runToastAction();
    expect(store.getState().toast).toMatchObject({ text: 'Copied' });
  });
});

describe('resource groups', () => {
  const source = (tier: 'global' | 'fleet' | 'repo' | 'island' | 'character', rootId: string) => ({ rootId, root: rootId.slice(2), name: rootId, tier, islandIds: [], characterIds: [], groups: [] });
  const memory = () => { let kept: unknown; return { get: () => kept, storage: { ...memStorage(), getResourceGroups: () => kept, setResourceGroups: (v: unknown) => { kept = v; } } }; };

  it('opens with Global and Fleet, toggles a group, and keeps the open set across a reload', () => {
    const m = memory();
    const store = createAppStore(m.storage as never);
    expect(store.getState().resourceGroups).toEqual(['global', 'fleet']);
    store.getState().toggleResourceGroup('island');
    store.getState().toggleResourceGroup('global');
    expect(store.getState().resourceGroups).toEqual(['fleet', 'island']);
    expect(createAppStore(m.storage as never).getState().resourceGroups).toEqual(['fleet', 'island']);
  });
  it('opens the group of a source it is sent to', () => {
    const store = createAppStore();
    store.getState().setResources([source('global', 'r:/c'), source('character', 'r:/d/characters/c1')]);
    store.getState().setResourcesFilter({ where: 'r:/d/characters/c1' });
    expect(store.getState().resourceGroups).toEqual(['global', 'fleet', 'character']);
    store.getState().toggleResourceGroup('global');
    store.getState().toggleResources(true, { where: 'r:/c' });
    expect(store.getState().resourceGroups.sort()).toEqual(['character', 'fleet', 'global']);
  });
  it('opens the fleet for a user whose saved groups predate it, once the shelf is sent there', () => {
    const m = memory();
    m.storage.setResourceGroups(['global']);
    const store = createAppStore(m.storage as never);
    expect(store.getState().resourceGroups).toEqual(['global']);
    store.getState().setResources([source('global', 'r:/c'), source('fleet', 'r:/h/docs/fleet')]);
    store.getState().toggleResources(true, { where: 'r:/h/docs/fleet' });
    expect(store.getState().resourceGroups).toEqual(['global', 'fleet']);
  });
});
