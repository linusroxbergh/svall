import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import {
  FleetState, Generation, NodeConfig, Sha256, TransactionId, TransferFile, TransferRoot, handoverError,
  type AgentKind, type Blocker, type Character, type FleetConfig, type KeptCommit, type OwnerRecord, type ParsedParams, type ReceivedGraph, type ReplicaCheck as WireCheck,
  type ResumeFolder, type Result, type TerminalSlot,
} from '@archipelago/protocol';
import { mergeConfig, namedGateway, type Config } from '../config.js';
import type { Fleet } from '../fleet.js';
import type { GitRunner } from '../links/git.js';
import type { Logger } from '../log.js';
import type { OwnershipState } from '../ownership/state.js';
import { expandHome, installedScripts, type Paths } from '../paths.js';
import { markDormant, markSlotDormant, reviveCommand } from '../reconcile.js';
import { Store } from '../store.js';
import type { Tmux } from '../tmux/tmux.js';
import { writeDurable } from './durable.js';
import { graphsHere, keptWorktrees, repairGraphs, type KeptWorktree } from './git-repair.js';
import { canonicalDigest } from './hash.js';
import { rootMatcher, settle } from './inventory.js';
import { DestinationJournal } from './journal.js';
import { manifestDigest, scanPath, type ScanFs } from './manifest.js';
import { ProcessTable } from './processes.js';
import { probeFolders, type ProbeFs } from './probe.js';
import { ARCHIVABLE, kept, ReplicaError, ReplicaStore, replicaRoots, type ReplicaCheck } from './replicas.js';
import type { Clock } from './rest.js';
import type { HandoverService } from './service.js';
import { adapterFor, installSession, placeTranscripts, resumeFolder, sessionAdapter, type AgentProbe, type InstallFs } from './sessions/registry.js';
import { SessionError, type SessionAdapter } from './sessions/types.js';
import type { Authority } from './source.js';
import { holds } from './portable-path.js';
import { gitProblems, importState, landedProblem, linkProblem, manifestProblems, sessionProblems } from './validate.js';

export type DestinationDeps = {
  paths: Paths;
  /** The daemon's settings, shared by reference: activation puts the imported fleet.json into them. */
  config: Config;
  store: Pick<Store, 'state' | 'update' | 'promote' | 'reload'>;
  fleet: Pick<Fleet, 'activate' | 'reconcileNow' | 'reviveCharacter' | 'openSecond' | 'onSessionStart' | 'carries'>;
  tmux: Pick<Tmux, 'sendLine' | 'listWindows' | 'killWindow' | 'capture'>;
  /** This machine's processes, which say what holds a pane an activation finds open. */
  processes?: (signal?: AbortSignal) => Promise<ProcessTable>;
  /** How to ask the gateway fleet.json names at the time of the call. A fleet no gateway holds cannot be handed to this machine. */
  authority?(): Authority | undefined;
  scanFs?: ScanFs;
  git?: GitRunner;
  install?: InstallFs;
  probeFs?: ProbeFs;
  clock?: Clock;
  /** How long a resumed agent has to report its SessionStart. */
  sessionStartMs?: number;
  /** How many terminals start at once. */
  concurrency?: number;
  log: Logger;
};

/** What Complete seals: each carried root as the Git repair left it, at the generation this machine prepared. */
export const SealRecord = z.object({
  transactionId: TransactionId,
  generation: Generation,
  manifestDigest: Sha256,
  roots: z.array(z.object({ id: z.string().min(1), kind: TransferRoot.shape.kind, entry: TransferRoot.shape.entry, path: z.string(), files: z.array(TransferFile) })),
});
export type SealRecord = z.infer<typeof SealRecord>;

type Journal = Pick<HandoverService, 'journalState' | 'write' | 'close' | 'emitEntity'>;
type Prepare = ParsedParams<'handover.prepare'>;
type Claim = ParsedParams<'handover.claim'>;
type Slot = { characterId: string; term?: 2 };
type Activation = NonNullable<DestinationJournal['activation']>[number];
type CharacterResult = Result<'handover.activate'>['characters'][number];
/** What holds a terminal's pane: nothing once its window has gone, its shell at the prompt, its own agent, or another program. */
type Look = { held: 'gone' | 'shell' | 'agent' } | { held: 'other'; job: string };
/** How a resumed agent came up: its SessionStart came, it has run in its pane without one, or why neither happened. */
type Up = 'started' | 'running' | { failed: string };

const SESSION_START_MS = 60_000;
const CONCURRENCY = 4;
// how long one look at a pane, through tmux and ps, may take
const LOOK_MS = 10_000;
// how long an agent that reports nothing as it resumes must hold its pane to count as up, and how often the pane is looked at
const SETTLE_MS = 3000;
const LOOK_EVERY_MS = 500;
// typed into a plain shell that came back empty, so whoever opens it knows its old job did not come along
const NOTICE = 'Archipelago restarted this shell after a handover; whatever ran here before did not move.';
const RESTARTED = `echo '${NOTICE}'`;

const realClock: Clock = {
  now: Date.now,
  sleep: (ms, signal) => new Promise((r) => {
    const timer = setTimeout(r, ms);
    signal?.addEventListener('abort', () => clearTimeout(timer), { once: true });
  }),
};

const keyOf = (s: Slot): string => (s.term === 2 ? `${s.characterId}-2` : s.characterId);
const blocked = (blockers: Blocker[]): Error => {
  const found = settle(blockers);
  return handoverError({ code: 'blocked', message: found.map((b) => b.message).join('; '), blockers: found });
};
const notReady = (message: string): Error => handoverError({ code: 'not_ready', message });

const wire = (check: ReplicaCheck): WireCheck =>
  (check.ok ? { ok: true, path: check.path, kind: check.kind } : { ok: false, path: check.path, blocker: check.blocker });

/** One result per character, from the results of its terminals: ok when every one came up. */
export function characterResults(activation: readonly Activation[]): CharacterResult[] {
  const byId = new Map<string, Activation[]>();
  for (const a of activation) byId.set(a.characterId, [...(byId.get(a.characterId) ?? []), a]);
  return [...byId].map(([id, slots]) => {
    const error = slots.flatMap((s) => (s.error ? [s.error] : [])).join('; ');
    const notice = slots.flatMap((s) => (s.notice ? [s.notice] : [])).join('; ');
    return { id, ok: slots.every((s) => s.ok), ...(error && { error }), ...(notice && { notice }) };
  });
}

// answers once every worker has stopped, so a failure never leaves one still opening terminals behind it
async function pool<T>(items: readonly T[], limit: number, work: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const worker = async (): Promise<void> => { while (next < items.length) await work(items[next++]); };
  const settled = await Promise.allSettled(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
  const failed = settled.find((r) => r.status === 'rejected');
  if (failed) throw failed.reason;
}

// replaces `into`'s keys with `from`'s while keeping the object, which others hold by reference
function replaceIn(into: Record<string, unknown>, from: Record<string, unknown>): void {
  for (const k of Object.keys(into)) if (!(k in from)) delete into[k];
  Object.assign(into, from);
}

// the daemon's config and its mobile lists are shared by reference, so they take the imported fleet.json in place
function adopt(config: Config, fleet: FleetConfig): void {
  const { mobile, ...rest } = mergeConfig(fleet, NodeConfig.parse(config));
  replaceIn(config.mobile, mobile);
  replaceIn(config, { ...rest, mobile: config.mobile });
}

/**
 * The machine receiving a fleet: it proves what landed and prepares the state it would run beside the one it
 * runs, then, once the gateway has committed, makes that state active and starts the terminals the handover
 * rested. One phase runs at a time.
 */
export class DestinationHandover {
  private queue: Promise<unknown> = Promise.resolve();
  private waiters = new Map<string, { sessionId: string; done: (ok: boolean) => void }>();
  // SessionStarts heard for terminals this handover has yet to answer for, before anything waited on them
  private heard = new Map<string, string>();
  private replicas: ReplicaStore;
  private clock: Clock;

  constructor(private journal: Journal, private ownership: OwnershipState, private agents: () => Promise<AgentProbe[]>, private d: DestinationDeps) {
    this.replicas = new ReplicaStore({ fleetId: d.config.id, paths: d.paths, scanFs: d.scanFs });
    this.clock = d.clock ?? realClock;
    d.fleet.onSessionStart((id, term, sessionId) => this.sessionStarted({ characterId: id, ...(term && { term }) }, sessionId));
    d.fleet.carries((id, term) => this.carrying({ characterId: id, ...(term && { term }) }));
  }

  /**
   * Read-only, for preflight: whether this machine could take each root, which lands at its own path here, what each
   * of `folders` is good for, and which of `links` is not here.
   */
  inspect(p: ParsedParams<'handover.inspect'>): Promise<Result<'handover.inspect'>> {
    return this.serial(async () => {
      const stays = await this.staying(p.git ?? []);
      const roots: Result<'handover.inspect'>['roots'] = [];
      for (const r of p.roots) {
        const linked = linkProblem(r.path, { kind: 'root', id: r.id });
        const check: WireCheck = linked
          ? { ok: false, path: r.path, blocker: linked }
          : wire(await this.replicas.inspect(r, { excludes: p.excludes, ...(r.content && { content: r.content }), keep: stays.keep(r.path) }));
        roots.push({ id: r.id, check });
      }
      const missing = (p.links ?? []).filter((l) => { try { fs.lstatSync(l); return false; } catch { return true; } });
      const untrusted: string[] = [];
      for (const f of p.resumes ?? []) if (!(await this.trusted(f))) untrusted.push(f.cwd);
      return {
        roots, folders: probeFolders(p.folders, this.d.probeFs), ...(p.links && { missing }), ...(stays.unproven.length && { unproven: stays.unproven }),
        ...(p.resumes && { untrusted }),
      };
    });
  }

  /** Whether this machine's agent CLI of `folder`'s kind resumes there without first asking whether to trust it. */
  private async trusted(folder: ResumeFolder): Promise<boolean> {
    const { adapter, home } = await this.cli(folder.kind);
    return !adapter.trusts || (!!home && adapter.trusts(home, folder));
  }

  // this machine's CLI of a kind: the adapter that reads its release, and the home it keeps its files in
  private async cli(kind: AgentKind): Promise<{ adapter: SessionAdapter; home?: string }> {
    const probe = (await this.agents()).find((a) => a.kind === kind);
    return { adapter: (probe?.version && adapterFor(kind, probe.version)) || sessionAdapter(kind), ...(probe?.home && { home: probe.home }) };
  }

  /**
   * The worktrees of the graphs a handover brings that stay on this machine: what each root they lie in leaves as it is,
   * and the commits among theirs this machine cannot prove the copy coming back holds, for the source to judge.
   */
  private async staying(graphs: readonly ReceivedGraph[]): Promise<{ keep(root: string): string[]; unproven: KeptCommit[] }> {
    const kept: KeptWorktree[] = [];
    const unproven: KeptCommit[] = [];
    for (const g of graphs) {
      const r = await keptWorktrees(g, { ...(this.d.git && { git: this.d.git }) });
      kept.push(...r.kept);
      unproven.push(...r.unproven);
    }
    return { keep: (root) => kept.filter((k) => holds(root, k.registration)).map((k) => path.posix.relative(root, k.registration)), unproven };
  }

  claim(p: Claim): Promise<Result<'handover.claim'>> {
    return this.serial(() => this.runClaim(p));
  }

  prepare(p: Prepare): Promise<Result<'handover.prepare'>> {
    return this.serial(() => this.runPrepare(p));
  }

  activate(p: ParsedParams<'handover.activate'>): Promise<Result<'handover.activate'>> {
    return this.serial(() => this.runActivate(p));
  }

  abort(p: ParsedParams<'handover.abort'>): Promise<Result<'handover.abort'>> {
    return this.serial(() => this.runAbort(p));
  }

  complete(p: ParsedParams<'handover.complete'>): Promise<Result<'handover.complete'>> {
    return this.serial(() => this.runComplete(p));
  }

  /** Removes the session stage of a handover this machine holds no journal of, once the gateway no longer holds it open either. */
  dropStage(transactionId: string): Promise<void> {
    return this.serial(async () => {
      if (this.open(transactionId)) return;
      let record: OwnerRecord;
      try { record = await this.ask(); } catch { return; }
      if (record.transaction?.id === transactionId) return;
      fs.rmSync(path.dirname(this.d.paths.sessionStage(transactionId, 0)), { recursive: true, force: true });
    });
  }

  /** Lets go a handover a forced gateway record has superseded, as its abort would: what it prepared is never activated. */
  supersede(transactionId: string): Promise<void> {
    return this.serial(async () => {
      const j = this.open(transactionId);
      if (j) this.discard(j);
    });
  }

  /**
   * Takes each root the manifest carries for the handover the gateway holds open for this machine, before anything
   * is written into it: rsync writes a root only at the path its claim answers, under the excludes it was proven with.
   * A root this machine has prepared from is not taken again, since a second copy would undo its Git repair.
   */
  private async runClaim(p: Claim): Promise<Result<'handover.claim'>> {
    const m = p.manifest;
    const tx = p.transactionId;
    this.identify(p);
    if (this.open(tx)?.preparedDigest) throw notReady(`handover ${tx} is prepared on this machine, so nothing more is copied into its roots`);
    // each root at its own path here, before any is reserved
    const unsafe = manifestProblems(m, []);
    if (unsafe.length) throw blocked(unsafe);
    await this.receiving(p);
    const stays = await this.staying(graphsHere(m));
    const roots: Result<'handover.claim'>['roots'] = [];
    for (const r of replicaRoots(m)) {
      const claim = { transactionId: tx, excludes: m.excludes, incoming: m.roots.find((x) => x.id === r.id)!.files, keep: stays.keep(r.path) };
      let check = await this.replicas.claim(r, claim);
      let archivedTo: string | undefined;
      if (!check.ok && p.archive?.length && ARCHIVABLE.has(check.blocker.code)) {
        try {
          archivedTo = this.replicas.archive(r, p.archive).archivedTo;
          check = await this.replicas.claim(r, claim);
        } catch (e) {
          if (!(e instanceof ReplicaError && e.code === 'not_approved')) throw e;
        }
      }
      roots.push({ id: r.id, excludes: [...m.excludes], check: wire(check), ...(archivedTo && { archivedTo }), ...(check.ok && check.keep?.length && { keep: check.keep }) });
    }
    return { roots, ...(stays.unproven.length && { unproven: stays.unproven }) };
  }

  /** The gateway's Begin for this handover, still preparing, handing this fleet on from the generation before this one to this machine. */
  private async receiving(p: Claim): Promise<void> {
    const record = await this.ask();
    const tx = record.transaction;
    const id = p.transactionId;
    if (!tx || tx.id !== id || tx.toMachineId !== this.ownership.machineId) {
      throw handoverError({
        code: 'transaction_mismatch', message: tx ? `the gateway holds handover ${tx.id} to ${tx.toMachineId}, not ${id} to this machine` : 'the gateway holds no handover of this fleet',
        expected: id, ...(tx && { actual: tx.id }),
      });
    }
    if (record.generation !== p.generation - 1) {
      throw handoverError({ code: 'generation_mismatch', message: `the gateway holds this fleet at generation ${record.generation}, not ${p.generation - 1}`, expected: p.generation - 1, actual: record.generation });
    }
    if (tx.phase !== 'preparing') throw notReady(`the gateway holds handover ${id} ${tx.phase}, so its roots are no longer copied`);
  }

  /** Once this machine runs the fleet it received, seals each root as the Git repair left it at its generation, and closes the journal. */
  private async runComplete(p: ParsedParams<'handover.complete'>): Promise<Result<'handover.complete'>> {
    const j = this.open(p.transactionId);
    if (!j) return {};
    if (j.phase !== 'activate') throw notReady(`handover ${j.transactionId} is at ${j.phase} on this machine, and completes only once it has activated`);
    // an unsealed root would find itself occupied on the way back, so what could not be sealed keeps the record for another try
    const unsealed = this.sealAs(j, j.generation);
    if (unsealed.length) throw notReady(`handover ${j.transactionId} could not seal ${unsealed.join('; ')}; complete it again once that is put right`);
    for (const f of [this.d.paths.replicaSeal(j.transactionId), this.d.paths.preparedState(j.transactionId), path.dirname(this.d.paths.sessionStage(j.transactionId, 0))]) {
      fs.rmSync(f, { recursive: true, force: true });
    }
    this.journal.close();
    return {};
  }

  /**
   * Checks everything it can before its first write, journals, proves each root holds what the transfer
   * verified under this handover's claim, repairs the Git graphs, places the sessions, and only then writes
   * the prepared state. A root verified once is not verified again: the repair has since changed it.
   */
  private async runPrepare(p: Prepare): Promise<Result<'handover.prepare'>> {
    const m = p.manifest;
    const tx = p.transactionId;
    this.identify(p);
    const held = this.open(tx);
    if (held && held.manifestDigest !== p.manifestDigest) {
      throw handoverError({ code: 'transaction_mismatch', message: `this machine prepares handover ${tx} from manifest ${held.manifestDigest}, not ${p.manifestDigest}` });
    }
    if (held?.preparedDigest) {
      fs.rmSync(path.dirname(this.d.paths.sessionStage(tx, 0)), { recursive: true, force: true });
      return { preparedDigest: held.preparedDigest };
    }
    const carried = m.roots.filter((r) => !r.foldedInto);
    const unverified = carried.find((r) => !p.landed.some((x) => x.id === r.id));
    if (unverified) throw notReady(`the transfer verified nothing in root ${unverified.id} (${unverified.path})`);
    const imported = importState(m);
    const homes = Object.fromEntries((await this.agents()).map((a) => [a.kind, a.home]));
    const found = [...manifestProblems(m, p.landed), ...sessionProblems(m, homes)];
    if (found.length) throw blocked(found);
    let state: FleetState;
    try { state = FleetState.parse(placeTranscripts(imported.state, m.sessions)); } catch (e) {
      throw blocked([{ code: 'transcript_missing', message: (e as Error).message }]);
    }

    if (!held) {
      this.journal.write(DestinationJournal.parse({
        role: 'destination', transactionId: tx, generation: p.generation, fleetId: this.d.config.id,
        fromMachineId: m.fromMachineId, toMachineId: m.toMachineId, phase: 'verify', manifestDigest: p.manifestDigest, updatedAt: this.clock.now(),
      }));
    }
    // a machine receiving a fleet runs nothing of it until activation
    this.ownership.hold(`handover ${tx} has not been activated on this machine`);
    const landedDigest = canonicalDigest(p.landed);
    const verified = this.open(tx)?.landedDigest === landedDigest;
    const at = new Map<string, string>();
    // the registrations of worktrees that stay here, which this handover's claim left as they were
    const stays = new Map<string, string[]>();
    const blockers: Blocker[] = [];
    for (const r of carried) {
      const spec = { id: r.id, kind: r.kind, entry: r.entry, path: r.path };
      const check = await this.replicas.inspect(spec, { transactionId: tx, excludes: m.excludes });
      if (!check.ok || check.kind !== 'resume') {
        blockers.push({ code: 'destination_occupied', message: `${check.path} was not claimed by handover ${tx}`, entity: { kind: 'root', id: r.id } });
        continue;
      }
      at.set(r.id, check.path);
      stays.set(r.id, this.replicas.keptBy(spec, tx));
      const landed = verified ? undefined : await landedProblem(r, check.path, p.landed.find((x) => x.id === r.id)!.files, m.excludes, this.d.scanFs, kept(stays.get(r.id)!));
      if (landed) blockers.push(landed);
    }
    if (blockers.length) throw blocked(blockers);

    const git = gitProblems(m, [...at.values()]);
    if (git.length) throw blocked(git);
    // verified once the repair may have changed the roots, and not before: a retry until then compares what landed again
    if (!verified) this.journal.write({ ...this.open(tx)!, landedDigest, updatedAt: this.clock.now() });
    let repaired: Awaited<ReturnType<typeof repairGraphs>>;
    try {
      const registrations = carried.flatMap((r) => (stays.get(r.id) ?? []).map((rel) => path.posix.join(r.path, rel)));
      const keptNames = Object.fromEntries(graphsHere(m).map((g) => [g.id, registrations
        .filter((reg) => path.posix.dirname(reg) === path.posix.join(g.commonDir, 'worktrees')).map((reg) => path.posix.basename(reg))]));
      repaired = await repairGraphs(m, { ...(this.d.git && { git: this.d.git }), kept: keptNames });
    } finally {
      // what Complete seals, or an abort leaves claimable: the roots as the repair left them, however far it got
      const roots: SealRecord['roots'] = [];
      for (const r of carried) {
        const scan = await scanPath(at.get(r.id)!, rootMatcher(r.kind, m.excludes), this.d.scanFs);
        roots.push({ id: r.id, kind: r.kind, entry: r.entry, path: r.path, files: scan?.files ?? [] });
      }
      writeDurable(this.d.paths.replicaSeal(tx), SealRecord.parse({ transactionId: tx, generation: p.generation, manifestDigest: p.manifestDigest, roots }), { mode: 0o600 });
    }
    if (repaired.blockers.length) throw blocked(repaired.blockers);

    const placed: Blocker[] = [];
    m.sessions.forEach((s, i) => {
      try { installSession(s, this.d.paths.sessionStage(tx, i), this.d.install); } catch (e) {
        placed.push({ code: e instanceof SessionError ? e.code : 'transcript_missing', message: (e as Error).message, entity: { kind: 'character', id: s.characterId } });
      }
    });
    if (placed.length) throw blocked(placed);

    const preparedDigest = canonicalDigest(state);
    const preparedPath = this.d.paths.preparedState(tx);
    writeDurable(preparedPath, state, { mode: 0o600 });
    if (p.relaySecret) writeDurable(this.d.paths.relaySecret, Buffer.from(p.relaySecret), { mode: 0o600 });
    this.journal.write({ ...this.open(tx)!, phase: 'prepare', preparedPath, preparedDigest, fleet: imported.fleet, updatedAt: this.clock.now() });
    fs.rmSync(path.dirname(this.d.paths.sessionStage(tx, 0)), { recursive: true, force: true });
    return { preparedDigest };
  }

  /** The prepare or claim meant for this machine, this fleet and this manifest, at the generation after the source's. */
  private identify(p: Pick<Prepare, 'transactionId' | 'generation' | 'manifest' | 'manifestDigest'>): void {
    const m = p.manifest;
    const tx = p.transactionId;
    if (m.transactionId !== tx) {
      throw handoverError({ code: 'transaction_mismatch', message: `the manifest is for handover ${m.transactionId}, not ${tx}`, expected: tx, actual: m.transactionId });
    }
    if (p.generation !== m.generation + 1) {
      throw handoverError({
        code: 'generation_mismatch', message: `handover ${tx} moves this fleet on from generation ${m.generation}, so this machine prepares generation ${m.generation + 1}, not ${p.generation}`,
        expected: p.generation, actual: m.generation + 1,
      });
    }
    const digest = manifestDigest(m);
    if (digest !== p.manifestDigest) throw handoverError({ code: 'transaction_mismatch', message: `the manifest sent hashes to ${digest}, not ${p.manifestDigest}` });
    const me = this.ownership.machineId;
    const { id } = this.d.config;
    const gatewayMachineId = namedGateway(this.d.paths);
    const mismatch = [
      m.toMachineId !== me && `handover ${tx} is handed to ${m.toMachineId}, not this machine`,
      m.fromMachineId === me && `handover ${tx} comes from this machine`,
      m.fleet.id !== id && `the manifest carries fleet ${m.fleet.id}, and this daemon runs fleet ${id}`,
      m.fleet.gatewayMachineId !== gatewayMachineId && `the fleet it carries names gateway ${m.fleet.gatewayMachineId}, and this machine's names ${gatewayMachineId}`,
    ].filter((x): x is string => typeof x === 'string');
    if (mismatch.length) throw blocked(mismatch.map((message) => ({ code: 'identity_mismatch', message })));
  }

  /**
   * Confirms the gateway committed this handover to this machine, then promotes the prepared state and
   * fleet.json, lets the fleet run, and starts the terminals this handover rested that are still dormant. A
   * terminal that does not come up is reported and left dormant; ownership stays here.
   */
  private async runActivate(p: ParsedParams<'handover.activate'>): Promise<Result<'handover.activate'>> {
    const tx = p.transactionId;
    let j = this.open(tx);
    if (!j) throw handoverError({ code: 'transaction_mismatch', message: `this machine is not receiving handover ${tx}`, expected: tx });
    if (!j.preparedDigest || !j.fleet) throw notReady(`handover ${tx} is not prepared on this machine yet`);
    await this.ownership.installCommitted(await this.committed(j));
    if (j.phase === 'prepare') j = this.advance(j, 'commit');
    if (j.phase === 'commit') {
      this.promote(j);
      j = this.advance(j, 'activate');
    }
    this.ownership.unhold();
    await this.d.fleet.activate();
    await this.d.fleet.reconcileNow();
    await this.wake(tx);
    return { characters: characterResults(this.open(tx)?.activation ?? []) };
  }

  /** The gateway's record, when it names this machine the owner at the prepared generation with this handover committed on this state. */
  private async committed(j: DestinationJournal): Promise<OwnerRecord> {
    const record = await this.ask();
    const tx = record.transaction;
    const id = j.transactionId;
    if (tx?.id === id && tx.phase !== 'committed') throw notReady(`the gateway holds handover ${id} ${tx.phase}; it has not committed it`);
    if (record.ownerMachineId !== this.ownership.machineId) {
      throw handoverError({ code: 'not_owner', message: `the gateway names ${record.ownerMachineId} as this fleet's owner at generation ${record.generation}`, ownerMachineId: record.ownerMachineId, generation: record.generation });
    }
    if (record.generation !== j.generation) {
      throw handoverError({ code: 'generation_mismatch', message: `the gateway holds this fleet at generation ${record.generation}, not ${j.generation}`, expected: j.generation, actual: record.generation });
    }
    // a record the gateway has since completed no longer names the handover; only one this machine saw commit may be trusted then
    if (tx ? tx.id !== id : j.phase === 'prepare') {
      throw handoverError({ code: 'transaction_mismatch', message: tx ? `the gateway committed handover ${tx.id}, not ${id}` : `the gateway holds no record of handover ${id} committing`, expected: id, ...(tx && { actual: tx.id }) });
    }
    if (tx && tx.preparedDigest !== j.preparedDigest) {
      throw handoverError({ code: 'transaction_mismatch', message: `handover ${id} was committed on prepared state ${tx.preparedDigest}, and this machine prepared ${j.preparedDigest}`, expected: id, actual: tx.id });
    }
    return record;
  }

  /** fleet.json, then the state: each step is safe to repeat, and a rename that landed before a crash is found by its digest. */
  private promote(j: DestinationJournal): void {
    writeDurable(this.d.paths.fleetConfig, j.fleet!, { mode: 0o600 });
    adopt(this.d.config, j.fleet!);
    const prepared = this.d.paths.preparedState(j.transactionId);
    if (fs.existsSync(prepared)) {
      if (canonicalDigest(Store.readSnapshot(prepared)) !== j.preparedDigest) throw new Error(`${prepared} is not the state handover ${j.transactionId} prepared`);
      this.d.store.promote(prepared);
    } else if (canonicalDigest(Store.readSnapshot(this.d.paths.state)) === j.preparedDigest) {
      this.d.store.reload();
    } else {
      throw new Error(`the state handover ${j.transactionId} prepared is gone from ${prepared}`);
    }
  }

  /**
   * Starts every terminal this handover's rest closed that it has not answered for, a few at a time, and opens again
   * one whose window did not open. One it has answered for is left as it is, and one dormant before the freeze stays
   * dormant.
   */
  private async wake(tx: string): Promise<void> {
    const rows = new Map((this.open(tx)?.activation ?? []).map((a) => [keyOf(a), a]));
    const waiting = (s: Slot, slot: { tmux?: unknown; restedBy?: string } | undefined): boolean => {
      const row = rows.get(keyOf(s));
      return slot?.restedBy === tx && (!row || (!row.ok && !slot.tmux));
    };
    const slots = Object.values(this.d.store.state.characters).flatMap((c): Slot[] => [
      ...(waiting({ characterId: c.id }, c) ? [{ characterId: c.id }] : []),
      ...(waiting({ characterId: c.id, term: 2 }, c.second) ? [{ characterId: c.id, term: 2 as const }] : []),
    ]);
    await pool(slots, this.d.concurrency ?? CONCURRENCY, (s) => this.wakeSlot(tx, s));
  }

  /**
   * Starts one terminal and answers for it. A window an attempt that died left open is judged by what holds its pane
   * now: its agent is up, and a resume that never ran there, or a window gone since, is opened afresh. A terminal that
   * does not come up is left dormant with the session it carries.
   */
  private async wakeSlot(tx: string, s: Slot): Promise<void> {
    const c = this.d.store.state.characters[s.characterId];
    const slot = s.term === 2 ? c?.second : c;
    if (!c || !slot) return;
    const which = s.term === 2 ? `${c.name}'s second terminal` : `${c.name}'s terminal`;
    const agent = reviveCommand(slot) ? slot.agent : undefined;
    // opening the terminal clears its resume, which laying it dormant again puts back
    const carried = agent && slot.revive ? { revive: slot.revive, sessionId: agent.sessionId } : undefined;
    let held = slot.tmux ? (await this.holding(slot)).held : undefined;
    if (held === 'gone' || (held === 'shell' && agent)) {
      await this.lay(s, carried);
      held = undefined;
    }
    let started: { done: Promise<boolean>; cancel(): void } | undefined;
    let entry: Activation;
    try {
      if (!agent) {
        const opened = held ? undefined : await this.openSlot(s);
        const pane = held ? slot.tmux!.paneId : (s.term === 2 ? opened?.second : opened)?.tmux?.paneId;
        // a shell an attempt that died left is told only when its screen does not say so already
        if (pane && (!held || (held === 'shell' && !(await this.told(pane))))) {
          await this.d.tmux.sendLine(pane, RESTARTED, true).catch((e: Error) => this.d.log.error(`handover ${tx}: ${which} opened without its notice: ${e.message}`));
        }
        entry = { ...s, ok: true };
      } else {
        const { adapter } = await this.cli(agent.kind);
        let up: Up = 'running';
        if (held !== 'agent') {
          // only a window left open can have started before this wait
          if (!held) this.heard.delete(keyOf(s));
          // one that reports nothing as it resumes is waited on by its pane, which keeps the time
          started = this.waitStart(s, agent.sessionId, adapter.sessionStartOnResume);
          if (!held) await this.openSlot(s);
          const seconds = Math.round((this.d.sessionStartMs ?? SESSION_START_MS) / 1000);
          up = !adapter.sessionStartOnResume ? await this.settles(s, agent.kind, started)
            : (await started.done) ? 'started' : { failed: `which did not report its SessionStart within ${seconds} s` };
          started.cancel();
        }
        if (typeof up === 'object') {
          await this.lay(s, carried);
          const see = adapter.sessionStartOnResume ? 'it may have stopped at a prompt; revive it to see' : 'revive it to see';
          entry = { ...s, ok: false, sessionId: agent.sessionId, error: `${which} resumed ${agent.kind} session ${agent.sessionId}, ${up.failed}, so it is dormant again with that session; ${see}` };
        } else {
          // an agent up with no SessionStart may be waiting on whether to trust its folder, which it asks before any hook runs
          const asks = up === 'running' && !(await this.trusted({ kind: agent.kind, ...resumeFolder(c, s.term, expandHome) }));
          entry = {
            ...s, ok: true, sessionId: agent.sessionId,
            ...(asks && { notice: `${agent.kind} waits at its "Trust this folder?" prompt in ${which}; answer it there` }),
          };
        }
      }
    } catch (e) {
      started?.cancel();
      await this.lay(s, carried);
      entry = { ...s, ok: false, error: `${which} did not open: ${(e as Error).message}` };
    }
    if (entry.error) this.d.log.error(`handover ${tx}: ${entry.error}`);
    this.recordSlot(tx, entry);
  }

  private openSlot(s: Slot): Promise<Character> {
    return s.term === 2 ? this.d.fleet.openSecond(s.characterId) : this.d.fleet.reviveCharacter(s.characterId);
  }

  /** What holds a terminal's pane now, read afresh through tmux and ps. */
  private async holding(slot: TerminalSlot): Promise<Look> {
    const signal = AbortSignal.timeout(LOOK_MS);
    const w = (await this.d.tmux.listWindows(signal)).find((x) => x.windowId === slot.tmux?.windowId);
    const pane = w && !w.dead ? (await this.processes(signal)).pane(w.panePid) : undefined;
    if (!pane) return { held: 'gone' };
    if (!pane.foreground.length) return { held: 'shell' };
    if (pane.agent && pane.agent.kind === slot.agent?.kind) return { held: 'agent' };
    const leader = pane.foreground.find((p) => p.pid === pane.group) ?? pane.foreground[0];
    return { held: 'other', job: path.basename(leader.args.split(' ')[0]) };
  }

  /**
   * How a resumed agent whose CLI reports nothing as it resumes comes up: running once its pane has held that agent for
   * SETTLE_MS on end, started once its SessionStart comes after all, and otherwise what its pane showed instead.
   */
  private async settles(s: Slot, kind: AgentKind, started: { done: Promise<boolean> }): Promise<Up> {
    const waitMs = this.d.sessionStartMs ?? SESSION_START_MS;
    const end = this.clock.now() + waitMs;
    let heard = false;
    // the wait answers only once its SessionStart comes, since nothing times it out
    const start = started.done.then((ok) => { heard = ok; });
    let since: number | undefined;
    let ran = false;
    let seen = '';
    for (;;) {
      const c = this.d.store.state.characters[s.characterId];
      const slot = s.term === 2 ? c?.second : c;
      let look: Look | undefined;
      try { look = slot?.tmux ? await this.holding(slot) : { held: 'gone' }; } catch (e) { seen = `its pane could not be read (${(e as Error).message})`; }
      if (heard) return 'started';
      const now = this.clock.now();
      if (look?.held === 'agent') {
        since ??= now;
        ran = true;
        if (now - since >= SETTLE_MS) return 'running';
      } else {
        since = undefined;
        if (look?.held === 'gone') return { failed: `but its window closed${ran ? '' : ` before ${kind} came up`}` };
        if (look?.held === 'shell' && ran) return { failed: `but ${kind} exited back to its shell` };
        if (look?.held === 'shell') seen = 'its pane stayed at the shell prompt';
        if (look?.held === 'other') seen = `its pane ran ${look.job} instead`;
        if (now >= end) return { failed: `but ${kind} did not come up within ${Math.round(waitMs / 1000)} s: ${seen}` };
      }
      const nap = new AbortController();
      await Promise.race([this.clock.sleep(LOOK_EVERY_MS, nap.signal), start]);
      nap.abort();
    }
  }

  /** Leaves a terminal dormant with the agent and resume command it carries, its window closed. */
  private async lay(s: Slot, carried?: { revive: { command: string }; sessionId: string }): Promise<void> {
    this.heard.delete(keyOf(s));
    const c = this.d.store.state.characters[s.characterId];
    const windowId = (s.term === 2 ? c?.second : c)?.tmux?.windowId;
    // dormant first, so the fleet hears the window close for a terminal that no longer holds it
    this.d.store.update((d) => {
      const cur = d.characters[s.characterId];
      if (s.term !== 2) { if (cur) markDormant(cur); } else if (cur?.second) markSlotDormant(cur.second);
      const slot = s.term === 2 ? cur?.second : cur;
      if (slot && carried && slot.agent?.sessionId === carried.sessionId) slot.revive = { ...carried.revive };
    });
    if (windowId) await this.d.tmux.killWindow(windowId);
  }

  // whether the notice already shows on a pane's screen, typed or run; a screen that cannot be read shows nothing
  private told(paneId: string): Promise<boolean> {
    return this.d.tmux.capture(paneId, 200).then((b) => b.toString('utf8').includes(NOTICE), () => false);
  }

  private processes = (signal?: AbortSignal): Promise<ProcessTable> =>
    this.d.processes ? this.d.processes(signal) : ProcessTable.read({ signal, scripts: installedScripts(this.d.paths.home) });

  /** A terminal this handover rested and has not answered for: the fleet leaves the agent and resume command it carries alone. */
  private carrying(s: Slot): boolean {
    const state = this.journal.journalState();
    const j = state.kind === 'open' && state.journal.role === 'destination' ? state.journal : undefined;
    const c = this.d.store.state.characters[s.characterId];
    const slot = s.term === 2 ? c?.second : c;
    return !!j && slot?.restedBy === j.transactionId && !j.activation?.some((a) => keyOf(a) === keyOf(s));
  }

  /**
   * Resolves true once the terminal's own session starts, or has been heard starting, and false when the wait runs out
   * or is cancelled. An untimed wait runs until cancelled.
   */
  private waitStart(s: Slot, sessionId: string, timed = true): { done: Promise<boolean>; cancel(): void } {
    const key = keyOf(s);
    if (this.heard.get(key) === sessionId) {
      this.heard.delete(key);
      return { done: Promise.resolve(true), cancel: () => {} };
    }
    const timer = new AbortController();
    let finish!: (ok: boolean) => void;
    const done = new Promise<boolean>((resolve) => {
      finish = (ok) => {
        timer.abort();
        if (this.waiters.get(key)?.done === finish) this.waiters.delete(key);
        resolve(ok);
      };
    });
    this.waiters.set(key, { sessionId, done: finish });
    if (timed) void this.clock.sleep(this.d.sessionStartMs ?? SESSION_START_MS, timer.signal).then(() => finish(false));
    return { done, cancel: () => finish(false) };
  }

  /**
   * A carried session that starts in its terminal answers the wait for it, is kept for a wait still to come while the
   * terminal is carried, or clears the error its wait left.
   */
  private sessionStarted(s: Slot, sessionId: string): void {
    const waiter = this.waiters.get(keyOf(s));
    if (waiter?.sessionId === sessionId) { waiter.done(true); return; }
    if (this.carrying(s)) { this.heard.set(keyOf(s), sessionId); return; }
    const state = this.journal.journalState();
    const j = state.kind === 'open' && state.journal.role === 'destination' ? state.journal : undefined;
    if (j?.activation?.some((a) => keyOf(a) === keyOf(s) && !a.ok && a.sessionId === sessionId)) {
      this.recordSlot(j.transactionId, { ...s, ok: true, sessionId });
    }
  }

  private recordSlot(tx: string, entry: Activation): void {
    this.heard.delete(keyOf(entry));
    const j = this.open(tx);
    if (!j) return;
    // why a terminal did not come up stays on its record, which outlives this journal
    this.d.store.update((d) => {
      const c = d.characters[entry.characterId];
      const slot = entry.term === 2 ? c?.second : c;
      if (!slot) return;
      if (entry.error) slot.resumeError = entry.error; else delete slot.resumeError;
    });
    const activation = [...(j.activation ?? []).filter((a) => keyOf(a) !== keyOf(entry)), entry];
    this.journal.write({ ...j, activation, updatedAt: this.clock.now() });
    const result = characterResults(activation).find((r) => r.id === entry.characterId)!;
    this.journal.emitEntity({
      transactionId: tx, kind: 'character', id: entry.characterId, phase: 'activate', ...(result.error && { error: result.error }), ...(result.notice && { notice: result.notice }),
    });
  }

  /**
   * Lets a prepared handover go once the gateway can no longer commit it: the prepared files go, each root
   * the repair touched is sealed as it now stands so the next handover can claim it, and the hold lifts.
   */
  private async runAbort(p: ParsedParams<'handover.abort'>): Promise<Result<'handover.abort'>> {
    const j = this.open(p.transactionId);
    if (!j) return {};
    const record = await this.ask();
    const tx = record.transaction;
    const mine = record.ownerMachineId === this.ownership.machineId && record.generation >= j.generation;
    if ((tx?.id === j.transactionId && tx.phase === 'committed') || mine) {
      throw handoverError({ code: 'handover_committed', message: `the gateway names ${record.ownerMachineId} as this fleet's owner at generation ${record.generation}; ${j.transactionId} cannot be undone here`, transactionId: j.transactionId, generation: record.generation });
    }
    if (tx?.id === j.transactionId) throw notReady(`the gateway still holds handover ${tx.id} open (${tx.phase}); abort it there before this machine lets it go`);
    this.discard(j);
    return {};
  }

  private discard(j: DestinationJournal): void {
    // the content is the source's at the generation it keeps; a root sealed or archived since is left alone
    this.sealAs(j, j.generation - 1);
    for (const f of [this.d.paths.preparedState(j.transactionId), this.d.paths.replicaSeal(j.transactionId), path.dirname(this.d.paths.sessionStage(j.transactionId, 0))]) {
      fs.rmSync(f, { recursive: true, force: true });
    }
    this.journal.close();
    this.ownership.unhold();
  }

  // seals each root prepare recorded, as the repair left it, and answers the ones it could not; without that record nothing is sealed
  private sealAs(j: DestinationJournal, generation: number): string[] {
    let seal: SealRecord;
    try { seal = SealRecord.parse(JSON.parse(fs.readFileSync(this.d.paths.replicaSeal(j.transactionId), 'utf8'))); } catch { return []; }
    const unsealed: string[] = [];
    for (const { files, ...root } of seal.roots) {
      try {
        this.replicas.seal(root, { transactionId: j.transactionId, generation, manifestDigest: j.manifestDigest, files }, 'destination');
      } catch (e) {
        this.d.log.error(`handover ${j.transactionId}: ${root.path} is left unsealed: ${(e as Error).message}`);
        unsealed.push(`${root.path} (${(e as Error).message})`);
      }
    }
    return unsealed;
  }

  private advance(j: DestinationJournal, phase: 'commit' | 'activate'): DestinationJournal {
    const next = { ...j, phase, updatedAt: this.clock.now() };
    this.journal.write(next);
    return next;
  }

  private async ask(): Promise<OwnerRecord> {
    const authority = this.d.authority?.();
    if (!authority) throw handoverError({ code: 'transaction_mismatch', message: 'this fleet names no gateway, so no handover of it can have begun' });
    try {
      return await authority.get(this.d.config.id);
    } catch (e) {
      throw handoverError({ code: 'authority_unreachable', message: `the gateway could not say who owns this fleet: ${(e as Error).message}` });
    }
  }

  private open(transactionId: string): DestinationJournal | undefined {
    const s = this.journal.journalState();
    return s.kind === 'open' && s.journal.role === 'destination' && s.journal.transactionId === transactionId ? s.journal : undefined;
  }

  private serial<T>(work: () => Promise<T>): Promise<T> {
    const run = this.queue.then(work, work);
    this.queue = run.catch(() => {});
    return run;
  }
}
