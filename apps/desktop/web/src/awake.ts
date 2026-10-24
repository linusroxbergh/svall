import type { FleetState, PhoneSession } from '@svall/protocol';
import type { Bridge } from './bridge.js';
import type { HandoverRun } from './handover.js';
import { slotStatus, wantsUser } from './selectors.js';
import type { KeepAwake } from './settings.js';
import type { AppStore } from './store/index.js';

// how long the Mac stays awake for a shell left running, a robot waiting on the user or a phone, after an agent last did something
export const AWAKE_WINDOW_MS = 30 * 60_000;

// shells: agents whose turn ended with only shells running on. since: when an agent last did something or a phone came on
export type Need = { working: number; shells: number; waiting: number; phones: number; since: number };

export function needOf(f: FleetState, phones: PhoneSession[]): Need {
  const need = { working: 0, shells: 0, waiting: 0, phones: phones.length, since: 0 };
  for (const c of Object.values(f.robots)) {
    for (const term of [1, 2] as const) {
      const a = term === 1 ? c.agent : c.second?.agent;
      if (!a) continue;
      need.since = Math.max(need.since, a.lastActivityAt);
      if (slotStatus(c, term) !== 'working') continue;
      if (a.shellsOnly) need.shells++; else need.working++;
    }
    need.waiting += Number(wantsUser(c));
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

/** A helper the page follows that has said something: idle sleep would cut the ssh and rsync under it, wherever the fleet runs. */
export const handingOver = (run: HandoverRun | undefined): boolean =>
  !!run?.following && !!(run.transactionId || run.preflight || run.status);

/** Has the shell hold the Mac awake while the fleet or a handover needs it, under the reason why, and let go once neither does.
 * Nothing is held for the fleet while the daemon is out of reach, or while the fleet runs on another machine; a handover is
 * held on battery too, as it is minutes long and one cut by sleep strands the fleet. */
export function followAwake({ store, bridge }: { store: AppStore; bridge: Pick<Bridge, 'send'> }): () => void {
  // null until the first word, which also lets go of a hold the page before this one left
  let held: string | null | undefined = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const update = () => {
    const s = store.getState();
    // a run that goes on without this window watching is followed again, so the hold lasts as long as it does
    if (s.handover?.result?.status === 'detached' && !s.handover.following) {
      s.handoverFollow(s.handover.to);
      bridge.send({ type: 'handover.attach' });
      return;
    }
    const now = Date.now();
    const here = !s.connection || s.connection.owner === 'local';
    const moving = s.settings.keepAwake !== 'off' && handingOver(s.handover);
    const hold: ReturnType<typeof awakeHold> = moving ? { reason: 'handing the fleet over' }
      : s.status === 'online' && here ? awakeHold(needOf(s.fleet, s.mobile?.phones ?? []), { mode: s.settings.keepAwake, now }) : undefined;
    clearTimeout(timer);
    // looked at again at least each minute, as the window runs by the clock and a timer can stall while the Mac sleeps
    if (hold?.until) timer = setTimeout(update, Math.min(hold.until - now, 60_000));
    const reason = hold?.reason;
    if (reason !== held) { held = reason; bridge.send({ type: 'awake', reason, ...(moving && { battery: true }) }); }
  };
  const unwatch = store.subscribe((s, prev) => {
    if (s.fleet !== prev.fleet || s.mobile !== prev.mobile || s.status !== prev.status || s.connection !== prev.connection
      || s.handover !== prev.handover || s.settings.keepAwake !== prev.settings.keepAwake) update();
  });
  update();
  return () => { unwatch(); clearTimeout(timer); };
}
