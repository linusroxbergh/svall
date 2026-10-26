import type { FleetId, MachineId, OwnerRecord } from '@svall/protocol';
import type { Config } from '../config.js';
import type { Logger } from '../log.js';
import type { OwnershipState } from '../ownership/state.js';
import { boundary } from '../failpoints.js';
import type { JournalState } from './journal.js';
import type { HandoverService } from './service.js';
import type { Authority } from './source.js';

/** How long a starting daemon waits for its gateway before it starts on the record it holds. */
const GATEWAY_START_MS = 10_000;
const GATEWAY_RETRY_MS = 250;
/** How often a running daemon asks its gateway again, and how often it looks whether the machine slept meanwhile. */
const GATEWAY_EVERY_MS = 5 * 60_000;
const GATEWAY_TICK_MS = 15_000;

// only the gateway on this machine is asked over a socket: one missing or not listening is that gateway still starting,
// as systemd starts its unit beside the daemon's at boot
const unlistened = (e: unknown): boolean => {
  const { code, syscall } = e as NodeJS.ErrnoException;
  return syscall === 'connect' && (code === 'ENOENT' || code === 'ECONNREFUSED');
};

/** How this daemon comes up: which of them may reconcile, adopt tmux windows and accept mutations. */
export type StartupMode = 'owner' | 'replica' | 'frozen-source' | 'receiving-destination' | 'quarantined';

/** `standalone`: no gateway is configured, so no controller can resume what a broken journal left open. */
export type StartupDeps = { ownership: OwnershipState; journal: JournalState; log: Logger; standalone: boolean };

export function startupMode({ ownership, journal, config }: { ownership: OwnershipState; journal: JournalState; config: Config }): StartupMode {
  if (journal.kind === 'quarantined') return 'quarantined';
  // a journal from another fleet says nothing about this one, and owner.json alone decides
  if (journal.kind === 'open' && journal.journal.fleetId === config.id) {
    // a destination journal holds the fleet at every phase it has: only activation releases it
    return journal.journal.role === 'source' ? 'frozen-source' : 'receiving-destination';
  }
  return ownership.writable() ? 'owner' : 'replica';
}

/** Puts the daemon into its mode before anything starts, so nothing writes a fleet it may not write. */
export async function enterStartupMode(mode: StartupMode, { ownership, journal, log, standalone }: StartupDeps): Promise<void> {
  if (mode === 'owner') return;
  const open = journal.kind === 'open' ? journal.journal : undefined;
  if (journal.kind === 'quarantined') {
    // an unreadable journal is an unresolved handover, and nothing here can tell how far it got
    const moved = `handover journal unreadable; moved to ${journal.file}`;
    if (standalone) {
      // no controller can resume it, so the hold lasts this start only: the next one finds no journal
      ownership.hold(moved);
      log.error(`${moved}. This fleet is read-only until this daemon is restarted.`);
      return;
    }
    await ownership.surrender();
    log.error(`${moved}. This fleet is read-only until a controller resumes or aborts the handover.`);
    return;
  }
  if (mode === 'frozen-source' && open) {
    // a source that wrote a journal had already surrendered, whatever the cached record still says
    if (!ownership.isFrozen()) await boundary('source.startup.surrender', () => ownership.surrender());
    log.info(`handover ${open.transactionId} froze this fleet at ${open.phase}; it is read-only until the controller resumes or aborts it`);
    return;
  }
  if (mode === 'receiving-destination' && open) {
    ownership.hold(`handover ${open.transactionId} has not been activated on this machine`);
    log.info(`handover ${open.transactionId} is at ${open.phase} on this machine; the fleet is read-only until it is activated`);
    return;
  }
  const { ownerMachineId, generation } = ownership.record();
  log.info(`starting read-only: ${ownerMachineId} owns this fleet at generation ${generation}`);
}

/**
 * On start a gateway that answers in time has the last word on who runs this fleet. One that cannot be asked, holds
 * no record of it, or is too slow leaves the daemon on owner.json and its journal; the gateway on this machine is
 * asked again until it listens or the wait is up. Returns false when the gateway did not say.
 */
export async function adoptAtStart(o: {
  handover: Pick<HandoverService, 'adopt'>; authority?: Authority; fleetId: FleetId; log: Logger; timeoutMs?: number;
}): Promise<boolean> {
  const { authority } = o;
  if (!authority) return true;
  const ms = o.timeoutMs ?? GATEWAY_START_MS;
  let timer: NodeJS.Timeout | undefined;
  let waiting = true;
  const ask = async (): Promise<OwnerRecord> => {
    for (;;) {
      try {
        return await authority.get(o.fleetId);
      } catch (e) {
        if (!unlistened(e)) throw e;
      }
      await new Promise((r) => setTimeout(r, GATEWAY_RETRY_MS));
      if (!waiting) throw new Error('the wait is up');
    }
  };
  let record: OwnerRecord;
  try {
    record = await Promise.race([
      ask(),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`no answer within ${ms} ms`)), ms); }),
    ]);
  } catch (e) {
    o.log.info(`the gateway did not say who owns this fleet (${(e as Error).message}); starting on the record this machine holds`);
    return false;
  } finally {
    waiting = false;
    clearTimeout(timer);
  }
  await take(o, record, true);
  return true;
}

/**
 * While the daemon runs, asks the gateway again every five minutes, and at its first look after the machine wakes: a timer
 * stands still while the machine sleeps, and the wall clock does not. An ask that fails, as one does while the network
 * comes back from a sleep, is asked again 15 s later, then twice as long each time, up to five minutes, until one is
 * answered; `answered: false`, from an ask at start that failed, counts as the first. Only a record that names another
 * owner is taken: one naming `machineId` waits for a start or the recovery that wrote it, which tells the machines it
 * takes the fleet from first. Returns what stops it.
 */
export function watchGateway(o: {
  handover: Pick<HandoverService, 'adopt'>; authority: () => Authority | undefined; fleetId: FleetId; machineId: MachineId; log: Logger; everyMs?: number; answered?: boolean;
}): () => void {
  const every = o.everyMs ?? GATEWAY_EVERY_MS;
  const tick = Math.min(GATEWAY_TICK_MS, every / 4);
  let failing = o.answered === false;
  let due = Date.now() + (failing ? tick : every);
  // how long after a failed ask the next one waits
  let wait = failing ? Math.min(2 * tick, every) : tick;
  let asking = false;
  let woke = false;
  let stopped = false;
  /** Whether the gateway answered. */
  const ask = async (): Promise<boolean> => {
    let record: OwnerRecord | undefined;
    try {
      record = await o.authority()?.get(o.fleetId);
    } catch (e) {
      if (!failing) o.log.info(`the gateway did not say who owns this fleet (${(e as Error).message}); this machine keeps the record it holds and asks again, at most five minutes apart`);
      failing = true;
      return false;
    }
    if (!record || stopped) return true;
    if (failing) o.log.info('the gateway answers again');
    failing = false;
    if (record.ownerMachineId !== o.machineId) await take(o, record, false);
    return true;
  };
  let looked = Date.now();
  const timer = setInterval(() => {
    const now = Date.now();
    // a look that comes late comes after a sleep, which is kept until no ask is out
    if (now - looked > 2 * tick) woke = true;
    looked = now;
    if (asking) return;
    if (woke) [woke, due, wait] = [false, now, tick];
    if (now < due) return;
    asking = true;
    void ask().then((answered) => {
      const at = Date.now();
      if (answered) [due, wait] = [at + every, tick];
      else [due, wait] = [at + wait, Math.min(wait * 2, every)];
    }).finally(() => { asking = false; });
  }, tick);
  timer.unref();
  return () => { stopped = true; clearInterval(timer); };
}

/** Takes the gateway's record as a relay's is taken, and says so; one it cannot take is logged. */
async function take(o: { handover: Pick<HandoverService, 'adopt'>; log: Logger }, record: OwnerRecord, starting: boolean): Promise<void> {
  try {
    const r = await o.handover.adopt(record, starting);
    if (r.adopted) {
      o.log.info(`took the gateway's record: ${record.ownerMachineId} owns this fleet at generation ${record.generation}${r.superseded ? `, past handover ${r.superseded}` : ''}`);
    }
  } catch (e) {
    o.log.error(`the gateway's record at generation ${record.generation} could not be taken: ${(e as Error).message}`);
  }
}
