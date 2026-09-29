import type { Event } from '@svall/protocol';
import { Api, type Status } from '../api.js';
import { setAppStore } from '../hooks.js';
import { createAppStore, localAppStorage, type AppStore } from '../store/index.js';
import type { TermEvent } from './term.js';

export type PhoneContext = { store: AppStore; api(): Api; onTermEvent(h: (e: TermEvent) => void): () => void };

const isTermEvent = (e: Event): e is TermEvent => e.event.startsWith('term.');

// the page came from svalld itself, so the socket is the same origin; the proxy in front carries the identity
const socketUrl = (): string => `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}`;

// a Home Screen app has no reload button, and svalld on a new protocol serves the page that speaks it;
// the flag keeps a page that still does not match from reloading forever, until one gets through
const RELOADED = 'svall.reloaded';
function reloadOnce(s: Status): void {
  try {
    if (s === 'online') sessionStorage.removeItem(RELOADED);
    if (s !== 'outdated' || sessionStorage.getItem(RELOADED)) return;
    sessionStorage.setItem(RELOADED, '1');
  } catch { return; }
  location.reload();
}

function createPhone(): PhoneContext {
  const store = createAppStore(localAppStorage());
  const api = new Api({ url: socketUrl() });
  const termHandlers = new Set<(e: TermEvent) => void>();
  setAppStore(store);

  const load = () => { api.call('state.get', {}).then((f) => store.getState().setFleet(f)).catch(() => {}); };
  api.onStatus = (s) => { store.getState().setStatus(s); reloadOnce(s); };
  api.onEvent = (e) => {
    if (isTermEvent(e)) { for (const h of termHandlers) h(e); return; }
    if (e.event !== 'state.patch') return;
    // a patch that does not apply means the mirror has drifted; a fresh snapshot resets it
    try { store.getState().applyPatch(e.data.ops); } catch { load(); }
  };
  api.onOpen = load;
  api.start();

  return {
    store,
    api: () => api,
    // terminal frames go to whichever character is open; there is only ever one on a phone
    onTermEvent: (h) => { termHandlers.add(h); return () => { termHandlers.delete(h); }; },
  };
}

let ctx: PhoneContext | undefined;
const need = (): PhoneContext => { if (!ctx) throw new Error('initPhone() before use'); return ctx; };

/** Builds the phone app: the store, the socket, and the terminal fan-out. */
export function initPhone(): PhoneContext {
  ctx ??= createPhone();
  return ctx;
}

// every property is read from the context initPhone() built
export const phone: PhoneContext = {
  get store() { return need().store; },
  api: () => need().api(),
  onTermEvent: (h) => need().onTermEvent(h),
};
