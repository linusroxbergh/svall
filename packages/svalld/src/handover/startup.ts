import type { FleetId, OwnerRecord } from '@svall/protocol';
import type { Config } from '../config.js';
import type { Logger } from '../log.js';
import type { OwnershipState } from '../ownership/state.js';
import { boundary } from './failpoints.js';
import type { JournalState } from './journal.js';
import type { HandoverService } from './service.js';
import type { Authority } from './source.js';

/** How long a starting daemon waits for its gateway before it starts on the record it holds. */
const GATEWAY_START_MS = 10_000;
const GATEWAY_RETRY_MS = 250;

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
 * asked again until it listens or the wait is up.
 */
export async function adoptAtStart(o: {
  handover: Pick<HandoverService, 'adopt'>; authority?: Authority; fleetId: FleetId; log: Logger; timeoutMs?: number;
}): Promise<void> {
  const { authority } = o;
  if (!authority) return;
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
    return;
  } finally {
    waiting = false;
    clearTimeout(timer);
  }
  try {
    const r = await o.handover.adopt(record, true);
    if (r.adopted) {
      o.log.info(`took the gateway's record: ${record.ownerMachineId} owns this fleet at generation ${record.generation}${r.superseded ? `, past handover ${r.superseded}` : ''}`);
    }
  } catch (e) {
    o.log.error(`the gateway's record at generation ${record.generation} could not be taken: ${(e as Error).message}`);
  }
}
