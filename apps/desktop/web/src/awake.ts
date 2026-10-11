import type { FleetState, PhoneSession } from '@svall/protocol';
import type { Bridge } from './bridge.js';
import { slotStatus, wantsUser } from './selectors.js';
import type { KeepAwake } from './settings.js';
import type { AppStore } from './store/index.js';

// how long a character waiting on the user, or a phone on the fleet, keeps the Mac awake after the last change
export const AWAKE_WINDOW_MS = 30 * 60_000;

// key changes whenever an agent starts or stops working, a character starts or stops waiting, or a phone comes or goes
export type Need = { working: number; waiting: number; phones: number; key: string };

export function needOf(f: FleetState, phones: PhoneSession[]): Need {
  let working = 0, waiting = 0;
  const parts: string[] = [];
  for (const c of Object.values(f.characters)) {
    const busy = Number(slotStatus(c, 1) === 'working') + Number(!!c.second && slotStatus(c, 2) === 'working');
    const waits = wantsUser(c);
    working += busy;
    waiting += Number(waits);
    if (busy || waits) parts.push(`${c.id}:${busy}:${Number(waits)}`);
  }
  for (const p of phones) parts.push(`${p.login}@${p.since}`);
  return { working, waiting, phones: phones.length, key: parts.sort().join(' ') };
}

const count = (n: number, noun: string) => `${n} ${noun}${n === 1 ? '' : 's'}`;

/** Whether the Mac is kept from idle-sleeping, and the reason the hold is named by; a hold that waits on the user ends at until. */
export function awakeHold(need: Need, o: { mode: KeepAwake; battery: boolean; changedAt: number; now: number }): { reason: string; until?: number } | undefined {
  if (o.mode === 'off' || o.battery) return undefined;
  if (need.working) return { reason: `${count(need.working, 'agent')} working` };
  if (o.mode === 'working' || (!need.waiting && !need.phones)) return undefined;
  const until = o.changedAt + AWAKE_WINDOW_MS;
  if (o.now >= until) return undefined;
  return { reason: need.waiting ? `${count(need.waiting, 'character')} waiting on you` : `${count(need.phones, 'phone')} connected`, until };
}

/** Has the shell hold the Mac awake while the fleet needs it, under the reason why, and let go once it does not. Nothing is held
 * before the shell says what the Mac runs on, or while the daemon is out of reach. */
export function followAwake({ store, bridge }: { store: AppStore; bridge: Pick<Bridge, 'send' | 'onMessage'> }): () => void {
  let battery: boolean | undefined;
  let key: string | undefined;
  let changedAt = Date.now();
  let held: string | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const update = () => {
    const s = store.getState();
    const now = Date.now();
    const need = needOf(s.fleet, s.mobile?.phones ?? []);
    if (need.key !== key) { key = need.key; changedAt = now; }
    const hold = s.status === 'online' && battery !== undefined
      ? awakeHold(need, { mode: s.settings.keepAwake, battery, changedAt, now }) : undefined;
    clearTimeout(timer);
    if (hold?.until) timer = setTimeout(update, hold.until - now);
    if (hold?.reason !== held) { held = hold?.reason; bridge.send({ type: 'awake', reason: held }); }
  };
  const unwatch = store.subscribe((s, prev) => {
    if (s.fleet !== prev.fleet || s.mobile !== prev.mobile || s.status !== prev.status || s.settings.keepAwake !== prev.settings.keepAwake) update();
  });
  const off = bridge.onMessage((m) => { if (m.type === 'power') { battery = m.battery; update(); } });
  return () => { unwatch(); off(); clearTimeout(timer); };
}
