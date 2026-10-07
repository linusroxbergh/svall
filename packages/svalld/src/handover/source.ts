import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import v8 from 'node:v8';
import { z } from 'zod';
import {
  FleetConfig, MAX_MANIFEST_BYTES, PROTOCOL_VERSION, STATE_SCHEMA_VERSION, TRANSFER_SCHEMA_VERSION, handoverError,
  type AgentAdapter, type AgentKind, type Blocker, type FleetId, type FleetState, type HandoverMachines, type HandoverPhase, type LandedRoot, type MachineId,
  type OwnerRecord, type ParsedParams, type Result, type SystemInfo, type TransactionRecord, type TransferManifestV1, type Warning,
} from '@svall/protocol';
import { codexPaths } from '../codex/install.js';
import { readFleetConfig } from '../config.js';
import { markDormant, markSlotDormant, reviveCommand } from '../dormancy.js';
import { AuthorityFailure } from '../gateway/authority.js';
import type { Fleet } from '../fleet.js';
import { runGit, type GitRunner } from '../links/git.js';
import type { Logger } from '../log.js';
import { opencodeFolders } from '../opencode/install.js';
import type { OwnershipState } from '../ownership/state.js';
import { claudePaths, expandHome, installedScripts, type Paths } from '../paths.js';
import { releaseVersion } from '../release.js';
import type { Tmux } from '../tmux/tmux.js';
import { boundary } from './failpoints.js';
import { extensionBlockers, gitVersion, readExtensions } from './git-extensions.js';
import { discoverGit } from './git-graph.js';
import { canonicalJson } from './hash.js';
import { buildInventory, expandExcludes, settle, type Inventory, type InventoryRoot, type MachineMaps } from './inventory.js';
import { SourceJournal } from './journal.js';
import { buildManifest, readManifest, realScanFs, summarize, writeManifest, type ScanFs } from './manifest.js';
import { ProcessTable } from './processes.js';
import { ReplicaStore, replicaRoots } from './replicas.js';
import { classifyTerminals, launchFlags, restChoices, restTerminals, serversGone, unapproved, type Clock, type RestDeps, type RestOptions } from './rest.js';
import type { HandoverService } from './service.js';
import { agentBlockers, cliRunner, sessionAdapter, type AgentProbe } from './sessions/registry.js';
import { SessionError, type CliRun } from './sessions/types.js';

/** The gateway's record for this fleet. Rejects when the gateway cannot be reached or will not say. */
export type Authority = { get(fleetId: FleetId): Promise<OwnerRecord> };

export type SourceDeps = {
  paths: Paths;
  store: RestDeps['store'];
  fleet: Pick<Fleet, 'settle' | 'activate' | 'deactivate' | 'reconcileNow' | 'resumeInterrupted' | 'reviveCharacter' | 'openSecond'>;
  tmux: RestDeps['tmux'] & Pick<Tmux, 'ensureServer'>;
  viewers: RestDeps['viewers'];
  processes?: NonNullable<RestDeps['processes']>;
  kill?: RestDeps['kill'];
  clock?: Clock;
  /** How to ask the gateway fleet.json names at the time of the call. A fleet no gateway holds has none: nothing can hand it over, and no one's word is needed to take it back. */
  authority?(): Authority | undefined;
  scanFs?: ScanFs;
  git?: GitRunner;
  rest?: Pick<RestOptions, 'waitMs' | 'settleMs' | 'pollMs' | 'callTimeoutMs'>;
  /** The most a manifest may come to. */
  manifestBytes?: number;
  /** This daemon's heap as V8 bounds it, in bytes. */
  heapLimit?: number;
  /** How to run an agent CLI that writes a session out of its own database. */
  cli?: CliRun;
  log: Logger;
};

type Journal = Pick<HandoverService, 'journalState' | 'write' | 'close' | 'emitEntity'>;
type FreezeParams = ParsedParams<'handover.freeze'>;
type Frozen = Result<'handover.freeze'>;

// how long preflight's one reading of ps and tmux may take
const CALL_TIMEOUT_MS = 10_000;

const aborting = (transactionId: string): Error =>
  handoverError({ code: 'transaction_mismatch', message: `handover ${transactionId} is being aborted`, expected: transactionId, actual: transactionId });

/** A handover needs the same release on both machines, and with it the same protocol and schemas. */
function compatibility(info: SystemInfo): Blocker[] {
  const out: Blocker[] = [];
  const release = releaseVersion();
  if (info.release !== release) out.push({ code: 'incompatible_release', message: `the destination runs release ${info.release}, this machine ${release}` });
  if (info.protocol !== PROTOCOL_VERSION) out.push({ code: 'incompatible_protocol', message: `the destination speaks protocol ${info.protocol}, this machine ${PROTOCOL_VERSION}` });
  if (info.stateSchema !== STATE_SCHEMA_VERSION) out.push({ code: 'incompatible_schema', message: `the destination reads state schema ${info.stateSchema}, this machine writes ${STATE_SCHEMA_VERSION}` });
  if (info.transferSchema !== TRANSFER_SCHEMA_VERSION) {
    out.push({ code: 'incompatible_schema', message: `the destination reads transfer manifest ${info.transferSchema}, this machine writes ${TRANSFER_SCHEMA_VERSION}` });
  }
  return out;
}

// a login or hooks the destination did not report count as missing
const probeOf = (a: AgentAdapter): AgentProbe =>
  ({ kind: a.kind, ...(a.version && { version: a.version }), home: a.home ?? '', loggedIn: a.loggedIn === true, hooks: a.hooks === true });

// a repository's own word on the platforms it runs on, kept at .svall/handover.json
const HandoverFile = z.object({ platforms: z.array(z.string()) });
const XCODE = /\.(xcodeproj|xcworkspace)$/;
const HANDOVER_FILE_MAX = 64 * 1024;

type FileReads = Pick<ScanFs, 'lstat'>;

/** A handover file's text, nothing when there is none, or why it cannot be read as one. */
async function readHandoverFile(file: string, sfs: FileReads): Promise<{ text?: string; problem?: string }> {
  const failed = (at: string, e: unknown): { problem?: string } => {
    const code = (e as NodeJS.ErrnoException).code;
    return code === 'ENOENT' || code === 'ENOTDIR' ? {} : { problem: `${at} cannot be read: ${code ?? String(e)}` };
  };
  // the repository root is followed, as its copy is; the .svall folder in it and the file are not
  const dir = path.dirname(file);
  let st: Awaited<ReturnType<ScanFs['lstat']>>;
  try { st = await sfs.lstat(dir); } catch (e) { return failed(dir, e); }
  if (st.isSymbolicLink()) return { problem: `${dir} is a symbolic link, and a handover file must lie in the repository itself` };
  // a file named .svall holds no handover file
  if (!st.isDirectory()) return {};
  try { st = await sfs.lstat(file); } catch (e) { return failed(file, e); }
  if (st.isSymbolicLink()) return { problem: `${file} is a symbolic link, and a handover file must be a regular file` };
  if (!st.isFile()) return { problem: `${file} is not a regular file, and a handover file must be one` };
  const over = { problem: `${file} is over ${HANDOVER_FILE_MAX / 1024} KiB, more than a handover file may hold` };
  if (st.size > HANDOVER_FILE_MAX) return over;
  // what is read is what was opened, never a link or a pipe put in its place since it was looked at
  let handle: fs.promises.FileHandle;
  try { handle = await fs.promises.open(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK); } catch (e) { return failed(file, e); }
  try {
    if (!(await handle.stat()).isFile()) return { problem: `${file} is not a regular file, and a handover file must be one` };
    const buf = Buffer.alloc(HANDOVER_FILE_MAX + 1);
    let size = 0;
    for (let n = -1; n !== 0 && size < buf.length; size += n) n = (await handle.read(buf, size, buf.length - size, size)).bytesRead;
    return size > HANDOVER_FILE_MAX ? over : { text: buf.subarray(0, size).toString('utf8') };
  } catch (e) {
    return failed(file, e);
  } finally {
    await handle.close();
  }
}

/** Each carried checkout whose handover file names platforms without the destination's, or cannot be read as one. */
async function platformBlockers(roots: InventoryRoot[], platform: string, sfs: FileReads): Promise<Blocker[]> {
  const out: Blocker[] = [];
  for (const root of roots.filter((r) => r.kind === 'repo' || r.kind === 'worktree')) {
    const file = path.join(root.path, '.svall', 'handover.json');
    const blocked = (message: string) => out.push({ code: 'platform_unsupported', message, entity: { kind: 'root', id: root.id } });
    const { text, problem } = await readHandoverFile(file, sfs);
    if (problem) blocked(problem);
    if (text === undefined) continue;
    let platforms: string[];
    try { platforms = HandoverFile.parse(JSON.parse(text)).platforms; } catch {
      blocked(`${file} is not a handover file, which names the platforms a repository runs on as { "platforms": ["darwin", "linux"] }`);
      continue;
    }
    if (!platforms.includes(platform)) blocked(`${file} says this repository runs on ${platforms.join(' and ') || 'no platform'}, and the destination is ${platform}`);
  }
  return out;
}

/** What only advises: an Xcode project is a Mac's to build. */
function platformWarnings(manifest: TransferManifestV1, platform: string): Warning[] {
  if (platform === 'darwin') return [];
  return manifest.roots.flatMap((r): Warning[] => {
    const projects = [...new Set(r.files.flatMap((f) => {
      const parts = f.path.split('/');
      const at = parts.findIndex((part, i) => i < parts.length - 1 && XCODE.test(part));
      return at < 0 ? [] : [parts.slice(0, at + 1).join('/')];
    }))].sort();
    if (!projects.length) return [];
    const named = `${projects.length === 1 ? 'an Xcode project' : 'Xcode projects'}, ${projects.join(', ')}`;
    return [{ code: 'platform_heuristic', message: `${r.path} holds ${named}, which does not build on ${platform}`, entity: { kind: 'root', id: r.id } }];
  });
}

/** A manifest too large to travel whole, as freeze's answer and as the claim and prepare that carry it. */
function oversize(m: TransferManifestV1, cap: number): Blocker | undefined {
  const bytes = Buffer.byteLength(JSON.stringify(m));
  const mib = (n: number): string => (n / 1024 / 1024).toFixed(1);
  return bytes <= cap ? undefined : {
    code: 'manifest_too_large',
    message: `the manifest comes to ${mib(bytes)} MiB, more than a handover carries (${mib(cap)} MiB); exclude what need not move, such as build output, in fleet.json handover.exclude`,
  };
}

// a daemon's peak RSS grew by up to 6.2 KB a carried file on a first 50,000-file handover; a handover may take half the smaller heap
export const HEAP_PER_FILE = 8 * 1024;

/** More files than the daemon with the smaller heap holds through a handover: the manifest, what landed, their JSON and the scans. */
function crowded(files: number, own: number, destination: number | undefined): Blocker | undefined {
  const [heap, whose] = destination !== undefined && destination < own ? [destination, "the destination's"] : [own, "this machine's"];
  const most = Math.floor(heap / 2 / HEAP_PER_FILE);
  return files <= most ? undefined : {
    code: 'too_many_files',
    message: `this handover carries ${files} files, and ${whose} daemon, with a ${(heap / 2 ** 30).toFixed(1)} GiB heap, holds at most ${most} through a handover; exclude what need not move, such as build output, in fleet.json handover.exclude`,
  };
}

const named = (m: TransferManifestV1, transactionId: string): Frozen['manifest'] => {
  if (m.transactionId !== transactionId) throw new Error(`the manifest names handover ${m.transactionId}, not ${transactionId}`);
  return { ...m, transactionId };
};

/**
 * The machine giving a fleet away: it checks without touching anything, freezes for the gateway's Begin and
 * answers the manifest, and takes the fleet back before a commit. One phase runs at a time.
 */
export class SourceHandover {
  private queue: Promise<unknown> = Promise.resolve();
  private freezing?: { transactionId: string; choices: string; cancel: AbortController; done: Promise<Frozen> };

  constructor(private journal: Journal, private ownership: OwnershipState, private agents: () => Promise<AgentProbe[]>, private d: SourceDeps) {}

  async preflight(p: ParsedParams<'handover.preflight'>): Promise<Result<'handover.preflight'>> {
    const state = this.d.store.state;
    const { blockers, inventory } = await this.check(p.toMachineId, p, state);
    // Freeze asks the gateway on its own, with no one to answer a prompt: asked here first, read-only
    const authority = this.d.authority?.();
    if (authority) {
      await authority.get(this.fleet().id).catch((e: unknown) => {
        blockers.push(e instanceof AuthorityFailure && e.code === 'identity_mismatch'
          ? { code: 'identity_mismatch', message: `this machine's route to its gateway leads elsewhere: ${e.message}` }
          : { code: 'ssh_interactive', message: `this machine could not ask its gateway who owns this fleet, as Freeze must without a prompt: ${(e as Error).message}` });
      });
    }
    const signal = AbortSignal.timeout(CALL_TIMEOUT_MS);
    const [live, table] = await Promise.all([this.d.tmux.listWindows(signal), this.processes(signal)]);
    const terminals = classifyTerminals(state, live, table);
    blockers.push(...unapproved(state, terminals, restChoices(p.choices)));
    // each running agent carries the revive its rest will record, so the destination is asked about the flags it resumes with
    for (const t of terminals) {
      const c = inventory.snapshot.characters[t.characterId];
      const slot = t.term === 2 ? c?.second : c;
      if (slot?.agent) slot.revive = { command: reviveCommand(slot, launchFlags(t)) };
    }
    const header = { generation: this.ownership.record().generation };
    // counted from names before any file is read, so a fleet far past the bound is refused without being hashed
    const names = await buildManifest(inventory, header, this.d.scanFs, false);
    const crowd = this.crowded(names.listed.files, p.destination.info);
    const built = crowd ? names : await buildManifest(inventory, header, this.d.scanFs);
    const big = crowd ? [crowd] : this.limits(built.manifest, p.destination.info);
    // one too large to answer whole is answered without its file lists
    const manifest = big.length
      ? { ...built.manifest, roots: built.manifest.roots.map((r) => ({ ...r, files: [] })), sessions: built.manifest.sessions.map((x) => ({ ...x, files: [] })) }
      : built.manifest;
    return {
      manifestSummary: crowd ? { ...summarize(manifest), ...names.listed } : summarize(built.manifest),
      blockers: settle([...blockers, ...built.blockers, ...big]),
      warnings: settle([...built.warnings, ...platformWarnings(built.manifest, p.destination.info.platform)]),
      manifest,
    };
  }

  /**
   * A freeze asked again while one runs for the same handover waits for that one's answer; asked with other
   * choices, it stops that one's wait and rests with its own.
   */
  freeze(p: FreezeParams): Promise<Frozen> {
    const choices = canonicalJson(p.choices);
    const running = this.freezing;
    if (running?.transactionId === p.transactionId) {
      if (running.choices === choices) return running.done;
      running.cancel.abort(handoverError({ code: 'not_ready', message: `handover ${p.transactionId} was asked to freeze again with other choices, and that freeze answers instead` }));
    }
    const cancel = new AbortController();
    const done = this.serial(() => this.runFreeze(p, cancel.signal));
    const entry = { transactionId: p.transactionId, choices, cancel, done };
    this.freezing = entry;
    const clear = () => { if (this.freezing === entry) this.freezing = undefined; };
    done.then(clear, clear);
    return done;
  }

  /** A freeze still waiting on its terminals gives way; one already closing windows finishes first. */
  abort(p: ParsedParams<'handover.abort'>): Promise<Result<'handover.abort'>> {
    if (this.freezing?.transactionId === p.transactionId) this.freezing.cancel.abort(aborting(p.transactionId));
    return this.serial(() => this.runAbort(p));
  }

  complete(p: ParsedParams<'handover.complete'>): Promise<Result<'handover.complete'>> {
    return this.serial(() => this.runComplete(p));
  }

  /**
   * Lets go a handover a forced gateway record has superseded: nothing can commit it any more. The terminals it
   * stopped reopen only when the record names this machine; the caller takes the record.
   */
  supersede(transactionId: string, revive: boolean): Promise<void> {
    if (this.freezing?.transactionId === transactionId) this.freezing.cancel.abort(aborting(transactionId));
    return this.serial(async () => {
      const held = this.open(transactionId);
      if (!held) return;
      if (revive) await this.revive(transactionId, held.stoppedTerminals, 'aborted');
      fs.rmSync(this.d.paths.manifest(transactionId), { force: true });
      this.journal.close();
    });
  }

  private async runFreeze(p: FreezeParams, cancel: AbortSignal): Promise<Frozen> {
    const held = this.open(p.transactionId);
    if (held?.phase === 'aborted') throw aborting(p.transactionId);
    if (held?.manifestDigest) return { manifest: this.kept(held) };
    const tx = await this.begun(p);
    cancel.throwIfAborted();
    // the journal first: a start that finds it surrenders the fleet whatever owner.json says
    if (!held) {
      boundary('source.freeze.journal', () => this.journal.write(SourceJournal.parse({
        role: 'source', transactionId: tx.id, generation: p.generation, fleetId: this.fleet().id,
        fromMachineId: tx.fromMachineId, toMachineId: tx.toMachineId, phase: 'freeze', updatedAt: this.now(),
      })));
    }
    const cache = this.ownership.record();
    if (!(cache.frozen && cache.transaction?.id === tx.id)) await boundary('source.freeze.surrender', () => this.ownership.freeze(tx));
    await this.d.fleet.settle();

    const found = await this.check(tx.toMachineId, p, this.d.store.state);
    // what the manifest would refuse, found from names alone while every terminal still runs
    const names = await buildManifest(found.inventory, { transactionId: tx.id, generation: p.generation }, this.d.scanFs, false);
    const crowd = this.crowded(names.listed.files, p.destination.info);
    const before = [...found.blockers, ...names.blockers, ...(crowd ? [crowd] : [])];
    if (before.length) return this.refuse(tx.id, before);
    const ids = Object.keys(this.d.store.state.characters);
    for (const id of ids) this.progress(tx.id, id);
    const { store, tmux, viewers, kill, clock } = this.d;
    const rested = await restTerminals(
      { store, tmux, viewers, journal: this.journal, processes: this.processes, kill, clock },
      { ...this.d.rest, choices: restChoices(p.choices), cancel },
    );
    if (!rested.ok) return this.refuse(tx.id, rested.blockers);

    // the snapshot is taken with every terminal dormant and its resume command recorded
    const inventory = await this.inventory(this.d.store.state, p);
    const unexported = await boundary('source.freeze.export', () => this.exportSessions(inventory, false));
    if (unexported.length) return this.refuse(tx.id, unexported);
    const built = await buildManifest(inventory, { transactionId: tx.id, generation: p.generation }, this.d.scanFs);
    const big = this.limits(built.manifest, p.destination.info);
    if (built.blockers.length || big.length) return this.refuse(tx.id, [...built.blockers, ...big]);
    const file = this.d.paths.manifest(tx.id);
    const manifestDigest = boundary('source.freeze.manifest', () => {
      // a manifest no journal names is left by an attempt that did not live to record it
      fs.rmSync(file, { force: true });
      return writeManifest(file, built.manifest);
    });
    boundary('source.freeze.digest', () => this.journal.write({ ...this.open(tx.id)!, manifestDigest, updatedAt: this.now() }));
    for (const id of ids) {
      const n = rested.terminals.filter((t) => t.characterId === id).length;
      this.progress(tx.id, id, { done: n, total: n });
    }
    return { manifest: named(built.manifest, tx.id) };
  }

  private async runAbort(p: ParsedParams<'handover.abort'>): Promise<Result<'handover.abort'>> {
    const held = this.open(p.transactionId);
    const cache = this.ownership.record();
    if (!held && !cache.frozen && !cache.surrendered) return {};
    if (!held && cache.transaction && cache.transaction.id !== p.transactionId) {
      throw handoverError({
        code: 'transaction_mismatch', message: `this fleet is frozen for handover ${cache.transaction.id}, not ${p.transactionId}`,
        expected: p.transactionId, actual: cache.transaction.id,
      });
    }
    await this.mayTakeBack(p);
    if (held) boundary('source.abort.journal', () => this.journal.write({ ...held, phase: 'aborted', updatedAt: this.now() }));
    await this.revive(p.transactionId, held?.stoppedTerminals ?? [], 'aborted');
    await this.release(p.transactionId);
    return {};
  }

  /**
   * Once the gateway has moved the fleet on, seals each root as the transfer verified it, so the way back can
   * claim it, takes the gateway's record, which leaves this machine a replica, ends the fleet here so the way back
   * starts it afresh, and closes the journal.
   */
  private async runComplete(p: ParsedParams<'handover.complete'>): Promise<Result<'handover.complete'>> {
    const held = this.open(p.transactionId);
    if (!held) return {};
    if (held.phase === 'aborted') throw aborting(p.transactionId);
    const record = await this.ask();
    const tx = record.transaction;
    const moved = record.ownerMachineId !== this.ownership.machineId && record.generation > held.generation;
    if (!moved || (tx?.id === held.transactionId && tx.phase !== 'committed')) {
      throw handoverError({
        code: 'not_ready',
        message: `the gateway holds this fleet for ${record.ownerMachineId} at generation ${record.generation}; handover ${held.transactionId} has not committed, so it can only be aborted`,
      });
    }
    boundary('source.complete.seal', () => this.seal(held, p.landed ?? []));
    await boundary('source.complete.install', () => this.ownership.installCommitted(record));
    await boundary('source.complete.deactivate', () => this.d.fleet.deactivate());
    boundary('source.complete.manifest', () => fs.rmSync(this.d.paths.manifest(held.transactionId), { force: true }));
    boundary('source.complete.journal', () => this.journal.close());
    return {};
  }

  // a root's content is what the transfer verified there, or the frozen manifest's where the controller no longer knows
  private seal(j: SourceJournal, landed: readonly LandedRoot[]): void {
    let manifest: TransferManifestV1;
    try { manifest = this.kept(j); } catch (e) {
      // an earlier complete sealed with it and removed it before a crash kept it from closing the journal
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return;
      this.d.log.error(`handover ${j.transactionId}: no root is sealed, since its manifest cannot be read: ${(e as Error).message}`);
      return;
    }
    const replicas = new ReplicaStore({ fleetId: manifest.fleet.id, paths: this.d.paths, scanFs: this.d.scanFs });
    for (const root of replicaRoots(manifest)) {
      const files = landed.find((x) => x.id === root.id)?.files ?? manifest.roots.find((r) => r.id === root.id)!.files;
      try {
        replicas.seal(root, { transactionId: j.transactionId, generation: j.generation + 1, manifestDigest: j.manifestDigest!, files }, 'source');
      } catch (e) {
        this.d.log.error(`handover ${j.transactionId}: ${root.path} is left unsealed, so the way back will find it occupied: ${(e as Error).message}`);
      }
    }
  }

  /** A manifest too large to travel whole, or with more files than either daemon holds through a handover. */
  private limits(m: TransferManifestV1, destination: SystemInfo): Blocker[] {
    const files = m.roots.reduce((n, r) => n + r.files.length, 0) + m.sessions.reduce((n, s) => n + s.files.length, 0);
    return [oversize(m, this.d.manifestBytes ?? MAX_MANIFEST_BYTES), this.crowded(files, destination)].filter((b) => b !== undefined);
  }

  private crowded(files: number, destination: SystemInfo): Blocker | undefined {
    return crowded(files, this.d.heapLimit ?? v8.getHeapStatistics().heap_size_limit, destination.heapLimit);
  }

  /** What stops the move before any terminal is touched: identities, releases, agent CLIs, characters kept here, platforms and paths. */
  private async check(toMachineId: MachineId, p: HandoverMachines, state: FleetState): Promise<{ blockers: Blocker[]; inventory: Inventory }> {
    const { info } = p.destination;
    const blockers: Blocker[] = [];
    const mismatch = (message: string) => blockers.push({ code: 'identity_mismatch', message });
    if (!this.d.authority?.()) mismatch('this fleet names no gateway, so no other machine can be handed it');
    if (toMachineId === this.ownership.machineId) mismatch('the destination is this machine, which already runs this fleet');
    if (info.machineId !== toMachineId) mismatch(`the destination described is ${info.machineId}, not ${toMachineId}`);
    blockers.push(...compatibility(info));
    const kinds = Object.values(state.characters).flatMap((c) => [c.agent?.kind, c.second?.agent?.kind]).filter((k): k is AgentKind => k !== undefined);
    blockers.push(...agentBlockers({ kinds, source: await this.agents(), destination: info.agentAdapters.map(probeOf) }));
    for (const c of Object.values(state.characters)) {
      if (c.keepHere) blockers.push({ code: 'character_pinned', message: `${c.name} is kept on this machine`, entity: { kind: 'character', id: c.id } });
    }
    const inventory = await this.inventory(state, p);
    blockers.push(...await this.exportSessions(inventory, true));
    blockers.push(...await platformBlockers(inventory.roots, info.platform, this.d.scanFs ?? realScanFs));
    blockers.push(...await this.gitBlockers(inventory, info));
    return { blockers: [...blockers, ...inventory.blockers], inventory };
  }

  /**
   * Writes each session a CLI keeps in a database of its own out to its export file, or with `dry`, only proves the CLI
   * holds it. A session its adapter cannot find is the manifest's to report.
   */
  private async exportSessions(inventory: Inventory, dry: boolean): Promise<Blocker[]> {
    const blockers: Blocker[] = [];
    for (const s of inventory.sessions) {
      const adapter = sessionAdapter(s.agent);
      if (!adapter.exportFile || !adapter.exportSession) continue;
      let home: string;
      try { ({ home } = await adapter.discover(s.sourcePath, s.sessionId, this.d.scanFs ?? realScanFs)); } catch (e) {
        if (e instanceof SessionError) continue;
        throw e;
      }
      try {
        const c = inventory.snapshot.characters[s.characterId];
        const cwd = (s.term === 2 ? c?.second?.cwd : undefined) ?? c?.cwd ?? os.homedir();
        await adapter.exportSession(s.sessionId, dry ? os.devNull : path.join(home, adapter.exportFile(s.sessionId)), this.d.cli ?? cliRunner(), expandHome(cwd));
      } catch (e) {
        if (!(e instanceof SessionError)) throw e;
        blockers.push({ code: e.code, message: e.message, entity: { kind: 'character', id: s.characterId } });
      }
    }
    return blockers;
  }

  /** Each carried repository using a Git extension the destination's git cannot open, found before anything moves. */
  private async gitBlockers(inventory: Inventory, info: SystemInfo): Promise<Blocker[]> {
    if (!inventory.git?.length) return [];
    const git = this.d.git ?? runGit;
    const graphs = await Promise.all(inventory.git.map(async (g) => ({ id: g.id, commonDir: g.commonDir, ...(await readExtensions(g.commonDir, git)) })));
    return extensionBlockers(graphs, { destination: info.git, source: await gitVersion(git) });
  }

  /** The inventory of `state`, with every repository graph a character stands in read from Git. */
  private async inventory(state: FleetState, p: HandoverMachines): Promise<Inventory> {
    const fleet = this.fleet();
    const git = await discoverGit(state, { excludes: expandExcludes(fleet.handover).excludes, git: this.d.git });
    return buildInventory(state, { fleet }, this.maps(p), git);
  }

  /** The gateway's Begin for this handover: it names this machine, the destination described and this generation. */
  private async begun(p: FreezeParams): Promise<TransactionRecord> {
    const record = await this.ask();
    const me = this.ownership.machineId;
    const tx = record.transaction;
    if (record.ownerMachineId !== me) {
      throw handoverError({ code: 'not_owner', message: `the gateway names ${record.ownerMachineId} as this fleet's owner`, ownerMachineId: record.ownerMachineId, generation: record.generation });
    }
    if (record.generation !== p.generation) {
      throw handoverError({ code: 'generation_mismatch', message: `the gateway holds this fleet at generation ${record.generation}, not ${p.generation}`, expected: p.generation, actual: record.generation });
    }
    if (!tx || tx.id !== p.transactionId) {
      throw handoverError({
        code: 'transaction_mismatch', message: tx ? `the gateway holds handover ${tx.id}, not ${p.transactionId}` : 'the gateway holds no handover of this fleet',
        expected: p.transactionId, ...(tx && { actual: tx.id }),
      });
    }
    const to = p.destination.info.machineId;
    const refuse = (message: string) => handoverError({ code: 'transaction_mismatch', message, expected: p.transactionId, actual: tx.id });
    if (tx.fromMachineId !== me || tx.toMachineId !== to) throw refuse(`handover ${tx.id} moves this fleet from ${tx.fromMachineId} to ${tx.toMachineId}, not from this machine to ${to}`);
    if (tx.phase !== 'preparing') throw refuse(`handover ${tx.id} is ${tx.phase}; only one still preparing can freeze this fleet`);
    return tx;
  }

  /** The gateway's word that nothing can commit this handover any more: this machine owns the fleet at the generation, and the handover is closed. */
  private async mayTakeBack(p: ParsedParams<'handover.abort'>): Promise<void> {
    // no gateway holds a standalone fleet, so no other machine can have been handed it
    if (!this.d.authority?.()) return;
    const record = await this.ask();
    const tx = record.transaction;
    if (record.ownerMachineId !== this.ownership.machineId || (tx?.id === p.transactionId && tx.phase === 'committed')) {
      throw handoverError({
        code: 'handover_committed', message: `the gateway names ${record.ownerMachineId} as this fleet's owner at generation ${record.generation}; this machine stays frozen`,
        transactionId: p.transactionId, generation: record.generation,
      });
    }
    if (record.generation !== p.generation) {
      throw handoverError({ code: 'generation_mismatch', message: `the gateway holds this fleet at generation ${record.generation}, not ${p.generation}`, expected: p.generation, actual: record.generation });
    }
    // this handover, or another this machine began that got past preparing, could still be committed over an unfrozen fleet
    if (tx && (tx.id === p.transactionId || (tx.fromMachineId === this.ownership.machineId && tx.phase !== 'preparing'))) {
      throw handoverError({ code: 'not_ready', message: `the gateway still holds handover ${tx.id} open (${tx.phase}); abort it there before this machine takes the fleet back` });
    }
  }

  private async ask(): Promise<OwnerRecord> {
    const authority = this.d.authority?.();
    if (!authority) throw handoverError({ code: 'transaction_mismatch', message: 'this fleet names no gateway, so no handover of it can have begun' });
    try {
      return await authority.get(this.fleet().id);
    } catch (e) {
      throw handoverError({ code: 'authority_unreachable', message: `the gateway could not say who owns this fleet: ${(e as Error).message}` });
    }
  }

  /** No manifest was answered, so nothing can commit this handover: the terminals it stopped reopen and the fleet runs again. */
  private async refuse(transactionId: string, blockers: Blocker[]): Promise<never> {
    const found = settle(blockers);
    await this.revive(transactionId, this.open(transactionId)?.stoppedTerminals ?? [], 'freeze');
    await this.release(transactionId);
    for (const b of found) if (b.entity?.kind === 'character') this.progress(transactionId, b.entity.id, { error: b.message });
    throw handoverError({ code: 'blocked', message: found.map((b) => b.message).join('; '), blockers: found });
  }

  /** Reopens the terminals this handover stopped, and only those; one that will not open is reported and left dormant. */
  private async revive(transactionId: string, stopped: SourceJournal['stoppedTerminals'], phase: HandoverPhase): Promise<void> {
    if (!stopped.length) return;
    await this.d.tmux.ensureServer();
    // a terminal whose window a rest that died closed still names that window, and reopens only once it names none
    const live = new Set((await this.d.tmux.listWindows()).map((w) => w.windowId));
    const { store, kill, clock } = this.d;
    // an OpenCode resumed beside the server its closed window left would share its database with it
    await serversGone({ store, journal: this.journal, processes: this.processes, kill, clock }, this.d.rest ?? {}, (t) => {
      const c = store.state.characters[t.characterId];
      const window = (t.term === 2 ? c?.second : c)?.tmux?.windowId;
      return !window || !live.has(window);
    });
    this.d.store.update((d) => {
      for (const t of stopped) {
        const c = d.characters[t.characterId];
        const slot = t.term === 2 ? c?.second : c;
        if (!c || !slot?.tmux || live.has(slot.tmux.windowId)) continue;
        if (t.term === 2) markSlotDormant(slot, t.flags);
        else { markDormant(c, t.flags); delete c.revive?.interrupted; }
      }
    });
    for (const t of stopped) {
      const c = this.d.store.state.characters[t.characterId];
      if (!c || (t.term === 2 && !c.second)) continue;
      try {
        await boundary('source.revive', () => (t.term === 2 ? this.d.fleet.openSecond(c.id) : this.d.fleet.reviveCharacter(c.id)));
        this.progress(transactionId, c.id, {}, phase);
      } catch (e) {
        this.d.log.error(`handover ${transactionId}: ${c.name}'s ${t.term === 2 ? 'second ' : ''}terminal did not reopen: ${(e as Error).message}`);
        this.progress(transactionId, c.id, { error: (e as Error).message }, phase);
      }
    }
  }

  /**
   * Back to running the fleet: the manifest goes while the journal still names it, so no crash leaves it behind, the
   * journal closes while the surrender still stands, then the background work starts.
   */
  private async release(transactionId: string): Promise<void> {
    boundary('source.release.manifest', () => fs.rmSync(this.d.paths.manifest(transactionId), { force: true }));
    if (this.journal.journalState().kind === 'open') boundary('source.release.journal', () => this.journal.close());
    await boundary('source.release.unfreeze', () => this.ownership.unfreeze());
    await boundary('source.release.activate', async () => {
      await this.d.fleet.activate();
      await this.d.fleet.reconcileNow();
      await this.d.fleet.resumeInterrupted();
    });
  }

  /** The manifest a freeze answered before, which is what it answers again. */
  private kept(j: SourceJournal): Frozen['manifest'] {
    const { manifest, digest } = readManifest(this.d.paths.manifest(j.transactionId));
    if (digest !== j.manifestDigest) throw new Error(`the manifest kept for handover ${j.transactionId} is not the one it froze with`);
    return named(manifest, j.transactionId);
  }

  private maps(p: HandoverMachines): MachineMaps {
    const { info, home, fleetHome } = p.destination;
    return {
      source: { machineId: this.ownership.machineId, home: p.source.home, fleetHome: this.d.paths.home, agentHomes: { claude: claudePaths().dir, codex: codexPaths().dir }, opencode: opencodeFolders() },
      destination: {
        machineId: info.machineId, home, fleetHome,
        agentHomes: Object.fromEntries(info.agentAdapters.flatMap((a) => (a.home ? [[a.kind, a.home]] : []))),
      },
    };
  }

  private open(transactionId: string): SourceJournal | undefined {
    const s = this.journal.journalState();
    return s.kind === 'open' && s.journal.role === 'source' && s.journal.transactionId === transactionId ? s.journal : undefined;
  }

  private progress(transactionId: string, id: string, more: { done?: number; total?: number; error?: string } = {}, phase: HandoverPhase = 'freeze'): void {
    this.journal.emitEntity({ transactionId, kind: 'character', id, phase, ...more });
  }

  private processes = (signal?: AbortSignal): Promise<ProcessTable> =>
    this.d.processes ? this.d.processes(signal) : ProcessTable.read({ signal, scripts: installedScripts(this.d.paths.home) });

  private fleet(): FleetConfig {
    return readFleetConfig(this.d.paths);
  }

  private now(): number {
    return this.d.clock?.now() ?? Date.now();
  }

  private serial<T>(work: () => Promise<T>): Promise<T> {
    const run = this.queue.then(work, work);
    this.queue = run.catch(() => {});
    return run;
  }
}
