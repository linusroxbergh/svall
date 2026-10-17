import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import {
  FleetId, Generation, HandoverChoices, HandoverPhase, LandedRoot, MachineId, Sha256, TransactionId, TransferManifestV1,
  type OwnerRecord, type OwnershipInfo, type Result, type SafeAction, type Standing, type Verdict,
} from '@svall/protocol';
import { writeDurable } from '@svall/svalld/handover/durable';
import { boundary } from '@svall/svalld/handover/failpoints';
import { canonicalDigest } from '@svall/svalld/handover/hash';
import { manifestDigest } from '@svall/svalld/handover/manifest';
import { transactionDir } from './progress.js';

/** Where the controller reaches a machine: its id, its registry name and ssh alias, and never a token. */
export const Route = z.object({ machineId: MachineId, name: z.string(), ssh: z.string().optional() });
export type Route = z.infer<typeof Route>;

/**
 * The controller's record of one handover: the machines it runs between, how far it got and the digests each
 * step was granted on. The manifest and what the transfer verified are kept beside it, by digest.
 */
export const ControllerJournal = z.object({
  version: z.literal(1),
  fleetId: FleetId,
  // absent until the gateway's Begin has answered
  transactionId: TransactionId.optional(),
  // the source's generation, g; the destination takes the fleet at g + 1
  generation: Generation,
  source: Route,
  destination: Route,
  choices: HandoverChoices,
  // the step last started
  phase: HandoverPhase,
  manifestDigest: Sha256.optional(),
  landedDigest: Sha256.optional(),
  preparedDigest: Sha256.optional(),
  startedAt: z.number(),
  updatedAt: z.number(),
});
export type ControllerJournal = z.infer<typeof ControllerJournal>;

export type FrozenManifest = Result<'handover.freeze'>['manifest'];

/** Where the controller keeps its journal and each transaction's manifest and landed scans. Tests hold them in memory. */
export type ControllerStore = {
  /** The journal, or none when there is none or it cannot be read; `aside` also moves one that cannot be read out of the way. */
  read(aside?: boolean): ControllerJournal | undefined;
  write(j: ControllerJournal): void;
  saveManifest(transactionId: string, manifest: FrozenManifest): void;
  /** The kept manifest, when it is the one `digest` names. */
  manifest(transactionId: string, digest: string): FrozenManifest | undefined;
  saveLanded(transactionId: string, landed: LandedRoot[]): void;
  landed(transactionId: string, digest: string): LandedRoot[] | undefined;
  /** Forgets the journal and, with an id, that transaction's files. */
  clear(transactionId?: string): void;
};

const FrozenManifest = TransferManifestV1.extend({ transactionId: TransactionId });

/** The controller's state for one fleet: `handover.json`, and a folder per transaction beside the transfer's progress journal. */
export function fileStore(dir: string): ControllerStore {
  const journal = path.join(dir, 'handover.json');
  const txFile = (transactionId: string, name: string) => path.join(transactionDir(transactionId, dir), name);
  const write = (file: string, value: object) => {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    writeDurable(file, value, { mode: 0o600 });
  };
  const read = <T>(file: string, parse: (v: unknown) => T): T | undefined => {
    try { return parse(JSON.parse(fs.readFileSync(file, 'utf8'))); } catch { return undefined; }
  };
  return {
    read(aside = false) {
      let text: string;
      try { text = fs.readFileSync(journal, 'utf8'); } catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
        throw e;
      }
      try { return ControllerJournal.parse(JSON.parse(text)); } catch {
        // the other journals still say where the handover stands, so it is rebuilt from them; only a run that writes one moves this aside
        if (aside) boundary('controller.journal', () => fs.renameSync(journal, `${journal}.broken-${Date.now()}`));
        return undefined;
      }
    },
    write: (j) => boundary('controller.journal', () => write(journal, ControllerJournal.parse(j))),
    saveManifest: (tx, m) => boundary('controller.manifest', () => write(txFile(tx, 'manifest.json'), m)),
    manifest: (tx, digest) => {
      const m = read(txFile(tx, 'manifest.json'), (v) => FrozenManifest.parse(v));
      return m && manifestDigest(m) === digest ? m : undefined;
    },
    saveLanded: (tx, landed) => boundary('controller.landed', () => write(txFile(tx, 'landed.json'), landed)),
    landed: (tx, digest) => {
      const landed = read(txFile(tx, 'landed.json'), (v) => z.array(LandedRoot).parse(v));
      return landed && canonicalDigest(landed) === digest ? landed : undefined;
    },
    clear(transactionId) {
      // while the journal still names it, so no crash leaves it behind
      if (transactionId) boundary('controller.clear', () => fs.rmSync(transactionDir(transactionId, dir), { recursive: true, force: true }));
      boundary('controller.journal', () => fs.rmSync(journal, { force: true }));
    },
  };
}

/** What one party answered, or why it did not. */
export type Seen<T> = { ok: true; value: T } | { ok: false; error: string };

/** The four journals: the controller's own, the gateway's record, and what each daemon holds. */
export type Observation = {
  controller?: ControllerJournal;
  gateway: Seen<OwnerRecord>;
  source?: Seen<{ status: Result<'handover.status'>; ownership: OwnershipInfo }>;
  destination?: Seen<{ status: Result<'handover.status'>; ownership?: OwnershipInfo }>;
};

type Found = { transactionId?: string; generation?: number; fromMachineId: MachineId; toMachineId: MachineId };

/** The transaction the journals are about: the controller's, else the gateway's, else whichever daemon still holds one. */
function found(o: Observation, record: OwnerRecord | undefined): Found | undefined {
  const c = o.controller;
  const tx = record?.transaction;
  if (c) {
    const [fromMachineId, toMachineId] = [c.source.machineId, c.destination.machineId];
    // a Begin whose answer never arrived is the gateway's open preparing handover between the same machines
    const begun = !c.transactionId && tx && tx.phase === 'preparing' && tx.fromMachineId === fromMachineId && tx.toMachineId === toMachineId
      && record.generation === c.generation;
    return { transactionId: c.transactionId ?? (begun ? tx.id : undefined), generation: c.generation, fromMachineId, toMachineId };
  }
  if (tx && record) {
    return { transactionId: tx.id, generation: tx.phase === 'committed' ? record.generation - 1 : record.generation, fromMachineId: tx.fromMachineId, toMachineId: tx.toMachineId };
  }
  const s = o.source?.ok ? o.source.value : undefined;
  if (s?.status.transaction) {
    const t = s.status.transaction;
    return { transactionId: t.id, generation: s.ownership.generation, fromMachineId: t.fromMachineId, toMachineId: t.toMachineId };
  }
  const d = o.destination?.ok ? o.destination.value.status.transaction : undefined;
  if (d) {
    const moved = record?.ownerMachineId === d.toMachineId;
    return { transactionId: d.id, generation: record && (moved ? record.generation - 1 : record.generation), fromMachineId: d.fromMachineId, toMachineId: d.toMachineId };
  }
  return undefined;
}

/**
 * Reads where a handover stands from the four journals, and chooses the only safe way on. The gateway decides
 * whether anything committed: while it cannot say, nothing is safe, and after a commit only going forward is.
 */
export function assess(o: Observation): Verdict {
  const record = o.gateway.ok ? o.gateway.value : undefined;
  const f = found(o, record);
  const phaseOf = (seen: Observation['source'] | Observation['destination']) =>
    (seen?.ok && f?.transactionId && seen.value.status.transaction?.id === f.transactionId ? seen.value.status.transaction.phase : undefined);
  const journals = { source: phaseOf(o.source), destination: phaseOf(o.destination) };
  // a destination whose journal could not be read cannot say whether it activated
  const unread = o.destination?.ok ? o.destination.value.status.quarantined : undefined;
  const aborted = o.controller?.phase === 'aborted' || journals.source === 'aborted';
  const base = { ...f, phase: o.controller?.phase ?? journals.destination ?? journals.source, journals };
  const verdict = (standing: Standing, action: Verdict['action'], safe: SafeAction[], reason: string): Verdict => ({ ...base, standing, action, safe, reason });

  if (!f) return verdict('none', 'none', [], 'no handover of this fleet is open anywhere');
  if (!record) {
    return verdict('unknown', 'none', [], `the gateway cannot say whether ${f.transactionId ?? 'the handover'} committed (${o.gateway.ok ? '' : o.gateway.error}); nothing is safe until it answers`);
  }
  const tx = record.transaction;
  const g = f.generation;
  if (!f.transactionId) {
    if (!tx && record.generation === g && record.ownerMachineId === f.fromMachineId) {
      return verdict('none', 'finish-abort', ['abort'], 'the gateway never began this handover; nothing moved');
    }
    return verdict('superseded', 'none', [], `the gateway holds this fleet for ${record.ownerMachineId} at generation ${record.generation}${tx ? ` in handover ${tx.id}` : ''}, not the handover this controller began`);
  }
  const lost = (standing: Standing): Verdict => verdict(standing, 'none', [],
    `${f.transactionId} moved this fleet to ${f.toMachineId}, whose handover journal could not be read and was moved to ${unread}; nothing is safe until someone looks at that machine`);
  if (tx?.id === f.transactionId) {
    if (tx.phase === 'committed') {
      if (unread) return lost('committed');
      return verdict('committed', 'continue', ['resume'], `${tx.id} is committed: the fleet belongs to ${record.ownerMachineId} at generation ${record.generation}, and only its activation can go on`);
    }
    return verdict('open', 'continue', ['resume', 'abort'], `${tx.id} is ${tx.phase} and has not committed; it can go on, or be aborted back to ${f.fromMachineId}`);
  }
  if (g !== undefined && record.generation > g && record.ownerMachineId !== f.fromMachineId) {
    if (aborted) {
      return verdict('superseded', 'none', [], `${f.transactionId} was aborted, and the gateway has since moved this fleet to ${record.ownerMachineId} at generation ${record.generation}`);
    }
    if (unread) return lost('moved');
    return verdict('moved', 'finish', ['resume'], `the gateway has moved this fleet to ${record.ownerMachineId} at generation ${record.generation}; what ${f.transactionId} left open is only to be finished`);
  }
  if (record.generation === g && record.ownerMachineId === f.fromMachineId) {
    return verdict('returned', 'finish-abort', ['abort'], `the gateway no longer holds ${f.transactionId}, and the fleet is ${f.fromMachineId}'s at generation ${g}; its abort is only to be finished`);
  }
  return verdict('superseded', 'none', [], `the gateway holds this fleet for ${record.ownerMachineId} at generation ${record.generation}${tx ? ` in handover ${tx.id}` : ''}, past ${f.transactionId}`);
}

/**
 * Whether this controller's journal may only be dropped: the gateway has moved on past it, or neither the gateway
 * nor either daemon still holds its transaction, so no resume or abort has anything left to drive.
 */
export function forgettable(o: Observation, v: Verdict): { ok: true } | { ok: false; reason: string } {
  if (!o.controller) return { ok: false, reason: 'this controller keeps no journal of a handover' };
  if (v.standing === 'superseded') return { ok: true };
  const tx = v.transactionId;
  const holds = (t: { id: string } | undefined): boolean => t !== undefined && t.id === tx;
  const idle = (s: Observation['source'] | Observation['destination']): boolean => s?.ok === true && !holds(s.value.status.transaction);
  if (tx && o.gateway.ok && !holds(o.gateway.value.transaction) && idle(o.source) && idle(o.destination)) return { ok: true };
  return { ok: false, reason: v.reason };
}
