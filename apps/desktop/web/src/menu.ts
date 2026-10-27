import type { MenuState, ToShell } from './bridge.js';
import { commitFocused } from './Field.js';
import { dispatchKey, openFleetPicker, type KeyDeps } from './keyboard.js';
import { ACTIONS, actionIds, chordFor, chordsOf, type ActionId, type Bindings } from './keys.js';
import { panesOf } from './selectors.js';
import type { AppState } from './store/index.js';

// zoom in shows ⌘+, the name macOS gives the key, whenever it answers it
export function menuChords(b: Bindings): Record<string, string> {
  const out: Record<string, string> = {};
  for (const id of actionIds()) {
    const chord = id === 'zoomIn' && chordsOf(id, b).includes('cmd++') ? 'cmd++' : chordFor(id, b);
    if (chord) out[id] = chord;
  }
  return out;
}

export const menuState = (s: AppState): MenuState => ({
  view: s.view,
  sides: s.sidebarOpen || s.sideCardOpen,
  sideCard: s.sideCardOpen,
  resources: s.resourcesOpen,
  browser: s.card !== undefined && panesOf(s, s.card).right === 'browser',
  card: s.card !== undefined,
});

// File lists the fleets of the svalld on this Mac, which a fleet run from another machine cannot reach
async function menuFleets({ store, api }: Pick<KeyDeps, 'store' | 'api'>): Promise<Extract<ToShell, { type: 'menu.fleets' }>> {
  const s = store.getState();
  const owner = s.connection?.owner;
  if (owner && owner !== 'local') return { type: 'menu.fleets', fleets: [], note: `This fleet runs on ${owner}` };
  if (s.status !== 'online') return { type: 'menu.fleets', fleets: [], note: 'svalld is not connected' };
  return api.call('fleets.list', {}).then((r) => ({ type: 'menu.fleets' as const, fleets: r.fleets }), () => ({ type: 'menu.fleets' as const, fleets: [], note: 'Fleets could not be listed' }));
}

/** Tells the Mac menu bar what to show, and runs what is clicked there. */
export function followMenu(ctx: KeyDeps): () => void {
  const { store, bridge, api } = ctx;
  let sent = '';
  let bindings: Bindings | undefined;
  let chords: Record<string, string> = {};
  const sync = () => {
    const s = store.getState();
    if (s.settings.bindings !== bindings) { bindings = s.settings.bindings; chords = menuChords(bindings); }
    const msg: ToShell = { type: 'menu.state', chords, state: menuState(s) };
    const text = JSON.stringify(msg);
    if (text !== sent) { sent = text; bridge.send(msg); }
  };
  sync();
  const unwatch = store.subscribe(sync);
  const run = (action: string) => {
    const s = store.getState();
    // a click is no answer to a shortcut row waiting for a chord
    if (s.capturingKey) s.setCapturingKey(undefined);
    if (action === 'newFleet') return openFleetPicker(store, 'new');
    // the menu's Settings… opens the window rather than closing an open one
    if (action === 'toggleSettings' || action === 'shortcuts') {
      commitFocused();
      return store.getState().toggleSettings(true, action === 'shortcuts' ? 'keyboard' : undefined);
    }
    if (!(action in ACTIONS)) return;
    const a = ACTIONS[action as ActionId].action;
    dispatchKey(a, ctx).catch((e: Error) => console.warn(`${a.type}: ${e.message}`));
  };
  const off = bridge.onMessage((m) => {
    if (m.type === 'menu.run') run(m.action);
    if (m.type === 'menu.ask') void menuFleets(ctx).then(bridge.send);
    if (m.type === 'menu.openFleet') {
      api.call('fleets.start', { home: m.home }).then((r) => bridge.send({ type: 'openFleet', home: r.home }),
        (e: Error) => store.getState().showToast(`Could not open ${m.home}: ${e.message}`));
    }
  });
  return () => { off(); unwatch(); };
}
