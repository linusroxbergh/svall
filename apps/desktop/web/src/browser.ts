import { charOfKey, toUrl, type ContextItem } from '@svall/protocol';
import type { Api } from './api.js';
import { openUrl, webUrl, type Bridge, type Rect } from './bridge.js';
import { showBrowser } from './panes.js';
import { panesOf } from './selectors.js';
import type { AppStore } from './store/index.js';

export type BrowserManager = {
  show(id: string, tab: string, rect: Rect, takeFocus?: boolean): void;
  move(tab: string, rect: Rect): void;
  hide(tab: string): void;
  // into the tab when there is one, else as the character's first tab
  load(id: string, tab: string | undefined, url: string): void;
  // the start page, for a pane with no tabs and none on the way
  start(id: string): void;
  go(tab: string, action: 'back' | 'forward' | 'reload' | 'stop'): void;
};

// where a popup sits until the page places it
const HIDDEN: Rect = { x: 0, y: 0, width: 0, height: 0 };

// the browser opens on a page rather than an empty frame
const START_PAGE = 'https://www.google.com';

export function createBrowserManager(api: Api, bridge: Bridge, store: AppStore): BrowserManager {
  const state = () => store.getState();
  const tabOf = (id: string, tab: string) => state().fleet.characters[id]?.browser?.tabs.find((t) => t.id === tab);
  const ownerOf = (tab: string) => Object.values(state().fleet.characters).find((c) => c.browser?.tabs.some((t) => t.id === tab))?.id;

  const close = (tab: string) => {
    bridge.send({ type: 'browser.close', tab });
    state().webviewGone(tab);
  };
  // popups that closed themselves before svalld had answered browser.open for them
  const closedEarly = new Set<string>();
  // characters whose first tab has been asked for; svalld has not put it in the fleet yet
  const opening = new Set<string>();

  const load: BrowserManager['load'] = (id, tab, input) => {
    const url = toUrl(input);
    if (!url) return;
    if (tab && state().webviews[tab]) bridge.send({ type: 'browser.load', tab, url });
    else {
      opening.add(id);
      api.call('browser.open', { id, url }).catch((e: Error) => { opening.delete(id); console.warn(`browser.open: ${e.message}`); });
    }
  };

  // a link followed in a terminal asks whether it opens beside it, as a tab of that character; anything the
  // browser cannot hold, and a character that is not there, goes straight out to the user's own browser
  const fromTerminal = (key: string, url: string, x: number, y: number) => {
    const id = charOfKey(key);
    if (!state().fleet.characters[id] || !/^https?:/i.test(url)) { openUrl(bridge, url); return; }
    state().askLink({ url, charId: id, x, y, surface: key });
  };

  bridge.onMessage((m) => {
    if (m.type === 'term.openUrl') fromTerminal(m.id, m.url, m.x, m.y);
    if (m.type === 'browser.state') {
      const prev = state().webviews[m.tab];
      if (!prev) return;
      const { type: _t, tab, ...rest } = m;
      state().webviewState(tab, rest);
      const id = ownerOf(tab);
      const known = id && tabOf(id, tab);
      if (known && (known.url !== m.url || known.title !== m.title)) api.fire('browser.update', { id, tab, url: m.url, title: m.title });
    }
    if (m.type === 'browser.opened') {
      const id = ownerOf(m.from);
      // a popup from a tab nobody owns any more is closed again
      if (!id) { close(m.tab); return; }
      // the view exists before the tab does; once svalld has the tab the record follows, so the popup is
      // freed like any other view when its tab goes, or closed at once if it went while svalld was answering
      api.call('browser.open', { id, tab: m.tab, url: m.url }).then(
        () => { if (closedEarly.delete(m.tab)) api.fire('browser.close', { id, tab: m.tab }); else state().webviewOpened(m.tab, HIDDEN); },
        () => close(m.tab),
      );
    }
    // a view the page closed itself takes its tab with it; the record goes first, so the fleet patch finds nothing left to close
    if (m.type === 'browser.closed') {
      const id = ownerOf(m.tab);
      state().webviewGone(m.tab);
      if (id) api.fire('browser.close', { id, tab: m.tab });
      else closedEarly.add(m.tab);
    }
  });

  // a tab gone from the fleet takes its view with it, whoever closed it
  store.subscribe((s, prev) => {
    if (s.fleet === prev.fleet) return;
    for (const id of opening) if (s.fleet.characters[id]?.browser?.tabs.length) opening.delete(id);
    const alive = new Set(Object.values(s.fleet.characters).flatMap((c) => c.browser?.tabs.map((t) => t.id) ?? []));
    for (const tab of Object.keys(s.webviews)) if (!alive.has(tab)) close(tab);
  });

  return {
    show(id, tab, rect, takeFocus = true) {
      if (state().webviews[tab]) {
        bridge.send({ type: 'browser.show', tab, rect, focus: takeFocus });
        state().webviewMoved(tab, rect);
        return;
      }
      const t = tabOf(id, tab);
      if (!t) return;
      bridge.send({ type: 'browser.show', tab, rect, url: t.url, focus: takeFocus });
      state().webviewOpened(tab, rect);
    },
    move(tab, rect) {
      if (!state().webviews[tab]) return;
      bridge.send({ type: 'browser.move', tab, rect });
      state().webviewMoved(tab, rect);
    },
    hide(tab) {
      if (state().webviews[tab]) bridge.send({ type: 'browser.hide', tab });
    },
    load,
    start(id) {
      if (opening.has(id) || state().fleet.characters[id]?.browser?.tabs.length) return;
      load(id, undefined, START_PAGE);
    },
    go(tab, action) {
      if (state().webviews[tab]) bridge.send({ type: 'browser.go', tab, action });
    },
  };
}

// a web page can open in the character's browser; a folder, a file and a mailto have one place to go
export const opensInside = (item: ContextItem): boolean =>
  item.kind !== 'file' && item.kind !== 'folder' && /^https?:/i.test(webUrl(item.ref) ?? '');

// the page opens as a new tab beside the character's terminal, with the character in view
export function openBeside(store: AppStore, browser: BrowserManager, id: string, url: string): void {
  const s = store.getState();
  if (s.view === 'map') s.focus(id); else s.select(id);
  s.setPanes(id, showBrowser(panesOf(s, id)));
  browser.load(id, undefined, url);
}
