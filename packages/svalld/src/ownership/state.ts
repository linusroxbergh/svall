import fs from 'node:fs';
import { z } from 'zod';
import { OwnerRecord, handoverError, type FleetId, type MachineId, type TransactionRecord } from '@svall/protocol';
import { DurableJson } from '../handover/durable.js';
import type { Logger } from '../log.js';
import type { Paths } from '../paths.js';

/** The gateway's record as an owner keeps it, plus the two marks only this machine writes. */
export const OwnerCache = OwnerRecord.extend({
  frozen: z.literal(true).optional(),
  surrendered: z.literal(true).optional(),
});
export type OwnerCache = z.infer<typeof OwnerCache>;

// no machine: what a record too broken to read leaves behind, so nothing here can be mutated
const NO_OWNER = '00000000-0000-0000-0000-000000000000' as MachineId;

/** `standalone`: no gateway is configured, so no machine but this one can own the fleet; otherwise only the gateway can name its owner. */
export type OwnershipDeps = { paths: Paths; fleetId: FleetId; machineId: MachineId; log: Logger; standalone?: boolean };

/** Whether this machine may change this fleet, and the record that says so. */
export class OwnershipState {
  private listeners = new Set<(record: OwnerCache) => void>();
  private held?: string;

  private constructor(private file: DurableJson<OwnerCache>, private cache: OwnerCache, readonly machineId: MachineId) {}

  static load({ paths, fleetId, machineId, log, standalone = false }: OwnershipDeps): OwnershipState {
    const file = new DurableJson(OwnerCache, paths.owner, { mode: 0o600 });
    const read = file.read();
    // without a gateway no other machine can have been handed this fleet, so a record naming one is stale
    const foreign = read.ok && standalone && read.value.ownerMachineId !== machineId;
    if (read.ok && !foreign) return new OwnershipState(file, read.value, machineId);
    if (read.ok) {
      log.error(`owner.json names ${read.value.ownerMachineId}, and no gateway can have handed this fleet over; this machine takes it back at generation 0.`);
    } else if (read.reason === 'malformed') {
      const aside = `${paths.owner}.broken-${Date.now()}`;
      fs.renameSync(paths.owner, aside);
      const next = standalone
        ? 'No gateway holds this fleet, so this machine takes it back at generation 0.'
        : 'This fleet is read-only until its ownership record is repaired.';
      log.error(`owner.json unreadable (${read.error}); moved to ${aside}. ${next}`);
    }
    // a fleet no gateway holds owns itself; one a gateway holds owns nothing until the gateway names its owner, and
    // says so on disk, so the next start does not read the absence as a fresh fleet
    if (!standalone && !read.ok && read.reason === 'missing') log.info('owner.json is missing and a gateway holds this fleet, so this machine owns nothing of it until the gateway names its owner');
    const record: OwnerCache = { fleetId, generation: 0, ownerMachineId: standalone ? machineId : NO_OWNER };
    file.write(record);
    return new OwnershipState(file, record, machineId);
  }

  record(): OwnerCache {
    return this.cache;
  }

  /**
   * Whether a gateway record outranks the one held: a higher generation does, as does an equal one naming another
   * owner, and any record outranks one too broken to read. A lower one never rolls ownership back.
   */
  outranked(record: OwnerRecord): boolean {
    const { generation, ownerMachineId } = this.cache;
    return ownerMachineId === NO_OWNER || record.generation > generation || (record.generation === generation && record.ownerMachineId !== ownerMachineId);
  }

  isOwner(): boolean {
    return this.cache.ownerMachineId === this.machineId;
  }

  isFrozen(): boolean {
    return this.held !== undefined || this.cache.frozen === true || this.cache.surrendered === true;
  }

  /** Holds this daemon read-only for a reason the record cannot carry, such as a handover it has yet to activate. */
  hold(reason: string): void {
    this.held = reason;
  }

  /** Lifts the hold: what it waited for has happened. */
  unhold(): void {
    this.held = undefined;
  }

  /** Whether a background writer may touch the fleet at all. */
  writable(): boolean {
    return this.isOwner() && !this.isFrozen();
  }

  assertOwner(kind: 'mutation' | 'terminal'): void {
    const what = kind === 'terminal' ? 'open a terminal in' : 'change';
    const { transaction: tx, generation } = this.cache;
    // a committed handover is final, and explains the refusal better than the freeze it left behind
    if (tx?.phase === 'committed' && tx.toMachineId !== this.machineId) {
      throw handoverError({ code: 'handover_committed', message: `this fleet moved to another machine; ${tx.id} is committed`, transactionId: tx.id, generation });
    }
    if (this.held !== undefined) {
      throw handoverError({ code: 'frozen', message: `${this.held}, so this machine cannot ${what} anything`, transactionId: tx?.id });
    }
    if (!this.isOwner()) {
      throw handoverError({ code: 'not_owner', message: `this machine cannot ${what} a fleet another machine owns`, ownerMachineId: this.cache.ownerMachineId, generation });
    }
    if (this.isFrozen()) {
      throw handoverError({ code: 'frozen', message: `this fleet is frozen for a handover and cannot ${what} anything`, transactionId: tx?.id });
    }
  }

  /** Marks the certificate surrendered on disk before the controller is told the freeze took. */
  async freeze(transaction: TransactionRecord): Promise<void> {
    this.persist({ ...this.cache, transaction, frozen: true, surrendered: true });
  }

  async surrender(): Promise<void> {
    this.persist({ ...this.cache, surrendered: true });
  }

  async unfreeze(): Promise<void> {
    const { frozen, surrendered, transaction, ...rest } = this.cache;
    this.persist(rest);
  }

  /** Takes the gateway's committed record as the new authority. */
  async installCommitted(record: OwnerRecord): Promise<void> {
    this.persist({ ...record });
  }

  onChange(fn: (record: OwnerCache) => void): () => void {
    this.listeners.add(fn);
    return () => { this.listeners.delete(fn); };
  }

  private persist(next: OwnerCache): void {
    this.file.write(next);
    this.cache = next;
    for (const fn of this.listeners) fn(next);
  }
}
