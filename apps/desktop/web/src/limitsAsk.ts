import type { LimitHit } from '@svall/protocol';
import { homeName } from './placement.js';
import type { App, AppStore } from './store/index.js';
import { LIMITS_ASK_KEY } from './store/persist.js';

/** A fleet that reached its memory limit on a machine, said with the way to that machine's limits. */
export function limitHit(store: AppStore, hit: LimitHit): void {
  const s = store.getState();
  const name = s.via && hit.machine === s.via.home ? homeName(s.fleet, s.via) : s.fleet.machines?.[hit.machine]?.name ?? hit.name;
  s.showToast(`${name}'s fleet hit its memory limit; a process was stopped`, 'info',
    { label: 'Change limits', run: () => store.getState().toggleSettings(true, 'machines', hit.machine) });
}

/** A join that left its home's limits unset opens them once, on the home's row, as soon as the window reaches the home. */
export function followLimitsAsk(store: AppStore): void {
  const look = (s: App): void => {
    if (!s.loaded || !s.via?.online) return;
    off();
    let asked = false;
    try {
      asked = localStorage.getItem(LIMITS_ASK_KEY) !== null;
      localStorage.removeItem(LIMITS_ASK_KEY);
    } catch { /* optional persistence */ }
    if (asked) s.toggleSettings(true, 'machines', s.via.home);
  };
  const off = store.subscribe(look);
  look(store.getState());
}
