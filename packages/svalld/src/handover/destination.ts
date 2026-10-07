import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import {
  FleetState, Generation, Sha256, TransactionId, TransferFile, TransferRoot, handoverError,
  type AgentKind, type Blocker, type Character, type FleetConfig, type KeptCommit, type OwnerRecord, type ParsedParams, type ReceivedGraph, type ReplicaCheck as WireCheck,
  type ResumeFolder, type Result, type TerminalSlot, type TransferManifestV1,
} from '@svall/protocol';
import { NodeFile, mergeConfig, namedGateway, type Config } from '../config.js';
import { markDormant, markSlotDormant, reviveCommand } from '../dormancy.js';
import type { Fleet } from '../fleet.js';
import type { GitRunner } from '../links/git.js';
import type { Logger } from '../log.js';
import { opencodeFolders } from '../opencode/install.js';
import type { OwnershipState } from '../ownership/state.js';
import { codexPaths } from '../codex/install.js';
import { claudePaths, expandHome, installedScripts, type Paths } from '../paths.js';
import { Store } from '../store.js';
import type { Tmux } from '../tmux/tmux.js';
import { writeDurable } from './durable.js';
import { boundary } from './failpoints.js';
import { graphsHere, importGraphs, keptWorktrees, type KeptWorktree } from './git-import.js';
import { canonicalDigest } from './hash.js';
import { machineLocal, rootMatcher, settle } from './inventory.js';
import { DestinationJournal } from './journal.js';
import { manifestDigest, scanPath, type ScanFs } from './manifest.js';
import { ProcessTable } from './processes.js';
import { probeFolders, type ProbeFs } from './probe.js';
import { ARCHIVABLE, kept, ReplicaError, ReplicaStore, replicaRoots, type ReplicaCheck } from './replicas.js';
import type { Clock } from './rest.js';
import type { HandoverService } from './service.js';
import { adapterFor, cliRunner, installSession, placeTranscripts, resumeFolder, sessionAdapter, type AgentProbe, type InstallFs } from './sessions/registry.js';
import { SessionError, type CliRun, type SessionAdapter } from './sessions/types.js';
import type { Authority } from './source.js';
import { holds, realPath } from './portable-path.js';
import { gitProblems, importState, landedProblem, linkProblem, manifestProblems, sessionProblems } from './validate.js';

export type DestinationDeps = {
  paths: Paths;
  /** The daemon's settings, shared by reference: activation puts the imported fleet.json into them. */
  config: Config;
  store: Pick<Store, 'state' | 'update' | 'promote' | 'reload'>;
  fleet: Pick<Fleet, 'activate' | 'reconcileNow' | 'resumeInterrupted' | 'reviveCharacter' | 'openSecond' | 'onSessionStart' | 'carries'>;
  tmux: Pick<Tmux, 'sendLine' | 'listWindows' | 'killWindow' | 'capture'>;
  /** This machine's processes, which say what holds a pane an activation finds open. */
  processes?: (signal?: AbortSignal) => Promise<ProcessTable>;
  /** How to ask the gateway fleet.json names at the time of the call. A fleet no gateway holds cannot be handed to this machine. */
  authority?(): Authority | undefined;
  scanFs?: ScanFs;
  git?: GitRunner;
  install?: InstallFs;
  probeFs?: ProbeFs;
  /** This account's home, which a fleet it receives has to share. */
  homedir?: () => string;
  clock?: Clock;
  /** How long a resumed agent has to come up in its pane. */
  sessionStartMs?: number;
  /** How many terminals start at once. */
  concurrency?: number;
  /** How to run an agent CLI that reads a session into its own database. */
  cli?: CliRun;
  log: Logger;
};

/**
 * What Complete seals: what landed in each carried root and what the Git import wrote there, at the generation this
 * machine prepared. A claim writes it first without the files; a root prepare never read stays receiving when the
 * handover is let go.
 */
export const SealRecord = z.object({
  transactionId: TransactionId,
  generation: Generation,
  manifestDigest: Sha256,
  roots: z.array(z.object({ id: z.string().min(1), kind: TransferRoot.shape.kind, entry: TransferRoot.shape.entry, path: z.string(), files: z.array(TransferFile).optional() })),
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
/** The session a terminal resumes, and the command that resumes it again. */
type Carried = { revive: { command: string }; sessionId: string };

const SESSION_START_MS = 60_000;
const CONCURRENCY = 4;
// how long one look at a pane, through tmux and ps, may take
const LOOK_MS = 10_000;
// how long an agent must hold its pane without a SessionStart to count as up, and how often the pane is looked at; one
// that reports its SessionStart as it resumes, in a folder its CLI trusts, is given QUIET_MS, well past the ~2 s that takes
const SETTLE_MS = 3000;
const QUIET_MS = 10_000;
const LOOK_EVERY_MS = 500;
// how often a terminal counted up at a prompt is looked at until its session starts: at first, at most, and for how long
const WATCH_FIRST_MS = 2000;
const WATCH_MOST_MS = 60_000;
const WATCH_FOR_MS = 60 * 60_000;
// typed into a plain shell that came back empty, so whoever opens it knows its old job did not come along
const NOTICE = 'Svall restarted this shell after a handover; whatever ran here before did not move.';
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
  const { mobile, ...rest } = mergeConfig(fleet, NodeFile.parse(config));
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
  // terminals counted up at a prompt whose session has yet to start
  private watched = new Set<string>();
  private replicas: ReplicaStore;
  private clock: Clock;

  constructor(private journal: Journal, private ownership: OwnershipState, private agents: () => Promise<AgentProbe[]>, private d: DestinationDeps) {
    let home: string | undefined;
    // a home this machine cannot read refuses every claim, as homeProblem says
    try { home = (d.homedir ?? os.homedir)(); } catch { home = undefined; }
    const local = home === undefined ? undefined
      : machineLocal({ home, agentHomes: { claude: claudePaths(process.env, home).dir, codex: codexPaths(process.env, home).dir }, opencode: opencodeFolders(process.env, home) });
    this.replicas = new ReplicaStore({ fleetId: d.config.id, paths: d.paths, scanFs: d.scanFs, ...(local && { local }) });
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
          : wire(await this.replicas.inspect(r, { excludes: p.excludes, ...(r.files && { incoming: r.files }), keep: stays.keep(r.path) }));
        roots.push({ id: r.id, check });
      }
      const missing = (p.links ?? []).filter((l) => { try { fs.lstatSync(l); return false; } catch { return true; } });
      const untrusted: Pick<ResumeFolder, 'kind' | 'cwd'>[] = [];
      for (const f of p.resumes ?? []) if (!(await this.trusted(f))) untrusted.push({ kind: f.kind, cwd: f.cwd });
      const bypassing = (p.resumes ?? []).filter((f) => f.bypass);
      const bypassWarned: Pick<ResumeFolder, 'kind' | 'cwd'>[] = [];
      for (const f of bypassing) if (!(await this.bypassAccepted(f))) bypassWarned.push({ kind: f.kind, cwd: f.cwd });
      return {
        roots, folders: probeFolders(p.folders, this.d.probeFs), ...(p.links && { missing }), ...(stays.unproven.length && { unproven: stays.unproven }),
        ...(p.resumes && { untrusted }), ...(bypassing.length && { bypassWarned }),
      };
    });
  }

  /** Whether this machine's agent CLI of `folder`'s kind resumes there without first asking whether to trust it. */
  private async trusted(folder: ResumeFolder): Promise<boolean> {
    const { adapter, home } = await this.cli(folder.kind);
    return !adapter.trusts || (!!home && adapter.trusts(home, folder));
  }

  /** Whether this machine's agent CLI of `folder`'s kind starts in bypass mode there without first warning about it. */
  private async bypassAccepted(folder: ResumeFolder): Promise<boolean> {
    const { adapter, home } = await this.cli(folder.kind);
    return !adapter.acceptsBypass || (!!home && adapter.acceptsBypass(home, folder));
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

  /**
   * Lets go a handover this machine holds no journal of, once the gateway no longer holds it open either: its session
   * stage goes, and what it would seal stays until every root it names is sealed.
   */
  dropStage(transactionId: string): Promise<void> {
    return this.serial(async () => {
      const held = [path.dirname(this.d.paths.sessionStage(transactionId, 0)), this.d.paths.replicaSeal(transactionId)];
      if (this.open(transactionId) || !held.some((f) => fs.existsSync(f))) return;
      const record = await this.ask();
      if (record.transaction?.id === transactionId) return;
      const unsealed = await boundary('destination.abort.seal', () => this.sealAs(transactionId, true));
      if (unsealed.length) throw notReady(`handover ${transactionId} could not seal ${unsealed.join('; ')}; abort it again once that is put right`);
      boundary('destination.abort.stage', () => { for (const f of held) fs.rmSync(f, { recursive: true, force: true }); });
    });
  }

  /**
   * Lets go a handover a forced gateway record has superseded, as its abort would: what it prepared is never activated.
   * The record wins whatever stays unsealed, which is left receiving.
   */
  supersede(transactionId: string): Promise<void> {
    return this.serial(async () => {
      const j = this.open(transactionId);
      if (j) await this.discard(j, false);
    });
  }

  /**
   * Takes each root the manifest carries for the handover the gateway holds open for this machine, before anything
   * is written into it: rsync writes a root only at the path its claim answers, under the excludes it was proven with.
   * A root this machine has prepared from is not taken again, since a second copy would undo its Git import.
   */
  private async runClaim(p: Claim): Promise<Result<'handover.claim'>> {
    const m = p.manifest;
    const tx = p.transactionId;
    this.identify(p);
    if (this.open(tx)?.preparedDigest) throw notReady(`handover ${tx} is prepared on this machine, so nothing more is copied into its roots`);
    // each root at its own path here, before any is reserved
    const unsafe = [...this.homeProblem(m), ...manifestProblems(m, [])];
    if (unsafe.length) throw blocked(unsafe);
    await this.receiving(p);
    const stays = await this.staying(graphsHere(m));
    // written before any root is taken; one an earlier prepare of this manifest wrote stays, as its Git import left the roots
    const prior = this.recorded(tx, p.manifestDigest);
    if (!prior) {
      const claimed = SealRecord.parse({ transactionId: tx, generation: p.generation, manifestDigest: p.manifestDigest, roots: replicaRoots(m) });
      boundary('destination.claim.seal', () => writeDurable(this.d.paths.replicaSeal(tx), claimed, { mode: 0o600 }));
    }
    const roots: Result<'handover.claim'>['roots'] = [];
    for (const r of replicaRoots(m)) {
      const imported = prior?.roots.find((x) => x.id === r.id)?.files;
      const landed = p.landed?.find((x) => x.id === r.id)?.files;
      const claim = {
        transactionId: tx, excludes: m.excludes, incoming: m.roots.find((x) => x.id === r.id)!.files, keep: stays.keep(r.path), ...(imported && { imported }), ...(landed && { landed }),
      };
      let check = await boundary('destination.claim.root', () => this.replicas.claim(r, claim));
      let archivedTo: string | undefined;
      if (!check.ok && p.archive?.length && ARCHIVABLE.has(check.blocker.code)) {
        try {
          archivedTo = boundary('destination.claim.archive', () => this.replicas.archive(r, p.archive)).archivedTo;
          check = await boundary('destination.claim.root', () => this.replicas.claim(r, claim));
        } catch (e) {
          if (!(e instanceof ReplicaError && e.code === 'not_approved')) throw e;
        }
      }
      roots.push({ id: r.id, excludes: [...m.excludes], check: wire(check), ...(archivedTo && { archivedTo }), ...(check.ok && check.keep?.length && { keep: check.keep }) });
    }
    return { roots, ...(stays.unproven.length && { unproven: stays.unproven }) };
  }

  /** A fleet over another home would put its roots and its `~` where this account does not keep them; a home it cannot read is not taken on trust. */
  private homeProblem(m: TransferManifestV1): Blocker[] {
    let home: string;
    try { home = (this.d.homedir ?? os.homedir)(); } catch (e) {
      return [{ code: 'home_mismatch', message: `this machine cannot read its own home, so it cannot tell that it is the fleet's ${m.home}: ${(e as Error).message}` }];
    }
    return home === m.home ? [] : [{ code: 'home_mismatch', message: `this account's home is ${home} and the fleet's ${m.home}; a fleet moves only between accounts with the same home path` }];
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

  /** Once this machine runs the fleet it received, seals each root as the Git import left it at its generation, and closes the journal. */
  private async runComplete(p: ParsedParams<'handover.complete'>): Promise<Result<'handover.complete'>> {
    const j = this.open(p.transactionId);
    if (!j) return {};
    if (j.phase !== 'activate') throw notReady(`handover ${j.transactionId} is at ${j.phase} on this machine, and completes only once it has activated`);
    // a daemon started since the activation holds the fleet it activated until it runs it again, as the gateway's owner
    if (this.ownership.isOwner() && !this.ownership.writable()) {
      await this.committed(j);
      await this.run();
    }
    // an unsealed root would find itself occupied on the way back, so what could not be sealed keeps the record for another try
    const unsealed = await boundary('destination.complete.seal', () => this.sealAs(j.transactionId, false));
    if (unsealed.length) throw notReady(`handover ${j.transactionId} could not seal ${unsealed.join('; ')}; complete it again once that is put right`);
    boundary('destination.complete.clear', () => {
      for (const f of [this.d.paths.replicaSeal(j.transactionId), this.d.paths.preparedState(j.transactionId), path.dirname(this.d.paths.sessionStage(j.transactionId, 0))]) {
        fs.rmSync(f, { recursive: true, force: true });
      }
    });
    boundary('destination.complete.journal', () => this.journal.close());
    return {};
  }

  /**
   * Checks everything it can before its first write, journals, proves each root holds what the transfer
   * verified under this handover's claim, imports the Git graphs, places the sessions, and only then writes
   * the prepared state. A root verified once is not verified again: the import has since changed it.
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
      boundary('destination.prepare.stage', () => fs.rmSync(path.dirname(this.d.paths.sessionStage(tx, 0)), { recursive: true, force: true }));
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
      boundary('destination.verify.journal', () => this.journal.write(DestinationJournal.parse({
        role: 'destination', transactionId: tx, generation: p.generation, fleetId: this.d.config.id,
        fromMachineId: m.fromMachineId, toMachineId: m.toMachineId, phase: 'verify', manifestDigest: p.manifestDigest, updatedAt: this.clock.now(),
      })));
    }
    // a machine receiving a fleet runs nothing of it until activation
    this.ownership.hold(`handover ${tx} has not been activated on this machine`);
    const landedDigest = canonicalDigest(p.landed);
    const verified = this.open(tx)?.landedDigest === landedDigest;
    const at = new Map<string, string>();
    // the registrations of worktrees that stay here, which this handover's claim left as they were
    const stays = new Map<string, string[]>();
    const blockers: Blocker[] = [];
    await boundary('destination.verify.landed', async () => {
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
    });
    if (blockers.length) throw blocked(blockers);

    const git = gitProblems(m, [...at.values()]);
    if (git.length) throw blocked(git);
    // verified once the import may have changed the roots, and not before: a retry until then compares what landed again
    if (!verified) boundary('destination.verify.record', () => this.journal.write({ ...this.open(tx)!, landedDigest, updatedAt: this.clock.now() }));
    const registrations = carried.flatMap((r) => (stays.get(r.id) ?? []).map((rel) => path.posix.join(r.path, rel)));
    const keptNames = Object.fromEntries(graphsHere(m).map((g) => [g.id, registrations
      .filter((reg) => path.posix.dirname(reg) === path.posix.join(g.commonDir, 'worktrees')).map((reg) => path.posix.basename(reg))]));
    // what the import writes, by real path: each graph's config, and the registrations it neither carries nor keeps, which it removes
    const commons = graphsHere(m).map((g) => ({ common: realPath(g.commonDir), keep: new Set([...g.carried, ...keptNames[g.id]]) }));
    const written = (file: string): boolean => commons.some(({ common, keep }) => {
      const rel = path.posix.relative(common, file);
      return rel === 'config' || (rel.startsWith('worktrees/') && !keep.has(rel.split('/')[1]));
    });
    // what landed in a root, with each path the import writes as it now stands there
    const asImported = async (r: TransferRoot): Promise<TransferFile[]> => {
      const root = at.get(r.id)!;
      const there = (f: TransferFile): boolean => written(f.path ? path.posix.join(root, f.path) : root);
      const read = commons.some(({ common }) => holds(root, common) || holds(common, root));
      const scanned = read ? (await scanPath(root, rootMatcher(r.kind, m.excludes), this.d.scanFs))?.files ?? [] : [];
      return [...p.landed.find((x) => x.id === r.id)!.files.filter((f) => !there(f)), ...scanned.filter(there)];
    };
    let graphs: Blocker[];
    try {
      graphs = await importGraphs(m, { ...(this.d.git && { git: this.d.git }), kept: keptNames });
    } finally {
      // what Complete seals, or an abort leaves claimable: what landed, with what the import wrote however far it got and
      // nothing else written there meanwhile; a prepare asked again keeps what the one that proved it recorded
      const earlier = verified ? this.recorded(tx, p.manifestDigest) : undefined;
      const roots: SealRecord['roots'] = [];
      for (const r of carried) {
        const files = earlier?.roots.find((x) => x.id === r.id)?.files ?? await asImported(r);
        roots.push({ id: r.id, kind: r.kind, entry: r.entry, path: r.path, files });
      }
      const seal = SealRecord.parse({ transactionId: tx, generation: p.generation, manifestDigest: p.manifestDigest, roots });
      boundary('destination.prepare.seal', () => writeDurable(this.d.paths.replicaSeal(tx), seal, { mode: 0o600 }));
    }
    if (graphs.length) throw blocked(graphs);

    const placed: Blocker[] = [];
    m.sessions.forEach((s, i) => {
      try { installSession(s, this.d.paths.sessionStage(tx, i), this.d.install); } catch (e) {
        placed.push({ code: e instanceof SessionError ? e.code : 'transcript_missing', message: (e as Error).message, entity: { kind: 'character', id: s.characterId } });
      }
    });
    if (placed.length) throw blocked(placed);
    const unread = await this.importSessions(tx, m);
    if (unread.length) throw blocked(unread);

    const preparedDigest = canonicalDigest(state);
    const preparedPath = this.d.paths.preparedState(tx);
    boundary('destination.prepare.state', () => writeDurable(preparedPath, state, { mode: 0o600 }));
    boundary('destination.prepare.journal', () => this.journal.write({ ...this.open(tx)!, phase: 'prepare', preparedPath, preparedDigest, fleet: imported.fleet, updatedAt: this.clock.now() }));
    boundary('destination.prepare.stage', () => fs.rmSync(path.dirname(this.d.paths.sessionStage(tx, 0)), { recursive: true, force: true }));
    return { preparedDigest };
  }

  /**
   * Reads each carried session a CLI keeps in a database of its own into this machine's CLI from its stage, to resume
   * in its terminal's folder. Nothing revives a session it could not read in, as a resume would start an empty one.
   */
  private async importSessions(tx: string, m: TransferManifestV1): Promise<Blocker[]> {
    const blockers: Blocker[] = [];
    const at = (p: string) => (p === '~' || p.startsWith('~/') ? path.posix.join(m.home, p.slice(1)) : p);
    for (const [i, s] of m.sessions.entries()) {
      const adapter = sessionAdapter(s.agent, s.adapter);
      const c = m.snapshot.characters[s.characterId];
      if (!adapter.exportFile || !adapter.dropSession || !adapter.importSession || !c) continue;
      const file = path.join(this.d.paths.sessionStage(tx, i), adapter.exportFile(s.sessionId));
      const { cwd } = resumeFolder(c, s.term, at);
      const run = this.d.cli ?? cliRunner();
      try {
        await boundary('destination.prepare.delete', () => adapter.dropSession!(s.sessionId, file, cwd, run));
        await boundary('destination.prepare.import', () => adapter.importSession!(s.sessionId, file, cwd, run));
      } catch (e) {
        if (!(e instanceof SessionError)) throw e;
        blockers.push({ code: e.code, message: e.message, entity: { kind: 'character', id: s.characterId } });
      }
    }
    return blockers;
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
    const record = await this.committed(j);
    await boundary('destination.activate.install', () => this.ownership.installCommitted(record));
    if (j.phase === 'prepare') j = this.advance(j, 'commit');
    if (j.phase === 'commit') {
      this.promote(j);
      j = this.advance(j, 'activate');
    }
    await this.run();
    await this.wake(tx);
    return { characters: characterResults(this.open(tx)?.activation ?? []) };
  }

  /** Lets the fleet it activated run here. */
  private run(): Promise<void> {
    return boundary('destination.activate.fleet', async () => {
      this.ownership.unhold();
      await this.d.fleet.activate();
      await this.d.fleet.reconcileNow();
      await this.d.fleet.resumeInterrupted();
    });
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
    boundary('destination.promote.fleet', () => writeDurable(this.d.paths.fleetConfig, j.fleet!, { mode: 0o600 }));
    adopt(this.d.config, j.fleet!);
    const prepared = this.d.paths.preparedState(j.transactionId);
    boundary('destination.promote.state', () => {
      if (fs.existsSync(prepared)) {
        if (canonicalDigest(Store.readSnapshot(prepared)) !== j.preparedDigest) throw new Error(`${prepared} is not the state handover ${j.transactionId} prepared`);
        this.d.store.promote(prepared);
      } else if (canonicalDigest(Store.readSnapshot(this.d.paths.state)) === j.preparedDigest) {
        this.d.store.reload();
      } else {
        throw new Error(`the state handover ${j.transactionId} prepared is gone from ${prepared}`);
      }
    });
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
    // laying it dormant again builds its resume afresh, without the launch flags it carries, which are put back
    const carried: Carried | undefined = agent && slot.revive ? { revive: slot.revive, sessionId: agent.sessionId } : undefined;
    let held = slot.tmux ? (await this.holding(slot)).held : undefined;
    if (held === 'gone' || (held === 'shell' && agent)) {
      await this.lay(s, carried);
      held = undefined;
    }
    let started: { done: Promise<boolean>; cancel(): void } | undefined;
    let entry: Activation;
    // what to do again, should an agent counted up at a prompt leave it before its session starts
    let unanswered: string | undefined;
    // the folder whose trust prompt it was counted up at
    let asked: ResumeFolder | undefined;
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
        // an agent asks whether to trust its folder before any hook runs, so one that asks reports nothing until answered
        const folder: ResumeFolder = { kind: agent.kind, ...resumeFolder(c, s.term, expandHome) };
        const trusted = await this.trusted(folder);
        let up: Up = 'running';
        // one that reports its SessionStart as it resumes, yet holds its pane silent well past that, is at some other prompt
        let quiet = false;
        if (held !== 'agent') {
          // only a window left open can have started before this wait
          if (!held) this.heard.delete(keyOf(s));
          started = this.waitStart(s, agent.sessionId);
          if (!held) await this.openSlot(s);
          const reports = adapter.sessionStartOnResume && trusted;
          up = await this.settles(s, agent.kind, started, reports ? QUIET_MS : SETTLE_MS);
          started.cancel();
          quiet = reports && up === 'running';
        }
        if (typeof up === 'object') {
          await this.lay(s, carried);
          entry = { ...s, ok: false, sessionId: agent.sessionId, error: `${which} resumed ${agent.kind} session ${agent.sessionId}, ${up.failed}, so it is dormant again with that session; revive it to see` };
        } else {
          const answer = adapter.trustAnswer ? `choose "${adapter.trustAnswer}"` : 'answer it';
          const prompt = up === 'running' && !trusted;
          const notice = prompt ? `${agent.kind} waits at its "Trust this folder?" prompt in ${which}; ${answer} there`
            : quiet ? `${agent.kind} has not started its session in ${which} and may be waiting at a prompt there; answer it there` : undefined;
          if (prompt) {
            unanswered = `revive it and ${adapter.trustAnswer ? answer : 'trust its folder'} at its "Trust this folder?" prompt`;
            asked = folder;
          }
          if (quiet) unanswered = 'revive it to see';
          entry = { ...s, ok: true, sessionId: agent.sessionId, ...(notice && { notice }) };
        }
      }
    } catch (e) {
      started?.cancel();
      await this.lay(s, carried);
      entry = { ...s, ok: false, error: `${which} did not open: ${(e as Error).message}` };
    }
    if (entry.error) this.d.log.error(`handover ${tx}: ${entry.error}`);
    // watched before its row is written, which forgets a SessionStart already heard for it
    if (unanswered && agent) {
      this.watch(tx, s, which, agent, carried, unanswered, asked).catch((e: Error) => this.d.log.error(`handover ${tx}: ${which} is no longer watched: ${e.message}`));
    }
    this.recordSlot(tx, entry);
  }

  /**
   * Watches a terminal counted up at a prompt until its session starts, or, for an agent that starts none until its
   * first turn, until the folder it was `asked` to trust is trusted, the fleet leaving what it carries alone meanwhile.
   * One whose agent leaves the pane first is left dormant with that session and an error saying `then`, or, once that
   * folder is trusted and so the agent left at some later prompt, saying to answer that one. It looks less often as it
   * goes, and leaves the terminal to the fleet once the handover completes or an hour has passed.
   */
  private async watch(
    tx: string, s: Slot, which: string, agent: { kind: AgentKind; sessionId: string }, carried: Carried | undefined, then: string, asked?: ResumeFolder,
  ): Promise<void> {
    const key = keyOf(s);
    const started = this.waitStart(s, agent.sessionId);
    this.watched.add(key);
    let heard = false;
    const start = started.done.then((ok) => { heard = ok; });
    const until = this.clock.now() + WATCH_FOR_MS;
    try {
      const { adapter, home } = await this.cli(agent.kind);
      for (let every = WATCH_FIRST_MS; ; every = Math.min(every * 2, WATCH_MOST_MS)) {
        const nap = new AbortController();
        await Promise.race([this.clock.sleep(every, nap.signal), start]);
        nap.abort();
        const c = this.d.store.state.characters[s.characterId];
        const slot = s.term === 2 ? c?.second : c;
        // a later handover's rest answers for it from then on
        if (heard || slot?.restedBy !== tx || !this.open(tx) || this.clock.now() >= until) return;
        const answered = !!asked && (!adapter.trusts || (!!home && adapter.trusts(home, asked)));
        if (answered && !adapter.sessionStartOnResume) return;
        let look: Look;
        try { look = slot.tmux ? await this.holding(slot) : { held: 'gone' }; } catch { continue; }
        if (heard) return;
        if (look.held !== 'shell' && look.held !== 'gone') continue;
        const left = look.held === 'gone' ? 'its window closed' : `${agent.kind} exited back to its shell`;
        await this.lay(s, carried);
        const error = `${which} resumed ${agent.kind} session ${agent.sessionId}, but ${left} before that session started, so it is dormant again with that session; ${answered ? 'revive it and answer the prompt it waits at' : then}`;
        this.d.log.error(`handover ${tx}: ${error}`);
        this.recordSlot(tx, { ...s, ok: false, sessionId: agent.sessionId, error });
        return;
      }
    } finally {
      started.cancel();
      this.watched.delete(key);
    }
  }

  private openSlot(s: Slot): Promise<Character> {
    return boundary('destination.activate.open', () => (s.term === 2 ? this.d.fleet.openSecond(s.characterId) : this.d.fleet.reviveCharacter(s.characterId)));
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
   * How a resumed agent comes up: started once its SessionStart comes, running once its pane has held that agent for
   * `settleMs` on end without one, and otherwise what its pane showed instead.
   */
  private async settles(s: Slot, kind: AgentKind, started: { done: Promise<boolean> }, settleMs: number): Promise<Up> {
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
        if (now - since >= settleMs) return 'running';
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
  private async lay(s: Slot, carried?: Carried): Promise<void> {
    this.heard.delete(keyOf(s));
    const c = this.d.store.state.characters[s.characterId];
    const windowId = (s.term === 2 ? c?.second : c)?.tmux?.windowId;
    // dormant first, so the fleet hears the window close for a terminal that no longer holds it
    this.d.store.update((d) => {
      const cur = d.characters[s.characterId];
      if (s.term !== 2) { if (cur) { markDormant(cur); delete cur.revive?.interrupted; } } else if (cur?.second) markSlotDormant(cur.second);
      const slot = s.term === 2 ? cur?.second : cur;
      if (slot && carried && slot.agent?.sessionId === carried.sessionId) slot.revive = { ...carried.revive };
    });
    if (windowId) await boundary('destination.activate.kill', () => this.d.tmux.killWindow(windowId));
  }

  // whether the notice already shows on a pane's screen, typed or run; a screen that cannot be read shows nothing
  private told(paneId: string): Promise<boolean> {
    return this.d.tmux.capture(paneId, 200).then((b) => b.toString('utf8').includes(NOTICE), () => false);
  }

  private processes = (signal?: AbortSignal): Promise<ProcessTable> =>
    this.d.processes ? this.d.processes(signal) : ProcessTable.read({ signal, scripts: installedScripts(this.d.paths.home) });

  /** A terminal this handover rested and has not answered for, or one watched at a prompt: the fleet leaves the agent and resume command it carries alone. */
  private carrying(s: Slot): boolean {
    if (this.watched.has(keyOf(s))) return true;
    const state = this.journal.journalState();
    const j = state.kind === 'open' && state.journal.role === 'destination' ? state.journal : undefined;
    const c = this.d.store.state.characters[s.characterId];
    const slot = s.term === 2 ? c?.second : c;
    return !!j && slot?.restedBy === j.transactionId && !j.activation?.some((a) => keyOf(a) === keyOf(s));
  }

  /** Resolves true once the terminal's own session starts, or has been heard starting, and false once cancelled. */
  private waitStart(s: Slot, sessionId: string): { done: Promise<boolean>; cancel(): void } {
    const key = keyOf(s);
    if (this.heard.get(key) === sessionId) {
      this.heard.delete(key);
      return { done: Promise.resolve(true), cancel: () => {} };
    }
    let finish!: (ok: boolean) => void;
    const done = new Promise<boolean>((resolve) => {
      finish = (ok) => {
        if (this.waiters.get(key)?.done === finish) this.waiters.delete(key);
        resolve(ok);
      };
    });
    this.waiters.set(key, { sessionId, done: finish });
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
    // why a terminal did not come up stays on its record, which outlives this journal
    this.d.store.update((d) => {
      const c = d.characters[entry.characterId];
      const slot = entry.term === 2 ? c?.second : c;
      if (!slot) return;
      if (entry.error) slot.resumeError = entry.error; else delete slot.resumeError;
    });
    const j = this.open(tx);
    if (!j) return;
    const activation = [...(j.activation ?? []).filter((a) => keyOf(a) !== keyOf(entry)), entry];
    boundary('destination.activate.record', () => this.journal.write({ ...j, activation, updatedAt: this.clock.now() }));
    const result = characterResults(activation).find((r) => r.id === entry.characterId)!;
    this.journal.emitEntity({
      transactionId: tx, kind: 'character', id: entry.characterId, phase: 'activate', ...(result.error && { error: result.error }), ...(result.notice && { notice: result.notice }),
    });
  }

  /**
   * Lets a prepared handover go once the gateway can no longer commit it: the prepared files go, each root
   * is sealed as prepare recorded it so the next handover can claim it, and the hold lifts.
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
    await this.discard(j, true);
    return {};
  }

  /** `strict`: a root that cannot be sealed keeps the journal and what it would seal, for another try. */
  private async discard(j: DestinationJournal, strict: boolean): Promise<void> {
    // the content is the source's at the generation it keeps; a root sealed or archived since is left alone
    const unsealed = await boundary('destination.abort.seal', () => this.sealAs(j.transactionId, true));
    if (strict && unsealed.length) throw notReady(`handover ${j.transactionId} could not seal ${unsealed.join('; ')}; abort it again once that is put right`);
    boundary('destination.abort.clear', () => {
      for (const f of [this.d.paths.preparedState(j.transactionId), this.d.paths.replicaSeal(j.transactionId), path.dirname(this.d.paths.sessionStage(j.transactionId, 0))]) {
        fs.rmSync(f, { recursive: true, force: true });
      }
    });
    boundary('destination.abort.journal', () => this.journal.close());
    this.ownership.unhold();
  }

  /**
   * Seals each root the handover's record names as prepare recorded it, at the generation it prepared or, going `back`,
   * the one before, and answers what it could not seal; with no record there is nothing to seal. Going back, a root
   * prepare never read, or one no longer this handover's, is left as it is.
   */
  private async sealAs(transactionId: string, back: boolean): Promise<string[]> {
    const file = this.d.paths.replicaSeal(transactionId);
    let seal: SealRecord;
    try { seal = SealRecord.parse(JSON.parse(fs.readFileSync(file, 'utf8'))); } catch (e) {
      return (e as NodeJS.ErrnoException).code === 'ENOENT' ? [] : [`${file} (${(e as Error).message})`];
    }
    const generation = seal.generation - (back ? 1 : 0);
    const unsealed: string[] = [];
    for (const { files, ...root } of seal.roots) {
      try {
        if (back && (!files || !this.replicas.receives(root, transactionId))) continue;
        if (!files) throw new Error('prepare recorded nothing to seal there');
        this.replicas.seal(root, { transactionId, generation, manifestDigest: seal.manifestDigest, files }, 'destination');
      } catch (e) {
        this.d.log.error(`handover ${transactionId}: ${root.path} is left unsealed: ${(e as Error).message}`);
        unsealed.push(`${root.path} (${(e as Error).message})`);
      }
    }
    return unsealed;
  }

  /** The seal record a claim or prepare of this manifest wrote for a handover, when there is one it can read. */
  private recorded(transactionId: string, manifestDigest: string): SealRecord | undefined {
    try {
      const seal = SealRecord.parse(JSON.parse(fs.readFileSync(this.d.paths.replicaSeal(transactionId), 'utf8')));
      return seal.manifestDigest === manifestDigest ? seal : undefined;
    } catch {
      return undefined;
    }
  }

  private advance(j: DestinationJournal, phase: 'commit' | 'activate'): DestinationJournal {
    const next = { ...j, phase, updatedAt: this.clock.now() };
    boundary(phase === 'commit' ? 'destination.commit.journal' : 'destination.activate.journal', () => this.journal.write(next));
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
