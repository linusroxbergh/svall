import {
  handoverError,
  type AgentAdapter, type Event, type HandoverPhase, type MachineId, type OwnerRecord, type OwnershipInfo, type ParsedParams, type Result,
} from '@svall/protocol';
import type { Fleet } from '../fleet.js';
import { AuthorityFailure } from '../gateway/authority.js';
import type { OwnershipState } from '../ownership/state.js';
import { runGit } from '../links/git.js';
import { DestinationHandover, type DestinationDeps } from './destination.js';
import { unreached } from './git-import.js';
import { handoverGeneration, type HandoverJournal, type JournalFile, type JournalState } from './journal.js';
import { agentAdapters, type AgentProber } from './sessions/registry.js';
import { SourceHandover, type Authority, type SourceDeps } from './source.js';

export type HandoverDeps = {
  ownership: OwnershipState;
  journal: JournalFile;
  /** This machine's agent CLIs as they last answered, or asked afresh; none when not given. */
  agents?: AgentProber;
  /** What the source phases run on. */
  source: SourceDeps;
  /** What the destination phases run on. */
  destination: DestinationDeps;
  /** What a record naming this machine starts, and one naming another stops. */
  fleet?: Pick<Fleet, 'activate' | 'reconcileNow' | 'deactivate' | 'resumeInterrupted'>;
  /** Names another machine this fleet's gateway, in fleet.json and in the running config. */
  setGateway?(id: MachineId): void;
  /** How to ask a given machine's gateway, before it is this fleet's. */
  authorityFor?(gatewayMachineId: MachineId): Authority;
};

// the failures in which no gateway answered, as against one that answered with a refusal
const UNANSWERED = new Set(['disconnected', 'timeout']);

// after this the fleet has moved, and nothing on either machine may take it back
const COMMITTED = new Set<HandoverPhase>(['commit', 'activate', 'complete']);

/**
 * What each phase needs of this machine: the source runs on the unfrozen owner, the destination on a
 * machine that is not running the fleet, and an abort on the machine the record names.
 */
const AUTHORITY = {
  preflight: 'source', freeze: 'source', inspect: 'destination', claim: 'destination', prepare: 'destination', activate: 'destination',
  abort: 'source-abort',
} as const;
type Phase = keyof typeof AUTHORITY;

/** The handover state machine as this daemon sees it: the journal it holds, and the phases it can run. */
export class HandoverService {
  private state: JournalState;
  private listeners = new Set<(e: Event) => void>();
  private source: SourceHandover;
  private destination: DestinationHandover;
  private agents: AgentProber;

  constructor(private deps: HandoverDeps) {
    this.state = deps.journal.load();
    this.agents = deps.agents ?? (async () => []);
    this.source = new SourceHandover(this, deps.ownership, this.agents, deps.source);
    this.destination = new DestinationHandover(this, deps.ownership, this.agents, deps.destination);
  }

  /** What `system.info` says of this machine's agent CLIs, asked afresh: preflight and freeze read logins from it. */
  async agentAdapters(): Promise<AgentAdapter[]> {
    return agentAdapters(await this.agents(true));
  }

  /** The journal as this daemon read it, which is what decides how the daemon starts. */
  journalState(): JournalState {
    return this.state;
  }

  status(): Result<'handover.status'> {
    const j = this.open();
    if (this.state.kind === 'quarantined') return { quarantined: this.state.file };
    if (!j) return {};
    const tx = this.deps.ownership.record().transaction;
    return {
      transaction: {
        id: j.transactionId, fromMachineId: j.fromMachineId, toMachineId: j.toMachineId, phase: j.phase,
        // the journal records when it was last written; only the gateway's record knows when it began
        startedAt: tx?.id === j.transactionId ? tx.startedAt : j.updatedAt,
      },
    };
  }

  ownershipInfo(): OwnershipInfo {
    const { ownership } = this.deps;
    const { fleetId, generation, ownerMachineId, transaction, surrendered } = ownership.record();
    const j = this.open();
    return {
      fleetId, generation, ownerMachineId, frozen: ownership.isFrozen(), ...(transaction && { transaction }), ...(surrendered && { surrendered }),
      ...(j && { journal: { role: j.role, transactionId: j.transactionId, generation: handoverGeneration(j), phase: j.phase } }),
    };
  }

  /**
   * A record `svall fleet recover` relays. The gateway it names is asked here, and its answer is what is taken; the
   * relayed record stands in only when that gateway cannot be asked. The gateway is renamed once its record is taken.
   */
  async relay(p: { record: OwnerRecord; gatewayMachineId: MachineId }): Promise<Result<'ownership.adopt'>> {
    let record = p.record;
    const gateway = this.deps.authorityFor?.(p.gatewayMachineId);
    if (gateway) {
      try {
        record = await gateway.get(this.deps.ownership.record().fleetId);
      } catch (e) {
        if (e instanceof AuthorityFailure && !UNANSWERED.has(e.code)) {
          throw Object.assign(new Error(`the gateway ${p.gatewayMachineId} would not name this fleet's owner: ${e.message}`), { code: e.code });
        }
      }
    }
    const r = await this.adopt(record);
    if (r.adopted) this.deps.setGateway?.(p.gatewayMachineId);
    return r;
  }

  /**
   * Takes a gateway record that outranks the one held. A handover it supersedes is let go without activating; then the
   * record decides whether this machine runs the fleet or holds a read-only replica. A record that does not outrank it,
   * that an open handover still answers to, or that belongs to a handover whose journal here is gone, changes nothing.
   * `starting`: the daemon resumes interrupted agents itself once hooks can reach it.
   */
  async adopt(record: OwnerRecord, starting = false): Promise<Result<'ownership.adopt'>> {
    const { ownership, fleet } = this.deps;
    const held = ownership.record();
    if (record.fleetId !== held.fleetId) {
      throw Object.assign(new Error(`the record is for fleet ${record.fleetId}, and this daemon runs fleet ${held.fleetId}`), { code: 'invalid_params' });
    }
    const j = this.open();
    const unchanged = { adopted: false, ownership: this.ownershipInfo() };
    // a handover's own record is its journal's to act on: without that journal nothing here knows how far it got
    const tx = record.transaction;
    if (tx && (this.state.kind === 'quarantined' || (tx.phase === 'committed' && tx.toMachineId === ownership.machineId && j?.transactionId !== tx.id))) return unchanged;
    const superseded = j !== undefined && record.generation > handoverGeneration(j);
    if (!superseded && (j || !ownership.outranked(record))) return unchanged;
    // a crash between letting a journal go and taking the record meets the same record at the next start
    const takes = !superseded || record.generation >= held.generation || ownership.outranked(record);
    const mine = takes && record.ownerMachineId === ownership.machineId;
    if (superseded && j.role === 'destination') await this.destination.supersede(j.transactionId);
    else if (superseded) await this.source.supersede(j.transactionId, mine);
    if (!takes) return { adopted: false, ...(j && { superseded: j.transactionId }), ownership: this.ownershipInfo() };
    // read only now: an activation the supersede waited behind may have made this machine the owner
    const ran = ownership.isOwner();
    await ownership.installCommitted(record);
    if (mine) {
      ownership.unhold();
      await fleet?.activate();
      await fleet?.reconcileNow();
      if (!starting) await fleet?.resumeInterrupted();
    } else if (ran) {
      await fleet?.deactivate();
    }
    return { adopted: true, ...(superseded && { superseded: j.transactionId }), ownership: this.ownershipInfo() };
  }

  async preflight(p: ParsedParams<'handover.preflight'>): Promise<Result<'handover.preflight'>> {
    this.authorize('preflight');
    return this.source.preflight(p);
  }

  async freeze(p: ParsedParams<'handover.freeze'>): Promise<Result<'handover.freeze'>> {
    const j = this.open();
    // a freeze asked again of the source it froze is answered from what that source holds
    if (!(j?.role === 'source' && j.transactionId === p.transactionId)) this.authorize('freeze');
    this.match(p.transactionId, p.generation);
    return this.source.freeze(p);
  }

  async inspect(p: ParsedParams<'handover.inspect'>): Promise<Result<'handover.inspect'>> {
    this.authorize('inspect');
    return this.destination.inspect(p);
  }

  async claim(p: ParsedParams<'handover.claim'>): Promise<Result<'handover.claim'>> {
    this.authorize('claim');
    this.match(p.transactionId, p.generation, false);
    return this.destination.claim(p);
  }

  /** Each side finishes the journal it holds; with none, only a session stage a second controller's late transfer left there goes. */
  async complete(p: ParsedParams<'handover.complete'>): Promise<Result<'handover.complete'>> {
    const j = this.open();
    if (!j) {
      await this.destination.dropStage(p.transactionId);
      return {};
    }
    this.match(p.transactionId, p.generation);
    if (j.role === 'destination') return this.destination.complete(p);
    return this.source.complete(p);
  }

  async prepare(p: ParsedParams<'handover.prepare'>): Promise<Result<'handover.prepare'>> {
    this.authorize('prepare');
    // a destination's cached record says nothing of the generation it prepares; its manifest and journal do
    this.match(p.transactionId, p.generation, false);
    return this.destination.prepare(p);
  }

  async activate(p: ParsedParams<'handover.activate'>): Promise<Result<'handover.activate'>> {
    // a destination retrying its activation already runs the fleet it received
    if (!this.receiving(p.transactionId)) this.authorize('activate');
    this.match(p.transactionId, p.generation);
    return this.destination.activate(p);
  }

  /** Which of these commits no ref of this machine's repositories reaches: a destination that keeps a worktree asks it of its source. */
  async reaches(p: ParsedParams<'handover.reaches'>): Promise<Result<'handover.reaches'>> {
    const git = this.deps.source?.git ?? runGit;
    const unreachable: Result<'handover.reaches'>['unreached'] = [];
    for (const dir of new Set(p.commits.map((c) => c.commonDir))) {
      const asked = p.commits.filter((c) => c.commonDir === dir).map((c) => c.commit);
      for (const commit of await unreached(dir, asked, git)) unreachable.push({ commonDir: dir, commit });
    }
    return { unreached: unreachable };
  }

  async abort(p: ParsedParams<'handover.abort'>): Promise<Result<'handover.abort'>> {
    let receiving = this.receiving(p.transactionId);
    // a destination the transfer staged sessions on before it journaled anything still lets that stage go; a prepare
    // that stage waited behind may have journaled the handover meanwhile
    if (!receiving && !this.deps.ownership.isOwner()) {
      await this.destination.dropStage(p.transactionId);
      receiving = this.receiving(p.transactionId);
    }
    if (!receiving) this.authorize('abort');
    this.match(p.transactionId, p.generation);
    const j = this.open();
    if (j && COMMITTED.has(j.phase)) {
      throw handoverError({
        code: 'handover_committed',
        message: `${j.transactionId} is committed at ${j.phase}; only the destination can finish it`,
        transactionId: j.transactionId, generation: j.generation,
      });
    }
    if (receiving) return this.destination.abort(p);
    return this.source.abort(p);
  }

  write(journal: HandoverJournal): void {
    this.deps.journal.write(journal);
    this.state = { kind: 'open', journal };
    this.emit({ event: 'handover.changed', data: { transactionId: journal.transactionId, phase: journal.phase } });
  }

  close(): void {
    const last = this.open();
    this.deps.journal.close();
    this.state = { kind: 'none' };
    if (last) this.emit({ event: 'handover.changed', data: { transactionId: last.transactionId, phase: last.phase } });
  }

  /** Reports how far one character or root has come. */
  emitEntity(data: Extract<Event, { event: 'handover.entity' }>['data']): void {
    this.emit({ event: 'handover.entity', data });
  }

  onEvent(fn: (e: Event) => void): () => void {
    this.listeners.add(fn);
    return () => { this.listeners.delete(fn); };
  }

  private open(): HandoverJournal | undefined {
    return this.state.kind === 'open' ? this.state.journal : undefined;
  }

  private receiving(transactionId: string): boolean {
    const j = this.open();
    return j?.role === 'destination' && j.transactionId === transactionId;
  }

  // ahead of the transaction: what this machine may not do to this fleet, it may not do in any phase
  private authorize(phase: Phase): void {
    const { ownership } = this.deps;
    const { ownerMachineId, generation } = ownership.record();
    if (AUTHORITY[phase] === 'source') { ownership.assertOwner('mutation'); return; }
    // a machine still running the fleet cannot also be the machine receiving it
    if (AUTHORITY[phase] === 'destination' && ownership.isOwner() && !ownership.isFrozen()) {
      throw handoverError({ code: 'not_owner', message: 'this machine is running this fleet and cannot receive it', ownerMachineId, generation });
    }
    // an abort has to come from the machine the record names, surrendered or not, journal or none
    if (AUTHORITY[phase] === 'source-abort' && ownerMachineId !== ownership.machineId) {
      throw handoverError({ code: 'not_owner', message: 'this machine cannot abort a handover of a fleet another machine owns', ownerMachineId, generation });
    }
  }

  // the journal outranks the cached record while a handover is open: it is the one written per step
  private match(transactionId: string, generation: number, cached = true): void {
    const j = this.open();
    if (j && j.transactionId !== transactionId) {
      throw handoverError({ code: 'transaction_mismatch', message: `this fleet is in handover ${j.transactionId}, not ${transactionId}`, expected: transactionId, actual: j.transactionId });
    }
    if (!j && !cached) return;
    const actual = j ? j.generation : this.deps.ownership.record().generation;
    if (actual !== generation) {
      throw handoverError({ code: 'generation_mismatch', message: `this fleet is at generation ${actual}, not ${generation}`, expected: generation, actual });
    }
  }

  private emit(e: Event): void {
    for (const fn of this.listeners) fn(e);
  }
}
