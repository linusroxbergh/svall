import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { FleetId, Generation, MachineId, OwnerRecord, Sha256, TransactionId, type TransactionRecord } from '@svall/protocol';
import { DurableJson, appendDurable, syncDir, writeDurable, type DurableOptions } from '../handover/durable.js';
import { boundary, type Failpoint } from '../handover/failpoints.js';
import { canonicalJson } from '../handover/hash.js';

/** Everything the gateway owns lives under one prefix: the records, and the socket they are reached through. */
export function gatewayPaths(prefix: string) {
  const dir = path.join(prefix, 'gateway');
  return { dir, fleets: path.join(dir, 'fleets'), socket: path.join(dir, 'authority.sock'), recoveries: path.join(dir, 'recoveries.ndjson') };
}

// the bytes a Unix socket path holds before its NUL
const SOCKET_MAX: Partial<Record<NodeJS.Platform, number>> = { linux: 107, darwin: 103 };

/** Why the gateway cannot listen on `socket` on `platform`: a path longer than a Unix socket takes, which listen refuses with EINVAL. */
export function socketTooLong(socket: string, platform: NodeJS.Platform = process.platform): { message: string; over: number } | undefined {
  const max = SOCKET_MAX[platform];
  const bytes = Buffer.byteLength(socket);
  if (max === undefined || bytes <= max) return undefined;
  return { message: `the gateway's socket ${socket} is ${bytes} bytes, past the ${max} a Unix socket path holds, so its listen fails with EINVAL`, over: bytes - max };
}

/** The compare-and-swap operations, and what each one has to carry to be considered. */
export const OWNER_PARAMS = {
  'owner.get': z.object({ fleetId: FleetId }),
  'owner.create': z.object({ fleetId: FleetId, initialOwnerMachineId: MachineId }),
  'owner.begin': z.object({ fleetId: FleetId, expectedGeneration: Generation, fromMachineId: MachineId, toMachineId: MachineId }),
  // the freeze and the digest are the proof ready is granted on: the source is fenced, and the
  // destination has written the state it would activate
  'owner.ready': z.object({ fleetId: FleetId, transactionId: TransactionId, expectedGeneration: Generation, sourceFrozen: z.literal(true), preparedDigest: Sha256 }),
  'owner.commit': z.object({ fleetId: FleetId, transactionId: TransactionId, expectedGeneration: Generation }),
  'owner.abort': z.object({ fleetId: FleetId, transactionId: TransactionId, expectedGeneration: Generation }),
  'owner.complete': z.object({ fleetId: FleetId, transactionId: TransactionId, generation: Generation }),
  // disaster recovery: swapped against the record the user was shown, or its absence, and audited
  'owner.force': z.object({
    fleetId: FleetId, expected: OwnerRecord.nullable(), ownerMachineId: MachineId, generation: Generation,
    requestingMachineId: MachineId, reason: z.string().min(1), shown: z.array(z.object({ source: z.string().min(1), generation: Generation })),
  }),
} as const;

export type OwnerOp = keyof typeof OWNER_PARAMS;
export type OwnerParamsOf<O extends OwnerOp> = z.infer<(typeof OWNER_PARAMS)[O]>;
export type OwnerParams = { [O in OwnerOp]: OwnerParamsOf<O> }[OwnerOp];
export const isOwnerOp = (v: unknown): v is OwnerOp => typeof v === 'string' && Object.hasOwn(OWNER_PARAMS, v);

export const AUTHORITY_ERROR_CODES = [
  'not_found', 'already_exists', 'not_owner', 'generation_mismatch', 'transaction_mismatch',
  'handover_committed', 'invalid_phase', 'invalid_request', 'authority_corrupt', 'record_changed', 'internal',
] as const;
export type AuthorityErrorCode = (typeof AUTHORITY_ERROR_CODES)[number];
export type AuthorityError = { code: AuthorityErrorCode; message: string; data?: Record<string, unknown> };

/** What the authority answered, as something a caller can throw. */
export class AuthorityFailure extends Error {
  constructor(readonly code: string, message: string, readonly data?: Record<string, unknown>) {
    super(message);
    this.name = 'AuthorityFailure';
  }
}

export type Transition = { record: OwnerRecord } | { error: AuthorityError };

const fail = (code: AuthorityErrorCode, message: string, data?: Record<string, unknown>): Transition =>
  ({ error: data ? { code, message, data } : { code, message } });

const staleGeneration = (expected: number, actual: number): Transition =>
  fail('generation_mismatch', `this fleet is at generation ${actual}, not ${expected}`, { expected, actual });

const isCommitted = (tx: TransactionRecord, record: OwnerRecord): Transition =>
  fail('handover_committed', `${tx.id} is committed; this fleet belongs to ${record.ownerMachineId} at generation ${record.generation}`,
    { transactionId: tx.id, generation: record.generation });

const wrongPhase = (tx: TransactionRecord, wanted: TransactionRecord['phase']): Transition =>
  fail('invalid_phase', `${tx.id} is ${tx.phase}, not ${wanted}`, { phase: tx.phase });

const noHandover = (id: string): Transition =>
  fail('transaction_mismatch', `this fleet has no open handover ${id}`, { expected: id });

const otherHandover = (tx: TransactionRecord, id: string): Transition =>
  fail('transaction_mismatch', `this fleet is in handover ${tx.id}, not ${id}`, { expected: id, actual: tx.id });

const without = (record: OwnerRecord): OwnerRecord => {
  const { transaction: _cleared, ...rest } = record;
  return rest;
};

/**
 * The compare-and-swap itself: what the record becomes, or why it may not. A request a caller repeats
 * because it never saw the answer returns the record its first attempt left behind.
 */
export function transition(
  record: OwnerRecord | undefined,
  op: OwnerOp,
  params: OwnerParams,
  now: number,
  newTransactionId: () => string = () => crypto.randomUUID(),
): Transition {
  if (op === 'owner.force') return force(record, params as OwnerParamsOf<'owner.force'>);
  if (op === 'owner.create') {
    const p = params as OwnerParamsOf<'owner.create'>;
    if (!record) return { record: { fleetId: p.fleetId, generation: 0, ownerMachineId: p.initialOwnerMachineId } };
    if (record.generation === 0 && record.ownerMachineId === p.initialOwnerMachineId) return { record };
    return fail('already_exists', `this fleet is held by ${record.ownerMachineId} at generation ${record.generation}`,
      { ownerMachineId: record.ownerMachineId, generation: record.generation });
  }
  if (!record) return fail('not_found', `the gateway holds no record for fleet ${params.fleetId}`, { fleetId: params.fleetId });
  const tx = record.transaction;

  switch (op) {
    case 'owner.get':
      return { record };

    case 'owner.begin': {
      const p = params as OwnerParamsOf<'owner.begin'>;
      if (p.fromMachineId === p.toMachineId) return fail('invalid_request', 'a fleet cannot be handed to the machine that already holds it');
      if (record.generation !== p.expectedGeneration) return staleGeneration(p.expectedGeneration, record.generation);
      if (record.ownerMachineId !== p.fromMachineId) {
        return fail('not_owner', `this fleet is owned by ${record.ownerMachineId}, not ${p.fromMachineId}`,
          { ownerMachineId: record.ownerMachineId, generation: record.generation });
      }
      if (tx) {
        if (tx.phase === 'committed') return isCommitted(tx, record);
        if (tx.fromMachineId !== p.fromMachineId || tx.toMachineId !== p.toMachineId) {
          return fail('transaction_mismatch', `this fleet is already in handover ${tx.id}`, { actual: tx.id });
        }
        return tx.phase === 'preparing' ? { record } : wrongPhase(tx, 'preparing');
      }
      return {
        record: { ...record, transaction: { id: newTransactionId(), fromMachineId: p.fromMachineId, toMachineId: p.toMachineId, phase: 'preparing', startedAt: now } },
      };
    }

    case 'owner.ready': {
      const p = params as OwnerParamsOf<'owner.ready'>;
      if (record.generation !== p.expectedGeneration) return staleGeneration(p.expectedGeneration, record.generation);
      if (!tx) return noHandover(p.transactionId);
      if (tx.id !== p.transactionId) return otherHandover(tx, p.transactionId);
      if (tx.phase === 'committed') return isCommitted(tx, record);
      if (tx.phase === 'ready-to-commit') {
        return tx.preparedDigest === p.preparedDigest ? { record }
          : fail('invalid_phase', `${tx.id} is ready to commit on another prepared state`, { phase: tx.phase, preparedDigest: tx.preparedDigest });
      }
      return { record: { ...record, transaction: { ...tx, phase: 'ready-to-commit', sourceFrozenAt: now, preparedDigest: p.preparedDigest } } };
    }

    case 'owner.commit': {
      const p = params as OwnerParamsOf<'owner.commit'>;
      // the commit a caller repeats because it never saw the answer: the fleet has already moved
      if (tx?.id === p.transactionId && tx?.phase === 'committed'
        && (record.generation === p.expectedGeneration || record.generation === p.expectedGeneration + 1)) return { record };
      if (record.generation !== p.expectedGeneration) return staleGeneration(p.expectedGeneration, record.generation);
      if (!tx) return noHandover(p.transactionId);
      if (tx.id !== p.transactionId) return otherHandover(tx, p.transactionId);
      if (tx.phase !== 'ready-to-commit') return wrongPhase(tx, 'ready-to-commit');
      return { record: { ...record, generation: record.generation + 1, ownerMachineId: tx.toMachineId, transaction: { ...tx, phase: 'committed' } } };
    }

    case 'owner.abort': {
      const p = params as OwnerParamsOf<'owner.abort'>;
      if (record.generation !== p.expectedGeneration) return staleGeneration(p.expectedGeneration, record.generation);
      if (!tx) return { record };
      if (tx.id !== p.transactionId) return otherHandover(tx, p.transactionId);
      if (tx.phase === 'committed') return isCommitted(tx, record);
      return { record: without(record) };
    }

    case 'owner.complete': {
      const p = params as OwnerParamsOf<'owner.complete'>;
      if (record.generation !== p.generation) return staleGeneration(p.generation, record.generation);
      if (!tx) return { record };
      if (tx.id !== p.transactionId) return otherHandover(tx, p.transactionId);
      if (tx.phase !== 'committed') return wrongPhase(tx, 'committed');
      return { record: without(record) };
    }
  }
}

/** The chosen owner at a generation above every one the fleet was seen at, with no handover open. */
function force(record: OwnerRecord | undefined, p: OwnerParamsOf<'owner.force'>): Transition {
  const next: OwnerRecord = { fleetId: p.fleetId, generation: p.generation, ownerMachineId: p.ownerMachineId };
  // the force a caller repeats because it never saw the answer: the record is already what it asked for
  if (record && canonicalJson(record) === canonicalJson(next)) return { record };
  if (canonicalJson(record ?? null) !== canonicalJson(p.expected)) {
    return fail('record_changed', record
      ? `this fleet's record changed since it was read: ${record.ownerMachineId} holds it at generation ${record.generation}${record.transaction ? ` in handover ${record.transaction.id}` : ''}`
      : 'the gateway no longer holds the record that was read for this fleet', { actual: record ?? null });
  }
  // a handover the record holds open would commit at the generation after it
  const open = record?.transaction && record.transaction.phase !== 'committed' ? 1 : 0;
  const floor = Math.max(record ? record.generation + open : -1, ...p.shown.map((s) => s.generation));
  if (p.generation <= floor) return fail('invalid_request', `a forced record must be above generation ${floor}, the highest this fleet was seen at`, { floor });
  return { record: next };
}

export type AuthorityOptions = { durable?: DurableOptions; now?: () => number; newTransactionId?: () => string };

// the writes a handover makes of the record; a create or a force is no step of one
const STEPS: Partial<Record<OwnerOp, Failpoint>> = {
  'owner.begin': 'gateway.begin.write', 'owner.ready': 'gateway.ready.write', 'owner.commit': 'gateway.commit.write',
  'owner.abort': 'gateway.abort.write', 'owner.complete': 'gateway.complete.write',
};

type Loaded = { record?: OwnerRecord } | { error: AuthorityError };

/**
 * The records on disk, one per fleet, and the one writer of them. Mutations on a fleet run one at a
 * time, and the result is on disk before the caller is told what it is.
 */
export class FleetAuthority {
  private pending = new Map<string, Promise<unknown>>();
  private quarantined = new Set<string>();
  private dir: string;
  private recoveries: string;

  constructor(prefix: string, private opts: AuthorityOptions = {}) {
    const paths = gatewayPaths(prefix);
    this.dir = paths.fleets;
    this.recoveries = paths.recoveries;
    fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
  }

  apply(op: OwnerOp, params: OwnerParams): Promise<Transition> {
    return this.serialize(params.fleetId, () => this.swap(op, params));
  }

  private swap(op: OwnerOp, params: OwnerParams): Transition {
    const file = this.file(params.fleetId);
    const loaded = this.load(file, params.fleetId);
    if ('error' in loaded) return loaded;
    const now = this.opts.now?.() ?? Date.now();
    const result = transition(loaded.record, op, params, now, this.opts.newTransactionId);
    if ('record' in result && !unchanged(loaded.record, result.record)) {
      // the audit line lands first, so no forced record stands without one
      if (op === 'owner.force') this.audit(loaded.record, result.record, params as OwnerParamsOf<'owner.force'>, now);
      const step = STEPS[op];
      if (step) boundary(step, () => file.write(result.record));
      else file.write(result.record);
    }
    return result;
  }

  private audit(before: OwnerRecord | undefined, after: OwnerRecord, p: OwnerParamsOf<'owner.force'>, now: number): void {
    appendDurable(this.recoveries, {
      at: new Date(now).toISOString(), fleetId: p.fleetId, before: before ?? null, after,
      requestingMachineId: p.requestingMachineId, reason: p.reason, shown: p.shown,
    });
  }

  private load(file: DurableJson<OwnerRecord>, fleetId: string): Loaded {
    const marker = `${file.file}.quarantined`;
    const read = file.read();
    if (read.ok) {
      // the repair: a readable record back in its place lifts the quarantine
      this.quarantined.delete(fleetId);
      try { fs.rmSync(marker, { force: true }); } catch { /* at worst the mark outlives its cause */ }
      return { record: read.value };
    }
    if (read.reason === 'malformed') {
      const aside = `${file.file}.broken-${Date.now()}`;
      let moved = false;
      // bytes we can read and cannot parse are corrupt; a file we cannot read at all may be a good
      // record behind an IO failure, and is refused where it lies
      if (readable(file.file)) {
        try {
          // the refusal reaches disk before the record leaves it, so no restart reads the absence as a new fleet
          writeDurable(marker, { fleetId, quarantinedAt: Date.now(), movedTo: aside, error: read.error ?? null }, { mode: 0o600, ...this.opts.durable });
          fs.renameSync(file.file, aside);
          syncDir(this.dir);
          moved = true;
        } catch { /* the record stays where it is; either way this fleet is refused */ }
      }
      this.quarantined.add(fleetId);
      const where = moved ? `it was moved to ${aside}` : 'it was left where it is';
      return { error: { code: 'authority_corrupt', message: `the record for fleet ${fleetId} is unreadable (${read.error}); ${where} and this fleet is refused until ${file.file} holds a readable record`, data: { file: moved ? aside : file.file } } };
    }
    // a quarantined fleet stays refused: its record is gone, and an absent one must not read as new
    if (this.quarantined.has(fleetId) || fs.existsSync(marker)) {
      return { error: { code: 'authority_corrupt', message: `the record for fleet ${fleetId} was quarantined and has not been repaired; put a readable record at ${file.file}` } };
    }
    return {};
  }

  private file(fleetId: string): DurableJson<OwnerRecord> {
    // the id names a file, so nothing but a uuid may reach the path
    return new DurableJson(OwnerRecord, path.join(this.dir, `${FleetId.parse(fleetId)}.json`), { mode: 0o600, ...this.opts.durable });
  }

  private serialize<T>(fleetId: string, step: () => T): Promise<T> {
    const done = (this.pending.get(fleetId) ?? Promise.resolve()).then(step);
    this.pending.set(fleetId, done.then(() => {}, () => {}));
    return done;
  }
}

const unchanged = (before: OwnerRecord | undefined, after: OwnerRecord): boolean =>
  before !== undefined && JSON.stringify(before) === JSON.stringify(after);

const readable = (file: string): boolean => {
  try { fs.readFileSync(file); return true; } catch { return false; }
};
