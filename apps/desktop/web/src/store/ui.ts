import type { FeedbackKind, MachineId, MobileStatus, PhoneSession } from '@svall/protocol';
import type { StateCreator } from 'zustand/vanilla';
import type { NotifyPermission, Rect, ShellInfo } from '../bridge.js';
import type { DropTarget } from '../drop.js';
import { declineTaken, type ActionId } from '../keys.js';
import { DEFAULT_SETTINGS, type Settings } from '../settings.js';
import type { App } from './index.js';
import { clampSides, clampTree, DEFAULT_HALF_CARD, DEFAULT_SIDE_WIDTHS, type AppStorage, type FilesTree, type HalfCard, type Section, type Sections, type SideWidths } from './persist.js';

export type View = 'map' | 'board';
export type CardSize = 'half' | 'full';
export type Terminal = { id: string; rect: Rect };
// one native browser view the shell holds for a tab, and what it last reported about the page
export type Webview = { tab: string; rect: Rect; url: string; title: string; loading: boolean; canGoBack: boolean; canGoForward: boolean; error?: string };
// a toast either reports a refusal or confirms something the user set going; an action is the one thing it offers to take back,
// and dismiss puts a Dismiss beside it
export type Toast = { text: string; tone: 'error' | 'ok'; action?: { label: string; run(): void }; dismiss?: boolean };
// a link waiting by the pointer for the user to say where it should open; one from a terminal names the surface the keys go back to
export type LinkAsk = { url: string; robotId: string; x: number; y: number; surface?: string };
// an entry with items opens them beside it, one with neither run nor items shows greyed out, and sep rules it off from those above
export type MenuEntry = { title: string; run?: () => void; danger?: boolean; items?: MenuEntry[]; checked?: boolean; note?: string; sep?: boolean };
// a button's own menu, bare, leaves out the page's Reload
export type PageMenu = { x: number; y: number; items: MenuEntry[]; bare?: boolean };
export type MoveAsk = { id: string; to?: MachineId };

export type FeedbackDraft = { kind: FeedbackKind; text: string; tick?: boolean };
const EMPTY_DRAFT: FeedbackDraft = { kind: 'bug', text: '' };

export type UiState = {
  view: View;
  focusedId?: string;
  selectedId?: string;
  selectedIslandId?: string;
  // the starred robot picked or walked to on its Starred row, so the robot keys go on from that row
  starredRow?: string;
  sideCardOpen: boolean;
  sideCardCollapsed: boolean;
  namingRobot: boolean;
  missionPrompt: boolean;
  closingRobot?: string;
  // a working robot's sleep waits on the user's answer
  sleepingRobot?: string;
  // the robot the move sheet is about, and the worker it goes to: none is this Mac
  moveSheet?: MoveAsk;
  deletingIsland?: string;
  // a board column with robots in it, whose delete waits on where they go
  deletingColumn?: string;
  // the picker of fleets: on a bare launch another fleet takes this window's place, from the keys it opens beside it;
  // new only makes one
  fleetPicker?: 'bare' | 'menu' | 'new';
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
  // a Place now pass is running, which the board's Auto-place chip shows
  placingNow: boolean;
  toast?: Toast;
  linkAsk?: LinkAsk;
  menu?: PageMenu;
  configErrors: string[];
  shell?: ShellInfo;
  sidebarOpen: boolean;
  // the sides ⌘⇧S hid, so the next press brings back those and no others
  hiddenSides?: { sidebar: boolean; card: boolean };
  settingsOpen: boolean;
  // the pane a control elsewhere opened the settings on, a new object each ask so a repeated one turns back to it
  settingsAsk?: { pane: string };
  // the action whose chord the settings' Keyboard pane is waiting for; while it is set, keys are read, not obeyed
  capturingKey?: ActionId;
  usageOpen: boolean;
  mobileOpen: boolean;
  loadOpen: boolean;
  feedbackOpen: boolean;
  // what the form holds, kept across the panel closing; a send clears it
  feedbackDraft: FeedbackDraft;
  mobile?: MobileStatus;
  // a panel closed by a click into the page leaves the keyboard where the click put it, so the
  // surface coming back out from under it does not take it
  keepPageFocus: boolean;
  settings: Settings;
  halfCard: HalfCard;
  sideWidths: SideWidths;
  filesTree: FilesTree;
  sections: Sections;
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
  setStarredRow(id?: string): void;
  closeCard(): void;
  toggleCardSize(): void;
  toggleSideCard(open?: boolean): void;
  setNamingRobot(open: boolean): void;
  setMissionPrompt(open: boolean): void;
  setClosingRobot(id?: string): void;
  setSleepingRobot(id?: string): void;
  setMoveSheet(ask?: MoveAsk): void;
  setDeletingIsland(id?: string): void;
  setDeletingColumn(id?: string): void;
  setFleetPicker(mode?: 'bare' | 'menu' | 'new'): void;
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
  setPlacingNow(busy: boolean): void;
  showToast(message: string, tone?: Toast['tone'], action?: Toast['action'], dismiss?: boolean): void;
  runToastAction(): void;
  clearToast(): void;
  askLink(ask: LinkAsk): void;
  closeLinkAsk(): void;
  openMenu(menu: PageMenu): void;
  closeMenu(): void;
  setConfigErrors(errors: string[]): void;
  setShell(info: ShellInfo): void;
  setNotifyPermission(p: NotifyPermission): void;
  setUpdate(version?: string): void;
  setCapturingKey(id?: ActionId): void;
  toggleSidebar(open?: boolean): void;
  toggleSides(): void;
  toggleSettings(open?: boolean, pane?: string): void;
  toggleUsage(open?: boolean, opts?: { keepPageFocus?: boolean }): void;
  toggleMobile(open?: boolean, opts?: { keepPageFocus?: boolean }): void;
  toggleLoad(open?: boolean, opts?: { keepPageFocus?: boolean }): void;
  toggleFeedback(open?: boolean, opts?: { keepPageFocus?: boolean }): void;
  setFeedbackDraft(patch?: Partial<FeedbackDraft>): void;
  setMobile(status?: MobileStatus): void;
  setPhones(phones: PhoneSession[]): void;
  pageFocusSettled(): void;
  setSettings(patch: Partial<Settings>): void;
  setHalfCard(size: HalfCard, persist?: boolean): void;
  setSideWidths(widths: SideWidths, persist?: boolean): void;
  toggleFilesTree(open?: boolean): void;
  setFilesTreeWidth(width: number, persist?: boolean): void;
  setSection(name: string, section: Section, persist?: boolean): void;
  setDropHover(t?: DropTarget): void;
};

export const createUiSlice = (storage: AppStorage | undefined, view: View): StateCreator<App, [], [], UiState & UiActions> => (set, get) => {
  // a machine with no settings of its own has never had them in front of it: the window opens with the
  // fleet, and closing it is what writes them and keeps the asking to that one launch
  const firstRun = storage !== undefined && storage.getSettings() === undefined;
  // the collision check belongs to that same launch: after it, what is written down is the user's answer
  let checkGhosttyKeys = firstRun;
  // the dock has one open utility at a time; leaving first-run settings still records the answer
  const toggleUtility = (which: 'usageOpen' | 'mobileOpen' | 'loadOpen' | 'feedbackOpen', open?: boolean, opts?: { keepPageFocus?: boolean }) => set((s) => {
    const next = open ?? !s[which];
    if (next && s.settingsOpen && s.loaded) storage?.setSettings(s.settings);
    return { usageOpen: false, mobileOpen: false, loadOpen: false, feedbackOpen: false, [which]: next, settingsOpen: next ? false : s.settingsOpen,
      capturingKey: next ? undefined : s.capturingKey,
      resourcesOpen: next ? false : s.resourcesOpen, keepPageFocus: opts?.keepPageFocus ?? false };
  });
  return {
    view,
    focusedId: storage?.getFocus(),
    selectedId: undefined,
    selectedIslandId: undefined,
    sideCardOpen: false,
    sideCardCollapsed: false,
    namingRobot: false,
    missionPrompt: false,
    closingRobot: undefined,
    sleepingRobot: undefined,
    moveSheet: undefined,
    deletingIsland: undefined,
    deletingColumn: undefined,
    card: undefined,
    cardSize: 'half',
    active: true,
    terminals: {},
    terminalErrors: {},
    webviews: {},
    addressFocus: false,
    arrangeAsk: false,
    placingNow: false,
    toast: undefined,
    linkAsk: undefined,
    menu: undefined,
    configErrors: [],
    notifyPermission: 'unknown',
    update: undefined,
    sidebarOpen: storage?.getSidebarOpen() ?? true,
    settingsOpen: firstRun,
    settingsAsk: undefined,
    capturingKey: undefined,
    usageOpen: false,
    mobileOpen: false,
    loadOpen: false,
    feedbackOpen: false,
    feedbackDraft: EMPTY_DRAFT,
    mobile: undefined,
    keepPageFocus: false,
    settings: storage?.getSettings() ?? DEFAULT_SETTINGS,
    halfCard: storage?.getHalfCard() ?? DEFAULT_HALF_CARD,
    sideWidths: storage?.getSideWidths() ?? DEFAULT_SIDE_WIDTHS,
    filesTree: storage?.getFilesTree() ?? { open: true },
    sections: storage?.getSections() ?? {},
    dropHover: undefined,
    setActive: (active) => set({ active }),
    // the card goes along to the other view
    setView: (v) => {
      storage?.setView(v);
      const s = get();
      // the shelf lies on the map and is mounted with it, so a view that leaves takes it along
      set({ view: v, resourcesOpen: v === 'map' && s.resourcesOpen,
        ...(v === 'map' && s.view === 'board' && s.settings.autoArrange && { arrangeAsk: 'auto' as const }) });
    },
    select: (id, card) => set((s) => ({ selectedId: id, selectedIslandId: undefined, sideCardOpen: (card ?? id !== undefined) && !s.sideCardCollapsed })),
    selectIsland: (id) => set((s) => ({ selectedIslandId: id, selectedId: undefined, sideCardOpen: id !== undefined && !s.sideCardCollapsed })),
    // a robot's terminal is its card
    focus: (id) => {
      storage?.setFocus(id);
      set({ card: id, focusedId: id, selectedId: id, selectedIslandId: undefined });
    },
    setStarredRow: (id) => set({ starredRow: id }),
    closeCard: () => set({ card: undefined }),
    toggleCardSize: () => set((s) => ({ cardSize: s.cardSize === 'half' ? 'full' : 'half' })),
    setNamingRobot: (open) => set({ namingRobot: open }),
    setMissionPrompt: (open) => set({ missionPrompt: open }),
    setClosingRobot: (id) => set({ closingRobot: id }),
    setSleepingRobot: (id) => set({ sleepingRobot: id }),
    setMoveSheet: (ask) => set({ moveSheet: ask }),
    setDeletingIsland: (id) => set({ deletingIsland: id }),
    setDeletingColumn: (id) => set({ deletingColumn: id }),
    setFleetPicker: (mode) => set({ fleetPicker: mode }),
    toggleSideCard: (open) => set((s) => { const next = open ?? !s.sideCardOpen; return { sideCardOpen: next, sideCardCollapsed: !next }; }),
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
    setPlacingNow: (placingNow) => set({ placingNow }),
    showToast: (message, tone = 'error', action, dismiss) => set({ toast: { text: message, tone, ...(action && { action }), ...(dismiss && { dismiss }) } }),
    runToastAction: () => { const a = get().toast?.action; if (!a) return; set({ toast: undefined }); a.run(); },
    clearToast: () => set({ toast: undefined }),
    askLink: (linkAsk) => set({ linkAsk }),
    closeLinkAsk: () => set({ linkAsk: undefined }),
    openMenu: (menu) => set({ menu }),
    closeMenu: () => set({ menu: undefined }),
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
    toggleSides: () => {
      const s = get();
      const open = { sidebar: s.sidebarOpen, card: s.sideCardOpen };
      const hide = open.sidebar || open.card;
      const back = hide ? open : (s.hiddenSides ?? { sidebar: true, card: true });
      if (back.sidebar) s.toggleSidebar(!hide);
      if (back.card) s.toggleSideCard(!hide);
      set({ hiddenSides: hide ? open : undefined });
    },
    toggleSettings: (open, pane) => set((s) => {
      const next = open ?? !s.settingsOpen;
      // a window that closes has been answered, and what it leaves behind is this machine's settings;
      // before the fleet arrives the connect screen stands in its place, and closes nobody saw answer nothing
      if (!next && s.loaded) storage?.setSettings(s.settings);
      // a window that goes must not leave the keyboard listening
      return { settingsOpen: next, settingsAsk: next ? (pane ? { pane } : s.settingsAsk) : undefined, usageOpen: next ? false : s.usageOpen, mobileOpen: next ? false : s.mobileOpen, loadOpen: next ? false : s.loadOpen, feedbackOpen: next ? false : s.feedbackOpen,
        keepPageFocus: next && (s.usageOpen || s.mobileOpen || s.loadOpen || s.feedbackOpen) ? true : s.keepPageFocus,
        capturingKey: next ? s.capturingKey : undefined };
    }),
    toggleUsage: (open, opts) => toggleUtility('usageOpen', open, opts),
    toggleMobile: (open, opts) => toggleUtility('mobileOpen', open, opts),
    toggleLoad: (open, opts) => toggleUtility('loadOpen', open, opts),
    toggleFeedback: (open, opts) => toggleUtility('feedbackOpen', open, opts),
    setFeedbackDraft: (patch) => set((s) => ({ feedbackDraft: patch ? { ...s.feedbackDraft, ...patch } : EMPTY_DRAFT })),
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
    setSection: (name, section, persist = true) => set((s) => {
      const sections = { ...s.sections, [name]: section };
      if (persist) storage?.setSections(sections);
      return { sections };
    }),
    // a Finder drag fires this on every mouse move; skip the render when the target has not changed
    setDropHover: (t) => set((s) => (s.dropHover?.kind === t?.kind && s.dropHover?.id === t?.id && s.dropHover?.after === t?.after ? {} : { dropHover: t })),
  };
};
