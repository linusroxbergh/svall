import type { FleetState, PhoneSession } from '@svall/protocol';
import type { Bridge } from './bridge.js';
import { isPlaced } from './placement.js';
import { slotStatus, wantsUser } from './selectors.js';
import type { KeepAwake } from './settings.js';
import type { AppStore } from './store/index.js';

// how long the Mac stays awake for a shell left running, a robot waiting on the user or a phone, after an agent last did something
export const AWAKE_WINDOW_MS = 30 * 60_000;

// shells: agents whose turn ended with only shells running on. since: when an agent last did something or a phone came on
export type Need = { working: number; shells: number; waiting: number; phones: number; since: number };

export function needOf(f: FleetState, phones: PhoneSession[]): Need {
  const need = { working: 0, shells: 0, waiting: 0, phones: phones.length, since: 0 };
  // a robot on a worker works on while this Mac sleeps
  for (const c of Object.values(f.robots).filter((r) => !isPlaced(r))) {
    for (const term of [1, 2] as const) {
      const a = term === 1 ? c.agent : c.second?.agent;
      if (!a) continue;
      need.since = Math.max(need.since, a.lastActivityAt);
      if (slotStatus(c, term) !== 'working') continue;
      if (a.shellsOnly) need.shells++; else need.working++;
    }
    need.waiting += Number(wantsUser(c, f));
  }
  for (const p of phones) need.since = Math.max(need.since, p.since);
  return need;
}

const count = (n: number, noun: string) => `${n} ${noun}${n === 1 ? '' : 's'}`;

// a server or watcher may run for days, so it holds only for the window, as what waits on the user does
function windowReason(need: Need, mode: KeepAwake): string | undefined {
  if (mode === 'needs' && need.waiting) return `${count(need.waiting, 'robot')} waiting on you`;
  if (need.shells) return `${count(need.shells, 'agent')} with a shell running`;
  if (mode === 'needs' && need.phones) return `${count(need.phones, 'phone')} connected`;
  return undefined;
}

/** Whether the Mac is kept from idle-sleeping, and the reason the hold is named by; a hold that is not for work ends at until. */
export function awakeHold(need: Need, o: { mode: KeepAwake; now: number }): { reason: string; until?: number } | undefined {
  if (o.mode === 'off') return undefined;
  if (need.working) return { reason: `${count(need.working, 'agent')} working` };
  const reason = windowReason(need, o.mode);
  const until = need.since + AWAKE_WINDOW_MS;
  return reason && o.now < until ? { reason, until } : undefined;
}

/** Has the shell hold the Mac awake while the fleet needs it, under the reason why, and let go once it does not.
 * Nothing is held while the daemon is out of reach. */
export function followAwake({ store, bridge }: { store: AppStore; bridge: Pick<Bridge, 'send'> }): () => void {
  // null until the first word, which also lets go of a hold the page before this one left
  let held: string | null | undefined = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const update = () => {
    const s = store.getState();
    const now = Date.now();
    const hold = s.status === 'online' ? awakeHold(needOf(s.fleet, s.mobile?.phones ?? []), { mode: s.settings.keepAwake, now }) : undefined;
    clearTimeout(timer);
    // looked at again at least each minute, as the window runs by the clock and a timer can stall while the Mac sleeps
    if (hold?.until) timer = setTimeout(update, Math.min(hold.until - now, 60_000));
    const reason = hold?.reason;
    if (reason !== held) { held = reason; bridge.send({ type: 'awake', reason }); }
  };
  const unwatch = store.subscribe((s, prev) => {
    if (s.fleet !== prev.fleet || s.mobile !== prev.mobile || s.status !== prev.status
      || s.settings.keepAwake !== prev.settings.keepAwake) update();
  });
  update();
  return () => { unwatch(); clearTimeout(timer); };
}
