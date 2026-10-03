import fs from 'node:fs';
import { z } from 'zod';
import { FleetConfig, FleetId, Generation, HandoverPhase, MachineId, Sha256, Term, TransactionId } from '@svall/protocol';
import type { Paths } from '../paths.js';
import { DurableJson, cleanupDurableTemps, realStages, syncDir, type DurableOptions } from './durable.js';

const Terminal = z.object({ characterId: z.string().min(1), term: Term });

const Common = {
  transactionId: TransactionId,
  generation: Generation,
  fleetId: FleetId,
  fromMachineId: MachineId,
  toMachineId: MachineId,
  phase: HandoverPhase,
  updatedAt: z.number(),
};

/** What the machine giving the fleet away knows: how far it froze, and which terminals it stopped. */
export const SourceJournal = z.object({
  ...Common,
  role: z.literal('source'),
  manifestDigest: Sha256.optional(),
  // with the launch flags its agent resumes with, where it has any
  stoppedTerminals: z.array(Terminal.extend({ flags: z.array(z.string()).optional() })).default([]),
  // foreground jobs the user chose to end, each written before its signal was sent
  terminated: z.array(Terminal.extend({ processes: z.array(z.string()) })).default([]),
  error: z.string().optional(),
});
export type SourceJournal = z.infer<typeof SourceJournal>;

/**
 * What the machine receiving it knows: the generation it prepares for, the transfer it verified, the state
 * and fleet.json it would activate, and how each terminal came up. `sessionId` is the session a terminal resumes;
 * `notice` is what a terminal that came up still waits on in its window.
 */
export const DestinationJournal = z.object({
  ...Common,
  role: z.literal('destination'),
  manifestDigest: Sha256,
  landedDigest: Sha256.optional(),
  preparedPath: z.string().optional(),
  preparedDigest: Sha256.optional(),
  fleet: FleetConfig.optional(),
  activation: z.array(z.object({
    characterId: z.string().min(1), term: Term, ok: z.boolean(), error: z.string().optional(), sessionId: z.string().optional(), notice: z.string().optional(),
  })).optional(),
});
export type DestinationJournal = z.infer<typeof DestinationJournal>;

export const HandoverJournal = z.discriminatedUnion('role', [SourceJournal, DestinationJournal]);
export type HandoverJournal = z.infer<typeof HandoverJournal>;

/** The generation a handover moves its fleet to: one past the source's, which is the one the destination records. */
export const handoverGeneration = (j: Pick<HandoverJournal, 'role' | 'generation'>): number => (j.role === 'source' ? j.generation + 1 : j.generation);

export type JournalState =
  | { kind: 'none' }
  | { kind: 'open'; journal: HandoverJournal }
  | { kind: 'quarantined'; file: string };

/** This daemon's handover journal: the record a restarted process resumes or refuses from. */
export class JournalFile {
  private json: DurableJson<HandoverJournal>;

  constructor(private paths: Paths, private opts: DurableOptions = {}) {
    this.json = new DurableJson(HandoverJournal, paths.journal, opts);
  }

  load(): JournalState {
    cleanupDurableTemps(this.paths.handoverDir);
    const read = this.json.read();
    if (read.ok) return { kind: 'open', journal: read.value };
    if (read.reason === 'missing') return { kind: 'none' };
    const broken = `${this.paths.journal}.broken-${Date.now()}`;
    fs.renameSync(this.paths.journal, broken);
    this.syncDir();
    return { kind: 'quarantined', file: broken };
  }

  write(journal: HandoverJournal): void {
    this.json.write(journal);
  }

  close(): void {
    fs.rmSync(this.paths.journal, { force: true });
    this.syncDir();
  }

  private syncDir(): void {
    syncDir(this.paths.handoverDir, { ...realStages, ...this.opts.stages });
  }
}

export const openJournal = (paths: Paths, opts?: DurableOptions): JournalFile => new JournalFile(paths, opts);
