import { loadMobileStatus, type Deps } from './actions.js';
import { Api } from './api.js';
import { connectionFromUrl, createBridge, type Bridge, type Connection } from './bridge.js';
import { createBrowserManager, type BrowserManager } from './browser.js';
import { installDropHandlers } from './drop.js';
import { setAppStore } from './hooks.js';
import { dropBuffers } from './ide/buffers.js';
import { createRepoWatch, type RepoWatch } from './ide/watch.js';
import { installKeyHandlers, openFleetPicker } from './keyboard.js';
import { followNotifications } from './notifications.js';
import { followQuit } from './quit.js';
import { followResources } from './resources/load.js';
import { applyZoom } from './settings.js';
import { createAppStore, localAppStorage, type AppStore } from './store/index.js';
import { createTerminalManager, type TerminalManager } from './terminals.js';

export type AppContext = { bridge: Bridge; store: AppStore; api(): Api; manager(): TerminalManager; browser(): BrowserManager; repoWatch(): RepoWatch };

// the shell names the fleet's home before the page runs, so each fleet's window keeps its own settings,
// and says when the app was opened without naming one
declare global { interface Window { __svallHome?: string; __svallBare?: boolean } }

const endpointOf = (c: Connection) => ({ url: `ws://${c.host}:${c.port}`, token: c.token });

function createApp(): AppContext {
  let api: Api | undefined;
  let repoWatch: RepoWatch | undefined;
  let manager: TerminalManager | undefined;
  let browser: BrowserManager | undefined;
  const bridge = createBridge();
  const query = new URLSearchParams(window.location.search);
  const initialView = (['map', 'board'] as const).find((v) => v === query.get('view'));
  const store = createAppStore(localAppStorage(window.__svallHome), initialView);
  setAppStore(store);
  // one ask for the port stays pending, however many reconnects asked meanwhile
  let retry: ReturnType<typeof setTimeout> | undefined;

  function start(conn: Connection): void {
    const a = new Api(endpointOf(conn));
    api = a;
    manager = createTerminalManager(a, bridge, store);
    repoWatch = createRepoWatch(a);
    browser = createBrowserManager(a, bridge, store);
    followResources({ api: a, store });
    a.onStatus = (status) => {
      store.getState().setStatus(status);
      // the shell re-reads the port file, so a daemon that came back elsewhere is found
      if (status === 'offline' || status === 'outdated') bridge.send({ type: 'connection' });
    };
    const load = () => { a.call('state.get', {}).then((f) => store.getState().setFleet(f)).catch(() => {}); };
    a.onEvent = (e) => {
      if (e.event === 'repo.changed') { repoWatch?.emit(e.data.id); return; }
      if (e.event === 'mobile.phones') { store.getState().setPhones(e.data.phones); return; }
      if (e.event !== 'state.patch') return;
      // a patch that does not apply means the mirror has drifted; a fresh snapshot resets it
      try { store.getState().applyPatch(e.data.ops); } catch { load(); }
    };
    // a launch that named no fleet offers the others, once, when there are any
    let offerFleets = window.__svallBare === true;
    const offer = () => {
      a.call('fleets.list', {}).then((r) => {
        if (!offerFleets) return;
        offerFleets = false;
        if (r.fleets.length > 1) store.getState().setFleetPicker('bare');
      }).catch((e: Error) => console.warn(`fleets.list: ${e.message}`));
    };
    // the phone tab in the corner reads the mobile status, and `svall mobile` can change it while the app is shut
    a.onOpen = () => { load(); loadMobileStatus({ api: a, store }); repoWatch?.resend(); if (offerFleets) offer(); };
    installKeyHandlers({ store, api: a, bridge, browser });
    a.start();
  }

  installDropHandlers({ bridge, store, api: () => api });
  applyZoom(bridge, store.getState().settings.zoom);
  store.subscribe((s, prev) => { if (s.settings.zoom !== prev.settings.zoom) applyZoom(bridge, s.settings.zoom); });
  // a character that left the fleet takes its editor buffers with it
  store.subscribe((s, prev) => { for (const id of Object.keys(prev.ide)) if (!s.ide[id]) dropBuffers(id); });
  if (bridge.present) {
    followNotifications({ store, bridge, api: () => api });
    followQuit({ store, bridge });
    bridge.onMessage((m) => {
      if (m.type === 'app.active') { store.getState().setActive(m.active); return; }
      if (m.type === 'ghostty.configErrors') { store.getState().setConfigErrors(m.errors); return; }
      if (m.type === 'shell.info') { store.getState().setShell({ home: m.home, log: m.log, op: m.op, ghosttyKeys: m.ghosttyKeys }); return; }
      // the menu's Open Fleet…, which works whatever chord the action is on and before svalld first answers
      if (m.type === 'fleets') { openFleetPicker(store); return; }
      // the toast sits below a dialog, and this window is where the user stays
      if (m.type === 'openFleet.failed') { store.getState().setFleetPicker(undefined); store.getState().showToast(`Could not open ${m.home}: ${m.reason}`); return; }
      if (m.type !== 'connection') return;
      if (!m.port) { clearTimeout(retry); retry = setTimeout(() => bridge.send({ type: 'connection' }), 2000); return; }
      if (api) api.setEndpoint(endpointOf(m));
      else start(m);
    });
    bridge.send({ type: 'connection' });
  } else {
    const conn = connectionFromUrl(window.location.search);
    if (conn) start(conn);
  }

  return {
    bridge,
    store,
    api: () => { if (!api) throw new Error('svalld not connected'); return api; },
    manager: () => { if (!manager) throw new Error('svalld not connected'); return manager; },
    browser: () => { if (!browser) throw new Error('svalld not connected'); return browser; },
    repoWatch: () => { if (!repoWatch) throw new Error('svalld not connected'); return repoWatch; },
  };
}

let ctx: AppContext | undefined;
const need = (): AppContext => { if (!ctx) throw new Error('initApp() before use'); return ctx; };

/** Builds the app: the bridge, the store, the socket and everything listening on them. */
export function initApp(): AppContext {
  ctx ??= createApp();
  return ctx;
}

// every property is read from the context initApp() built
export const app: AppContext = {
  get bridge() { return need().bridge; },
  get store() { return need().store; },
  api: () => need().api(),
  manager: () => need().manager(),
  browser: () => need().browser(),
  repoWatch: () => need().repoWatch(),
};

export const deps = (): Deps => ({ api: app.api(), store: app.store, bridge: app.bridge });
