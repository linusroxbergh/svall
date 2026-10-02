import type { MobileStatus, PhoneSession } from '@svall/protocol';
import type { StateCreator } from 'zustand/vanilla';
import type { NotifyPermission, Rect, ShellInfo } from '../bridge.js';
import type { DropTarget } from '../drop.js';
import { declineTaken, type ActionId } from '../keys.js';
import { boardViewed } from '../selectors.js';
import { DEFAULT_SETTINGS, type Settings } from '../settings.js';
import type { App } from './index.js';
import { clampSides, clampTree, DEFAULT_HALF_CARD, DEFAULT_SIDE_WIDTHS, type AppStorage, type FilesTree, type HalfCard, type SideWidths } from './persist.js';

export type View = 'map' | 'board';
export type CardSize = 'half' | 'full';
export type Terminal = { id: string; rect: Rect };
// one native browser view the shell holds for a tab, and what it last reported about the page
export type Webview = { tab: string; rect: Rect; url: string; title: string; loading: boolean; canGoBack: boolean; canGoForward: boolean; error?: string };
// a toast either reports a refusal or confirms something the user set going; an action is the one thing it offers to take back
export type Toast = { text: string; tone: 'error' | 'ok'; action?: { label: string; run(): void } };
// a link waiting by the pointer for the user to say where it should open; one from a terminal names the surface the keys go back to
export type LinkAsk = { url: string; charId: string; x: number; y: number; surface?: string };

export type UiState = {
  view: View;
  focusedId?: string;
  selectedId?: string;
  selectedIslandId?: string;
  sideCardOpen: boolean;
  sideCardCollapsed: boolean;
  namingCharacter: boolean;
  missionPrompt: boolean;
  closingCharacter?: string;
  deletingIsland?: string;
  // the picker of fleets: on a bare launch another fleet takes this window's place, from the menu it opens beside it
  fleetPicker?: 'bare' | 'menu';
  card?: string;
  cardSize: CardSize;
  active: boolean;
  terminals: Record<string, Terminal>;
  terminalErrors: Record<string, string>;
  webviews: Record<string, Webview>;
  // ⌘L asks for the address bar; the pane that answers clears the request
  addressFocus: boolean;
  // ⌘⇧A asks for an arrange, and a return from the board for an automatic one; the map, which knows the room
  // the fleet has, clears the request
  arrangeAsk: 'key' | 'auto' | false;
  toast?: Toast;
  linkAsk?: LinkAsk;
  configErrors: string[];
  shell?: ShellInfo;
  sidebarOpen: boolean;
  settingsOpen: boolean;
  // the shortcut editor, over the middle of the screen, opened from the settings card
  keysOpen: boolean;
  // the action whose chord the shortcut editor is waiting for; while it is set, keys are read, not obeyed
  capturingKey?: ActionId;
  usageOpen: boolean;
  mobileOpen: boolean;
  mobile?: MobileStatus;
  // a panel closed by a click into the page leaves the keyboard where the click put it, so the
  // surface coming back out from under it does not take it
  keepPageFocus: boolean;
  settings: Settings;
  halfCard: HalfCard;
  sideWidths: SideWidths;
  filesTree: FilesTree;
  dropHover?: DropTarget;
  // what macOS allows for banners, as the shell last read it
  notifyPermission: NotifyPermission;
  // the version a scheduled check found, until the user has looked at it in Sparkle's window
  update?: string;
};

export type UiActions = {
  setActive(active: boolean): void;
  setView(view: View): void;
  select(id?: string, card?: boolean): void;
  selectIsland(id?: string): void;
  focus(id: string): void;
  closeCard(): void;
  toggleCardSize(): void;
  toggleSideCard(open?: boolean): void;
  setNamingCharacter(open: boolean): void;
  setMissionPrompt(open: boolean): void;
  setClosingCharacter(id?: string): void;
  setDeletingIsland(id?: string): void;
  setFleetPicker(mode?: 'bare' | 'menu'): void;
  termOpened(id: string, rect: Rect): void;
  termMoved(id: string, rect: Rect): void;
  termGone(id: string): void;
  termFailed(id: string, message: string): void;
  termRetry(id: string): void;
  webviewOpened(tab: string, rect: Rect): void;
  webviewMoved(tab: string, rect: Rect): void;
  webviewState(tab: string, patch: Partial<Omit<Webview, 'tab' | 'rect'>>): void;
  webviewGone(tab: string): void;
  focusAddress(): void;
  addressFocused(): void;
  askArrange(): void;
  arranged(): void;
  showToast(message: string, tone?: Toast['tone'], action?: Toast['action']): void;
  runToastAction(): void;
  clearToast(): void;
  askLink(ask: LinkAsk): void;
  closeLinkAsk(): void;
  setConfigErrors(errors: string[]): void;
  setShell(info: ShellInfo): void;
  setNotifyPermission(p: NotifyPermission): void;
  setUpdate(version?: string): void;
  setCapturingKey(id?: ActionId): void;
  toggleSidebar(open?: boolean): void;
  toggleSettings(open?: boolean): void;
  toggleKeys(open?: boolean): void;
  toggleUsage(open?: boolean, opts?: { keepPageFocus?: boolean }): void;
  toggleMobile(open?: boolean, opts?: { keepPageFocus?: boolean }): void;
  setMobile(status?: MobileStatus): void;
  setPhones(phones: PhoneSession[]): void;
  pageFocusSettled(): void;
  setSettings(patch: Partial<Settings>): void;
  setHalfCard(size: HalfCard, persist?: boolean): void;
  setSideWidths(widths: SideWidths, persist?: boolean): void;
  toggleFilesTree(open?: boolean): void;
  setFilesTreeWidth(width: number, persist?: boolean): void;
  setDropHover(t?: DropTarget): void;
};

export const createUiSlice = (storage: AppStorage | undefined, view: View): StateCreator<App, [], [], UiState & UiActions> => (set, get) => {
  // a machine with no settings of its own has never had them in front of it: the card opens with the
  // fleet, and closing it is what writes them and keeps the asking to that one launch
  const firstRun = storage !== undefined && storage.getSettings() === undefined;
  // the collision check belongs to that same launch: after it, what is written down is the user's answer
  let checkGhosttyKeys = firstRun;
  return {
    view,
    focusedId: storage?.getFocus(),
    selectedId: undefined,
    selectedIslandId: undefined,
    // the board reads a character and its card together; the map opens the card on demand
    sideCardOpen: view === 'board',
    sideCardCollapsed: false,
    namingCharacter: false,
    missionPrompt: false,
    closingCharacter: undefined,
    deletingIsland: undefined,
    card: undefined,
    cardSize: 'half',
    active: true,
    terminals: {},
    terminalErrors: {},
    webviews: {},
    addressFocus: false,
    arrangeAsk: false,
    toast: undefined,
    linkAsk: undefined,
    configErrors: [],
    notifyPermission: 'unknown',
    update: undefined,
    sidebarOpen: storage?.getSidebarOpen() ?? true,
    settingsOpen: firstRun,
    keysOpen: false,
    capturingKey: undefined,
    usageOpen: false,
    mobileOpen: false,
    mobile: undefined,
    keepPageFocus: false,
    settings: storage?.getSettings() ?? DEFAULT_SETTINGS,
    halfCard: storage?.getHalfCard() ?? DEFAULT_HALF_CARD,
    sideWidths: storage?.getSideWidths() ?? DEFAULT_SIDE_WIDTHS,
    filesTree: storage?.getFilesTree() ?? { open: true },
    dropHover: undefined,
    setActive: (active) => set({ active }),
    // the board's character comes to the map in its card
    setView: (v) => {
      storage?.setView(v);
      const s = get();
      const carried = v === 'map' && s.view === 'board' ? boardViewed(s) : undefined;
      // the shelf lies on the map and is mounted with it, so a view that leaves takes it along
      set({ view: v, card: v === 'map' ? s.card : undefined, sideCardOpen: v === 'board' ? !s.sideCardCollapsed : s.sideCardOpen, resourcesOpen: v === 'map' && s.resourcesOpen,
        ...(v === 'map' && s.view === 'board' && s.settings.autoArrange && { arrangeAsk: 'auto' as const }) });
      if (!carried) return;
      get().focus(carried);
    },
    select: (id, card) => set((s) => ({ selectedId: id, selectedIslandId: undefined, sideCardOpen: (card ?? id !== undefined) && !s.sideCardCollapsed })),
    selectIsland: (id) => set((s) => ({ selectedIslandId: id, selectedId: undefined, sideCardOpen: id !== undefined && !s.sideCardCollapsed })),
    // on the map a character's terminal is its card; on the board it is the terminal the board already shows
    focus: (id) => {
      storage?.setFocus(id);
      set((s) => s.view === 'board'
        ? { focusedId: id, selectedId: id, selectedIslandId: undefined }
        : { card: id, focusedId: id, selectedId: id, selectedIslandId: undefined });
    },
    closeCard: () => set({ card: undefined }),
    toggleCardSize: () => set((s) => ({ cardSize: s.cardSize === 'half' ? 'full' : 'half' })),
    setNamingCharacter: (open) => set({ namingCharacter: open }),
    setMissionPrompt: (open) => set({ missionPrompt: open }),
    setClosingCharacter: (id) => set({ closingCharacter: id }),
    setDeletingIsland: (id) => set({ deletingIsland: id }),
    setFleetPicker: (mode) => set({ fleetPicker: mode }),
    toggleSideCard: (open) => set((s) => { const next = open ?? (s.settingsOpen || !s.sideCardOpen); return { sideCardOpen: next, sideCardCollapsed: !next, settingsOpen: false, keysOpen: false, capturingKey: undefined }; }),
    termOpened: (id, rect) => set((s) => ({ terminals: { ...s.terminals, [id]: { id, rect } } })),
    termMoved: (id, rect) => set((s) => (s.terminals[id] ? { terminals: { ...s.terminals, [id]: { ...s.terminals[id], rect } } } : {})),
    termGone: (id) => set((s) => { const terminals = { ...s.terminals }; delete terminals[id]; return { terminals }; }),
    termFailed: (id, message) => set((s) => ({ terminalErrors: { ...s.terminalErrors, [id]: message } })),
    termRetry: (id) => set((s) => { const terminalErrors = { ...s.terminalErrors }; delete terminalErrors[id]; return { terminalErrors }; }),
    webviewOpened: (tab, rect) => set((s) => ({ webviews: { ...s.webviews, [tab]: { tab, rect, url: '', title: '', loading: false, canGoBack: false, canGoForward: false } } })),
    webviewMoved: (tab, rect) => set((s) => (s.webviews[tab] ? { webviews: { ...s.webviews, [tab]: { ...s.webviews[tab], rect } } } : {})),
    webviewState: (tab, patch) => set((s) => (s.webviews[tab] ? { webviews: { ...s.webviews, [tab]: { ...s.webviews[tab], ...patch } } } : {})),
    webviewGone: (tab) => set((s) => { const webviews = { ...s.webviews }; delete webviews[tab]; return { webviews }; }),
    focusAddress: () => set({ addressFocus: true }),
    addressFocused: () => set({ addressFocus: false }),
    askArrange: () => set({ arrangeAsk: 'key' }),
    arranged: () => set({ arrangeAsk: false }),
    showToast: (message, tone = 'error', action) => set({ toast: { text: message, tone, ...(action && { action }) } }),
    runToastAction: () => { const a = get().toast?.action; if (!a) return; set({ toast: undefined }); a.run(); },
    clearToast: () => set({ toast: undefined }),
    askLink: (linkAsk) => set({ linkAsk }),
    closeLinkAsk: () => set({ linkAsk: undefined }),
    setConfigErrors: (errors) => set({ configErrors: errors }),
    setCapturingKey: (capturingKey) => set({ capturingKey }),
    setShell: (shell) => set((s) => {
      if (!checkGhosttyKeys || !shell.ghosttyKeys) return { shell };
      checkGhosttyKeys = false;
      return { shell, settings: { ...s.settings, bindings: declineTaken(shell.ghosttyKeys, s.settings.bindings) } };
    }),
    setNotifyPermission: (notifyPermission) => set({ notifyPermission }),
    setUpdate: (update) => set({ update }),
    toggleSidebar: (open) => set((s) => { const next = open ?? !s.sidebarOpen; storage?.setSidebarOpen(next); return { sidebarOpen: next }; }),
    toggleSettings: (open) => set((s) => {
      const next = open ?? !s.settingsOpen;
      // a card that closes has been answered, and what it leaves behind is this machine's settings;
      // before the fleet arrives the connect screen stands in its place, and closes nobody saw answer nothing
      if (!next && s.loaded) storage?.setSettings(s.settings);
      // a card that goes takes the shortcut editor with it, and must not leave the keyboard listening
      return { settingsOpen: next, usageOpen: next ? false : s.usageOpen, mobileOpen: next ? false : s.mobileOpen,
        keepPageFocus: next && (s.usageOpen || s.mobileOpen) ? true : s.keepPageFocus,
        keysOpen: next && s.keysOpen, capturingKey: next ? s.capturingKey : undefined };
    }),
    toggleKeys: (open) => set((s) => { const next = open ?? !s.keysOpen; return { keysOpen: next, capturingKey: next ? s.capturingKey : undefined }; }),
    // the dock has one open utility at a time; leaving first-run settings still records the answer
    toggleUsage: (open, opts) => set((s) => {
      const next = open ?? !s.usageOpen;
      if (next && s.settingsOpen && s.loaded) storage?.setSettings(s.settings);
      return { usageOpen: next, mobileOpen: false, settingsOpen: next ? false : s.settingsOpen,
        keysOpen: next ? false : s.keysOpen, capturingKey: next ? undefined : s.capturingKey,
        resourcesOpen: next ? false : s.resourcesOpen, keepPageFocus: opts?.keepPageFocus ?? false };
    }),
    toggleMobile: (open, opts) => set((s) => {
      const next = open ?? !s.mobileOpen;
      if (next && s.settingsOpen && s.loaded) storage?.setSettings(s.settings);
      return { mobileOpen: next, usageOpen: false, settingsOpen: next ? false : s.settingsOpen,
        keysOpen: next ? false : s.keysOpen, capturingKey: next ? undefined : s.capturingKey,
        resourcesOpen: next ? false : s.resourcesOpen, keepPageFocus: opts?.keepPageFocus ?? false };
    }),
    // the panel carries the switch, so it stays open across turning the link off; only a link that cannot be made at all shuts it
    setMobile: (mobile) => set((s) => ({ mobile, mobileOpen: mobile && !mobile.error ? s.mobileOpen : false })),
    // the daemon says who is on the page as they come and go; the rest of the status stands
    setPhones: (phones) => set((s) => (s.mobile ? { mobile: { ...s.mobile, phones } } : {})),
    pageFocusSettled: () => set((s) => (s.keepPageFocus ? { keepPageFocus: false } : {})),
    setSettings: (patch) => set((s) => { const settings = { ...s.settings, ...patch }; storage?.setSettings(settings); return { settings }; }),
    setHalfCard: (size, persist = true) => set(() => { if (persist) storage?.setHalfCard(size); return { halfCard: size }; }),
    setSideWidths: (widths, persist = true) => set(() => { const w = clampSides(widths); if (persist) storage?.setSideWidths(w); return { sideWidths: w }; }),
    toggleFilesTree: (open) => set((s) => { const t = { ...s.filesTree, open: open ?? !s.filesTree.open }; storage?.setFilesTree(t); return { filesTree: t }; }),
    setFilesTreeWidth: (width, persist = true) => set((s) => { const t = { ...s.filesTree, width: clampTree(width) }; if (persist) storage?.setFilesTree(t); return { filesTree: t }; }),
    // a Finder drag fires this on every mouse move; skip the render when the target has not changed
    setDropHover: (t) => set((s) => (s.dropHover?.kind === t?.kind && s.dropHover?.id === t?.id && s.dropHover?.after === t?.after ? {} : { dropHover: t })),
  };
};
