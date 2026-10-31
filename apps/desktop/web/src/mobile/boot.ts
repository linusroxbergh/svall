import { methods, type Event, type Result } from '@svall/protocol';
import { Api, type Status } from '../api.js';
import { setAppStore } from '../hooks.js';
import type { Via } from '../placement.js';
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
  // the page the service worker kept is the one that no longer matches, so the reload waits on the network
  const kept = globalThis.caches?.keys().then((keys) => Promise.all(keys.map((k) => caches.delete(k))));
  void Promise.resolve(kept).catch(() => {}).then(() => location.reload());
}

const PROBE_MS = 5000;
// a Mac that is off never answers the pairing or the socket, and the page would wait on it
const PAIR_MS = 2500;
const CONNECT_MS = 4000;

type Fallbacks = Result<'mobile.fallbacks'>;
const FALLBACKS = 'svall.fallbacks';

// the workers the Mac last named, for a launch while it does not answer; a browser with site data switched off throws
function readFallbacks(): Fallbacks | undefined {
  try {
    const kept = methods['mobile.fallbacks'].result.safeParse(JSON.parse(localStorage.getItem(FALLBACKS) ?? 'null'));
    return kept.success ? kept.data : undefined;
  } catch { return undefined; }
}
const keepFallbacks = (f: Fallbacks) => { try { localStorage.setItem(FALLBACKS, JSON.stringify(f)); } catch { /* site data switched off */ } };

// where the page has the fleet from: the Mac, or a worker standing in for it
type Source = { api: Api; status: Status; via?: Via };

// the QR link's pass rides in the fragment, which stays in the browser, and the daemon trades it for a cookie;
// the manifest is asked for only after, so a Home Screen app made from this page opens with the pass too
function pair(then: () => void): void {
  const done = () => {
    const link = document.createElement('link');
    link.rel = 'manifest';
    link.href = '/manifest.webmanifest';
    link.crossOrigin = 'use-credentials';
    document.head.append(link);
    then();
  };
  const pass = location.hash.slice(1);
  if (pass) void Promise.race([fetch('/pair', { method: 'POST', body: pass }).catch(() => {}), new Promise((r) => setTimeout(r, PAIR_MS))]).then(done);
  else done();
}

function createPhone(): PhoneContext {
  const store = createAppStore(localAppStorage());
  const termHandlers = new Set<(e: TermEvent) => void>();
  setAppStore(store);

  let active: Source | undefined;
  let workers: Source[] = [];
  // the fleet loads whole from each source the page turns to, then follows its patches; one that does not apply means
  // it has drifted. A fleet asked of a source the page has since left lands nowhere
  const load = (s: Source) => { s.api.call('state.get', {}).then((f) => { if (s === active) store.getState().setFleet(f); }).catch(() => {}); };
  const source = (api: Api, via?: Via): Source => {
    const s: Source = { api, status: 'connecting', via };
    api.onEvent = (e) => {
      if (s !== active) return;
      if (isTermEvent(e)) { for (const h of termHandlers) h(e); return; }
      if (e.event === 'state.patch') { try { store.getState().applyPatch(e.data.ops); } catch { load(s); } }
    };
    return s;
  };

  const mac = source(new Api({ url: socketUrl() }, { connectTimeout: CONNECT_MS }));
  // the Mac whenever it answers; else the worker in use while it answers, else the first that does
  const pick = () => {
    const online = (s?: Source) => s?.status === 'online';
    const next = online(mac) ? mac : online(active) ? active : workers.find(online);
    if (next !== active) {
      active = next;
      if (next) { store.getState().setVia(next.via); load(next); }
    }
    store.getState().setStatus(active ? 'online' : mac.status);
  };
  // each worker the Mac named while it answered, by its own phone link; a worker on another protocol is passed over
  const startWorkers = () => {
    const kept = workers.length ? undefined : readFallbacks();
    if (!kept) return;
    workers = kept.fallbacks.map((w) => {
      const api = new Api({ url: `wss://${new URL(w.url).host}`, protocols: ['svall', `svall.pass.${w.pass}`] }, { connectTimeout: CONNECT_MS });
      const s = source(api, { machine: w.machine, home: kept.home });
      s.api.onStatus = (status) => { s.status = status; pick(); };
      s.api.start();
      return s;
    });
  };
  const stopWorkers = () => { for (const w of workers) w.api.stop(); workers = []; };

  mac.api.onStatus = (s) => {
    mac.status = s;
    reloadOnce(s);
    if (s === 'online') stopWorkers();
    else if (s === 'offline') startWorkers();
    pick();
  };
  mac.api.onOpen = () => { mac.api.call('mobile.fallbacks', {}).then(keepFallbacks, () => {}); };
  // the service worker opened its kept page because the Mac did not answer, so the workers start without waiting on it
  if (document.documentElement.hasAttribute('data-kept')) startWorkers();
  pair(() => mac.api.start());

  // a network change can leave the socket open here and dead at the far end: back in view or online, one that hears
  // nothing soon is dropped for a fresh one. Terminal output counts, since the answer can queue behind it; a worker
  // refuses mobile.fallbacks, and the refusal answers
  let probing: ReturnType<typeof setTimeout> | undefined;
  const probe = () => {
    clearTimeout(probing);
    const s = active;
    if (document.hidden || !s) return;
    const heard = s.api.heard;
    probing = setTimeout(() => { if (s.api.heard === heard) s.api.restart(); }, PROBE_MS);
    void (s === mac ? s.api.call('push.key', {}) : s.api.call('mobile.fallbacks', {})).catch(() => {});
  };
  addEventListener('online', probe);
  document.addEventListener('visibilitychange', probe);

  // iOS leaves the page full height under the keyboard, so it takes its height from what is visible, at any zoom
  const vv = window.visualViewport;
  const fit = () => { if (vv) document.documentElement.style.setProperty('--vvh', `${vv.height * vv.scale}px`); };
  vv?.addEventListener('resize', fit);
  fit();

  return {
    store,
    api: () => (active ?? mac).api,
    // terminal frames go to whichever robot is open; there is only ever one on a phone
    onTermEvent: (h) => { termHandlers.add(h); return () => { termHandlers.delete(h); }; },
  };
}

let ctx: PhoneContext | undefined;
const need = (): PhoneContext => { if (!ctx) throw new Error('initPhone() before use'); return ctx; };

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
