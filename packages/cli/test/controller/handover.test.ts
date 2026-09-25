import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { WebSocketServer, type WebSocket } from 'ws';
import {
  FleetConfig, FleetId, FleetState, MachineId, PROTOCOL_VERSION, TRANSFER_SCHEMA_VERSION, emptyState,
  type Blocker, type Character, type HandoverChoices, type HandoverPhase, type LandedRoot, type OwnerRecord, type SystemInfo, type TransferFile,
} from '@archipelago/protocol';
import { transition, type OwnerOp } from '@archipelago/archid/gateway/authority';
import { AuthorityClient } from '@archipelago/archid/gateway/client';
import { startAuthorityServer } from '@archipelago/archid/gateway/server';
import { canonicalDigest } from '@archipelago/archid/handover/hash';
import { manifestDigest, spaceNeed } from '@archipelago/archid/handover/manifest';
import { contentDigest, replicaRoots } from '@archipelago/archid/handover/replicas';
import { resolvePaths } from '@archipelago/archid/paths';
import type { HandoverEvent, Outcome } from '../../src/controller/events.js';
import { Handover, Refused, type Daemon, type Gateway, type HandoverDeps, type Side } from '../../src/controller/handover.js';
import { connectHandover, gatewayOf, reconnecting } from '../../src/controller/reach.js';
import { remoteOwner } from '../../src/controller/authority.js';
import { fileStore, type ControllerJournal, type ControllerStore, type FrozenManifest } from '../../src/controller/recovery.js';
import { FleetMismatch, resolveOwner } from '../../src/controller/connection.js';
import { readRoute } from '../../src/controller/route.js';
import { SshError, SshMaster } from '../../src/controller/ssh.js';
import { installFakeSsh } from './fake-ssh.js';
import { MachineRegistry } from '../../src/controller/registry.js';
import { ApiError, Client } from '../../src/client.js';
import type { Master, RootEntry, TransferOptions, TransferResult } from '../../src/controller/transfer.js';
import { cleanHomes, makeHome } from '../../../archid/test/helpers.js';

const fleetId = FleetId.parse(crypto.randomUUID());
const mac = MachineId.parse(crypto.randomUUID());
const trift = MachineId.parse(crypto.randomUUID());
const SID = '3f2b8c1e-6a4d-4e7b-9c21-5d8f0a1b2c3d';
const CODEX = '01a0cd02-8ea0-75c1-89b3-89718ecbd91f';
const TOKEN = 'daemon-t0ken-never-written';
const G = 4;

const sha = (s: string): string => crypto.createHash('sha256').update(s).digest('hex');
const file = (p: string): TransferFile => ({ type: 'file', path: p, mode: 0o644, size: p.length, mtimeMs: 0, sha256: sha(p) });
const char = (id: string, name: string, cwd: string, over: Partial<Character> = {}): Character => ({
  id, islandId: 'home', cell: { x: 0, y: 1 }, name, portrait: 'fox', note: '', instructions: '', cwd, context: [],
  shell: { lastOutputAt: 0 }, unread: false, revive: { command: '' }, ...over,
});

const HOMES = { mac: { home: '/Users/ada' }, trift: { home: '/home/ada', work: '/srv/work' } };
const FLEET_HOMES = { mac: '/Users/ada/.archipelago', trift: '/home/ada/.archipelago' };

/** The manifest a source freezes: a repository with a folded worktree, a Git directory of its own, and one Claude session. */
function manifestFor(tx: string | undefined, from = mac, to = trift): FrozenManifest {
  const [src, dst] = from === mac ? [HOMES.mac, HOMES.trift] : [HOMES.trift, HOMES.mac];
  const at = (roots: { home: string }, p: string) => path.posix.join(roots.home, p);
  const snapshot = emptyState();
  snapshot.characters.c_ada = char('c_ada', 'ada', at(src, 'app'), {
    agent: { kind: 'claude', sessionId: SID, transcriptPath: at(src, `.claude/projects/-app/${SID}.jsonl`), status: 'idle', lastActivityAt: 0 },
  });
  snapshot.characters.c_bo = char('c_bo', 'bo', at(src, 'app'), {
    agent: { kind: 'codex', sessionId: CODEX, transcriptPath: at(src, `.codex/sessions/rollout-${CODEX}.jsonl`), status: 'idle', lastActivityAt: 0 },
  });
  return {
    version: TRANSFER_SCHEMA_VERSION, transactionId: tx as string, generation: G, fromMachineId: from, toMachineId: to,
    sourceRoots: src, destinationRoots: dst, fleet: FleetConfig.parse({ id: fleetId, gatewayMachineId: trift }),
    snapshot: FleetState.parse(snapshot), excludes: ['node_modules/', 'logs/'],
    roots: [
      { id: 'r_app', kind: 'repo', entry: 'dir', sourcePath: at(src, 'app'), destinationPath: at(dst, 'app'), files: [file('a.txt'), file('Readme.md'), file('README.md')] },
      { id: 'r_wt', kind: 'worktree', entry: 'dir', sourcePath: at(src, 'app/.claude/worktrees/x'), destinationPath: at(dst, 'app/.claude/worktrees/x'), foldedInto: 'r_app', files: [] },
      { id: 'r_git', kind: 'gitdir', entry: 'dir', sourcePath: at(src, 'app.git'), destinationPath: at(dst, 'app.git'), files: [file('HEAD'), file('logs/HEAD')] },
    ],
    sessions: [
      {
        characterId: 'c_ada', agent: 'claude', sessionId: SID, sourcePath: at(src, `.claude/projects/-app/${SID}.jsonl`),
        sourceHome: at(src, '.claude'), destinationHome: at(dst, '.claude'), destinationPath: at(dst, `.claude/projects/-app/${SID}.jsonl`), adapter: 1,
        files: [file(`projects/-app/${SID}.jsonl`), file(`projects/-app/${SID}/subagents/a.jsonl`)],
      },
      {
        characterId: 'c_bo', agent: 'codex', sessionId: CODEX, sourcePath: at(src, `.codex/sessions/rollout-${CODEX}.jsonl`),
        sourceHome: at(src, '.codex'), destinationHome: at(dst, '.codex'), destinationPath: at(dst, `.codex/sessions/rollout-${CODEX}.jsonl`), adapter: 1,
        files: [file(`sessions/rollout-${CODEX}.jsonl`)],
      },
    ],
  };
}

const info = (machineId: MachineId, over: Partial<SystemInfo> = {}): SystemInfo => ({
  machineId, release: 'dev', protocol: PROTOCOL_VERSION, stateSchema: 7, transferSchema: TRANSFER_SCHEMA_VERSION,
  platform: machineId === mac ? 'darwin' : 'linux', arch: 'arm64', git: '2.43.0',
  agentAdapters: [
    { kind: 'claude', version: '2.1.280', adapter: 1, home: machineId === mac ? '/Users/ada/.claude' : '/home/ada/.claude', loggedIn: true, hooks: true },
    { kind: 'codex', version: '0.156.1', adapter: 1, home: machineId === mac ? '/Users/ada/.codex' : '/home/ada/.codex', loggedIn: true, hooks: true },
  ],
  ...over,
});

class Died extends Error {}
type Fault = { at: number; kind: 'death' | 'lost' | 'dropped' | 'partition' };

/** A daemon's answers, keyed by method, as the real service gives them. */
type Answers = Record<string, (p: never) => unknown>;

class FakeSource {
  frozen = false;
  owner: { generation: number; machine: MachineId } = { generation: G, machine: mac };
  journal?: { tx: string; generation: number; phase: HandoverPhase; digest?: string };
  kept?: FrozenManifest;
  sealed?: LandedRoot[];
  revived = 0;
  freezes: HandoverChoices[] = [];
  /** a blocked agent that stays so until a freeze interrupts it */
  blockedAgent = false;
  /** a working agent: the freeze waits on it until asked again with Interrupt and carry */
  working?: { release(): void; waiting: Promise<void> };
  preflightBlockers: Blocker[] = [];

  constructor(private w: World, readonly id: MachineId) {
    this.owner = { generation: G, machine: id };
  }

  get running(): boolean { return this.owner.machine === this.id && !this.frozen; }

  answers: Answers = {
    'system.info': () => info(this.id, this.w.infos[this.id]),
    'ownership.get': () => ({ fleetId, generation: this.owner.generation, ownerMachineId: this.owner.machine, frozen: this.frozen }),
    'handover.status': () => this.status(),
    'handover.preflight': (p: { destination: { fleetHome: string } }) => {
      if (this.frozen) throw new Refused('frozen', 'this fleet is frozen for a handover');
      const manifest = manifestFor(undefined, this.id, this.other);
      this.w.preflightDestinationHome = p.destination.fleetHome;
      return { manifestSummary: { digest: manifestDigest(manifest), roots: 2, files: 5, bytes: 100, sessions: 2 }, blockers: this.preflightBlockers, warnings: [], manifest };
    },
    'handover.freeze': (p: { transactionId: string; generation: number; choices: HandoverChoices }) => this.freeze(p),
    'handover.abort': (p: { transactionId: string; generation: number }) => this.abort(p),
    'handover.complete': (p: { transactionId: string; generation: number; landed?: LandedRoot[] }) => this.complete(p),
  };

  get other(): MachineId { return this.id === mac ? trift : mac; }

  status() {
    const j = this.journal;
    return j ? { transaction: { id: j.tx, fromMachineId: this.id, toMachineId: this.other, phase: j.phase, startedAt: 1 }, characters: [], roots: [] } : { characters: [], roots: [] };
  }

  async freeze(p: { transactionId: string; generation: number; choices: HandoverChoices }) {
    this.freezes.push(p.choices);
    const j = this.journal;
    if (j?.tx === p.transactionId && j.digest) return { manifest: this.kept! };
    if (j && j.tx !== p.transactionId) throw new Refused('transaction_mismatch', `in handover ${j.tx}`);
    if (!j && this.owner.machine !== this.id) throw new Refused('not_owner', 'another machine owns it');
    const r = this.w.record;
    const tx = r.transaction;
    if (r.ownerMachineId !== this.id) throw new Refused('not_owner', 'the gateway names another owner');
    if (r.generation !== p.generation) throw new Refused('generation_mismatch', `at ${r.generation}`);
    if (!tx || tx.id !== p.transactionId || tx.phase !== 'preparing') throw new Refused('transaction_mismatch', 'no such preparing handover');
    this.journal = { tx: tx.id, generation: p.generation, phase: 'freeze' };
    this.frozen = true;
    if (this.working && p.choices.interruptAfterMs === undefined) {
      await this.working.waiting;
      throw new Refused('not_ready', 'asked to freeze again with other choices');
    }
    if (this.blockedAgent && p.choices.interruptAfterMs === undefined) {
      // a rest that does not come to rest gives every terminal back and lets the fleet run again
      this.journal = undefined;
      this.frozen = false;
      this.revived++;
      throw new Refused('blocked', 'bo is waiting on an answer', { blockers: [{ code: 'agent_blocked', message: 'bo is waiting on an answer', entity: { kind: 'character', id: 'c_bo' } }] });
    }
    this.kept = manifestFor(tx.id, this.id, this.other);
    this.journal.digest = manifestDigest(this.kept);
    return { manifest: this.kept };
  }

  abort(p: { transactionId: string; generation: number }) {
    if (!this.journal && !this.frozen) return {};
    const r = this.w.record;
    if (this.w.moved()) {
      this.w.violations.push('the source was asked to abort after the commit');
      throw new Refused('handover_committed', 'the fleet moved');
    }
    if (r.transaction?.id === p.transactionId) throw new Refused('not_ready', 'the gateway still holds it open');
    if (r.generation !== p.generation) throw new Refused('generation_mismatch', `at ${r.generation}`);
    this.journal = undefined;
    this.frozen = false;
    this.revived++;
    return {};
  }

  complete(p: { transactionId: string; generation: number; landed?: LandedRoot[] }) {
    const j = this.journal;
    if (!j) return {};
    if (j.generation !== p.generation) throw new Refused('generation_mismatch', `at ${j.generation}`);
    const r = this.w.record;
    if (!(r.ownerMachineId !== this.id && r.generation > j.generation) || (r.transaction?.id === j.tx && r.transaction.phase !== 'committed')) {
      throw new Refused('not_ready', 'not committed');
    }
    // without what the transfer verified, the source seals the roots of the manifest it froze
    this.sealed = p.landed ?? replicaRoots(this.kept!, 'source').map((x) => ({ id: x.id, files: this.kept!.roots.find((y) => y.id === x.id)!.files }));
    this.owner = { generation: r.generation, machine: r.ownerMachineId };
    this.journal = undefined;
    return {};
  }
}

class FakeDestination {
  claims = new Map<string, string>();
  journal?: { tx: string; generation: number; phase: HandoverPhase; preparedDigest?: string };
  activated = false;
  activations = 0;
  sealed = false;
  /** roots holding work no handover left, until a claim archives them */
  diverged = new Set<string>();
  archived: string[] = [];
  probe = { exists: true, writable: true, caseInsensitive: false, freeBytes: 1e12, collisions: [] as string[] };
  landedSeen?: LandedRoot[];
  /** the folders its Codex already trusts */
  trusted = new Set<string>();

  constructor(private w: World, readonly id: MachineId) {}

  get running(): boolean { return this.activated; }

  answers: Answers = {
    'system.info': () => info(this.id, this.w.infos[this.id]),
    'ownership.get': () => ({ fleetId, generation: this.w.record.generation, ownerMachineId: this.w.record.ownerMachineId, frozen: false }),
    'handover.status': () => {
      const j = this.journal;
      return j ? { transaction: { id: j.tx, fromMachineId: this.w.other(this.id), toMachineId: this.id, phase: j.phase, startedAt: 1 }, characters: [], roots: [] } : { characters: [], roots: [] };
    },
    'handover.inspect': (p: { roots: { id: string; path: string }[]; pathRoots: Record<string, string>; resumes?: { cwd: string }[] }) => ({
      roots: p.roots.map((r) => ({ id: r.id, check: this.diverged.has(r.id) ? { ok: false, path: r.path, blocker: this.divergedBlocker(r.id, r.path) } : { ok: true, path: r.path, kind: 'absent' } })),
      pathRoots: Object.fromEntries(Object.keys(p.pathRoots).map((k) => [k, this.probe])),
      untrusted: (p.resumes ?? []).map((f) => f.cwd).filter((cwd) => !this.trusted.has(cwd)),
    }),
    'handover.claim': (p: { transactionId: string; generation: number; manifest: FrozenManifest; manifestDigest: string; archive?: string[] }) => this.claim(p),
    'handover.prepare': (p: { transactionId: string; generation: number; manifest: FrozenManifest; manifestDigest: string; landed: LandedRoot[] }) => this.prepare(p),
    'handover.activate': (p: { transactionId: string; generation: number }) => this.activate(p),
    'handover.abort': (p: { transactionId: string; generation: number }) => this.abort(p),
    'handover.complete': (p: { transactionId: string; generation: number }) => this.complete(p),
  };

  divergedBlocker(id: string, at: string): Blocker {
    return { code: 'destination_diverged', message: `${at} changed while this machine did not own the fleet`, entity: { kind: 'root', id } };
  }

  identify(p: { generation: number; manifest: FrozenManifest; manifestDigest: string; transactionId: string }) {
    if (p.manifest.transactionId !== p.transactionId) throw new Refused('transaction_mismatch', 'another manifest');
    if (p.generation !== p.manifest.generation + 1) throw new Refused('generation_mismatch', 'not g + 1');
    if (manifestDigest(p.manifest) !== p.manifestDigest) throw new Refused('transaction_mismatch', 'the manifest hashes otherwise');
    if (p.manifest.toMachineId !== this.id) throw new Refused('blocked', 'handed to another machine', { blockers: [] });
    if (this.journal && this.journal.tx !== p.transactionId) throw new Refused('transaction_mismatch', `in handover ${this.journal.tx}`);
  }

  claim(p: { transactionId: string; generation: number; manifest: FrozenManifest; manifestDigest: string; archive?: string[] }) {
    this.identify(p);
    if (this.journal?.preparedDigest) throw new Refused('not_ready', 'prepared on this machine');
    const r = this.w.record;
    const tx = r.transaction;
    if (!tx || tx.id !== p.transactionId || tx.toMachineId !== this.id) throw new Refused('transaction_mismatch', 'not held open for this machine');
    if (r.generation !== p.generation - 1) throw new Refused('generation_mismatch', 'another generation');
    if (tx.phase !== 'preparing') throw new Refused('not_ready', `the gateway holds it ${tx.phase}`);
    return {
      roots: replicaRoots(p.manifest, 'destination').map((root) => {
        let archivedTo: string | undefined;
        if (this.diverged.has(root.id) && p.archive?.includes(root.id)) {
          this.diverged.delete(root.id);
          this.archived.push(root.id);
          archivedTo = `${root.path}.archived-1`;
        }
        // the destination proves and answers a root by its real path, which the manifest does not know
        const real = `/real${root.path}`;
        if (this.diverged.has(root.id)) return { id: root.id, excludes: [...p.manifest.excludes], check: { ok: false, path: real, blocker: this.divergedBlocker(root.id, real) } };
        const kind = this.claims.get(root.id) === p.transactionId ? 'resume' : 'absent';
        this.claims.set(root.id, p.transactionId);
        return { id: root.id, excludes: [...p.manifest.excludes], check: { ok: true, path: real, kind }, ...(archivedTo && { archivedTo }) };
      }),
    };
  }

  prepare(p: { transactionId: string; generation: number; manifest: FrozenManifest; manifestDigest: string; landed: LandedRoot[] }) {
    this.identify(p);
    if (this.journal?.preparedDigest) return { preparedDigest: this.journal.preparedDigest };
    const carried = replicaRoots(p.manifest, 'destination');
    const unverified = carried.find((r) => !p.landed.some((x) => x.id === r.id));
    if (unverified) throw new Refused('not_ready', `the transfer verified nothing in root ${unverified.id}`);
    if (carried.some((r) => this.claims.get(r.id) !== p.transactionId)) throw new Refused('blocked', 'not claimed', { blockers: [{ code: 'destination_occupied', message: 'not claimed' }] });
    this.landedSeen = p.landed;
    this.journal = { tx: p.transactionId, generation: p.generation, phase: 'prepare', preparedDigest: sha(JSON.stringify(p.landed)) };
    return { preparedDigest: this.journal.preparedDigest };
  }

  activate(p: { transactionId: string; generation: number }) {
    const r = this.w.record;
    const tx = r.transaction;
    if (!(r.ownerMachineId === this.id && r.generation === p.generation && (!tx || (tx.id === p.transactionId && tx.phase === 'committed')))) {
      this.w.violations.push('the destination was asked to activate before the commit');
      throw new Refused('not_ready', 'not committed');
    }
    const j = this.journal;
    if (!j || j.tx !== p.transactionId || !j.preparedDigest) throw new Refused('transaction_mismatch', 'not receiving it');
    if (tx && tx.preparedDigest !== j.preparedDigest) throw new Refused('transaction_mismatch', 'committed on other state');
    j.phase = 'activate';
    this.activated = true;
    this.activations++;
    return { characters: [{ id: 'c_ada', ok: true }, { id: 'c_bo', ok: false, error: 'bo resumed codex session, which did not report its SessionStart' }] };
  }

  abort(p: { transactionId: string; generation: number }) {
    // the service sends a machine with no journal of this handover and no ownership away
    if (!this.journal) throw new Refused('not_owner', 'this machine cannot abort a handover of a fleet another machine owns', { ownerMachineId: this.w.record.ownerMachineId, generation: this.w.record.generation });
    const r = this.w.record;
    if ((r.transaction?.id === p.transactionId && r.transaction.phase === 'committed') || (r.ownerMachineId === this.id && r.generation >= p.generation)) {
      throw new Refused('handover_committed', 'cannot be undone here');
    }
    if (r.transaction?.id === p.transactionId) throw new Refused('not_ready', 'the gateway still holds it open');
    this.journal = undefined;
    return {};
  }

  complete(p: { transactionId: string; generation: number }) {
    const j = this.journal;
    if (!j) return {};
    if (j.generation !== p.generation) throw new Refused('generation_mismatch', `at ${j.generation}`);
    if (j.phase !== 'activate') throw new Refused('not_ready', 'not activated');
    this.sealed = true;
    this.journal = undefined;
    return {};
  }
}

/** A controller store in memory, part of the world: a death leaves it exactly as it was. */
class MemoryStore implements ControllerStore {
  j?: ControllerJournal;
  files = new Map<string, unknown>();
  written: ControllerJournal[] = [];
  asides: boolean[] = [];
  constructor(private w: World) {}
  read(aside = false) { this.asides.push(aside); return this.j && structuredClone(this.j); }
  write(j: ControllerJournal) { this.w.effect('store', 'write', () => { this.j = structuredClone(j); this.written.push(structuredClone(j)); }); }
  saveManifest(tx: string, m: FrozenManifest) { this.w.effect('store', 'manifest', () => this.files.set(`${tx}/manifest`, structuredClone(m))); }
  manifest(tx: string, digest: string) {
    const m = this.files.get(`${tx}/manifest`) as FrozenManifest | undefined;
    return m && manifestDigest(m) === digest ? structuredClone(m) : undefined;
  }
  saveLanded(tx: string, landed: LandedRoot[]) { this.w.effect('store', 'landed', () => this.files.set(`${tx}/landed`, structuredClone(landed))); }
  landed(tx: string, digest: string) {
    const l = this.files.get(`${tx}/landed`) as LandedRoot[] | undefined;
    return l && canonicalDigest(l) === digest ? structuredClone(l) : undefined;
  }
  clear(tx?: string) {
    this.w.effect('store', 'clear', () => {
      this.j = undefined;
      if (tx) for (const k of [...this.files.keys()]) if (k.startsWith(`${tx}/`)) this.files.delete(k);
    });
  }
}

/**
 * Both machines, the gateway, the transfer and the controller's store, with one fault that can strike after any
 * call: the controller dies, an answer is lost, a request is lost, or a machine drops off the network.
 */
class World {
  record: OwnerRecord = { fleetId, generation: G, ownerMachineId: mac };
  mac: FakeSource | FakeDestination;
  trift: FakeSource | FakeDestination;
  store: MemoryStore;
  infos: Record<string, Partial<SystemInfo>> = {};
  ops: string[] = [];
  violations: string[] = [];
  events: HandoverEvent[] = [];
  transfers: TransferOptions[] = [];
  transferResult?: (o: TransferOptions) => TransferResult;
  transferWait?: Promise<void>;
  fault?: Fault;
  dead = false;
  down = new Set<string>();
  n = 0;
  now = 1000;
  txn = 0;
  preflightDestinationHome?: string;
  farRsync = 'rsync  version 3.2.7  protocol version 31\n';
  masters = {
    trift: {
      socket: '/tmp/archi-ssh/trift', check: async () => true,
      run: async (argv: string[]) => ({ code: 0, signal: null, stdout: argv[0] === 'rsync' ? this.farRsync : '', stderr: '', truncated: false }),
    } as Master,
  };
  /** why the controller's master to trift will not open, when it will not */
  masterFails?: Error;

  constructor(o: { pull?: boolean } = {}) {
    this.store = new MemoryStore(this);
    this.mac = o.pull ? new FakeDestination(this, mac) : new FakeSource(this, mac);
    this.trift = o.pull ? new FakeSource(this, trift) : new FakeDestination(this, trift);
    if (o.pull) this.record = { fleetId, generation: G, ownerMachineId: trift };
  }

  get source(): FakeSource { return (this.mac instanceof FakeSource ? this.mac : this.trift) as FakeSource; }
  get destination(): FakeDestination { return (this.mac instanceof FakeDestination ? this.mac : this.trift) as FakeDestination; }
  other(id: MachineId): MachineId { return id === mac ? trift : mac; }

  /** Whether the gateway has moved the fleet off generation g: committed, or cleared since. */
  moved(): boolean { return this.record.generation > G || this.record.transaction?.phase === 'committed'; }

  heal(): void { this.fault = undefined; this.dead = false; this.down.clear(); }

  private checkInvariants(): void {
    if (this.source.running && this.destination.running) this.violations.push('both machines ran the fleet at once');
  }

  /** One call into the world, with the fault that strikes it. */
  async call<T>(port: string, name: string, effect: () => T | Promise<T>): Promise<T> {
    if (this.dead) throw new Died('the controller is gone');
    if (this.down.has(port)) throw new Error(`${port} did not answer ${name}: connection refused`);
    const k = this.n++;
    this.ops.push(`${port}:${name}`);
    const f = this.fault?.at === k ? this.fault : undefined;
    if (f?.kind === 'dropped') throw new Error(`${port} did not answer ${name}: connection reset`);
    if (f?.kind === 'partition') { this.down.add(port); throw new Error(`${port} did not answer ${name}: connection refused`); }
    let result: T | undefined;
    let refusal: unknown;
    try { result = await effect(); } catch (e) { refusal = e; }
    this.checkInvariants();
    if (f?.kind === 'death') { this.dead = true; throw new Died('the controller died'); }
    if (f?.kind === 'lost') throw new Error(`${port} ${name}: the connection dropped before the answer`);
    if (refusal) throw refusal;
    return result as T;
  }

  /** A write to the controller's own store: only a death can strike it. */
  effect(port: string, name: string, write: () => void): void {
    if (this.dead) throw new Died('the controller is gone');
    const k = this.n++;
    this.ops.push(`${port}:${name}`);
    write();
    if (this.fault?.at === k && this.fault.kind === 'death') { this.dead = true; throw new Died('the controller died'); }
  }

  cas(op: OwnerOp, params: Record<string, unknown>): OwnerRecord {
    const t = transition(this.record, op, { fleetId, ...params } as never, this.now, () => `tx-${++this.txn}`);
    if ('error' in t) throw new Refused(t.error.code, t.error.message, t.error.data);
    this.record = t.record;
    return structuredClone(t.record);
  }

  gateway: Gateway = {
    get: () => this.call('gateway', 'get', () => structuredClone(this.record)),
    begin: (p) => this.call('gateway', 'begin', () => this.cas('owner.begin', p)),
    ready: (p) => this.call('gateway', 'ready', () => this.cas('owner.ready', { ...p, sourceFrozen: true })),
    commit: (p) => this.call('gateway', 'commit', () => this.cas('owner.commit', p)),
    abort: (p) => this.call('gateway', 'abort', () => this.cas('owner.abort', p)),
    complete: (p) => this.call('gateway', 'complete', () => this.cas('owner.complete', p)),
  };

  daemon(port: 'mac' | 'trift'): Daemon {
    return {
      call: ((method: string, params: never) => this.call(port, method, () => {
        const answer = this[port].answers[method];
        if (!answer) throw new Refused('unknown_method', method);
        return answer(structuredClone(params));
      })) as Daemon['call'],
    };
  }

  side(id: MachineId): Side {
    const name = id === mac ? 'mac' : 'trift';
    return {
      route: { machineId: id, name, ...(id === trift && { ssh: 'trift' }) },
      daemon: this.daemon(name),
      pathRoots: id === mac ? HOMES.mac : HOMES.trift,
      fleetHome: id === mac ? FLEET_HOMES.mac : FLEET_HOMES.trift,
      ...(id === trift && { master: async () => { if (this.masterFails) throw this.masterFails; return this.masters.trift; } }),
    };
  }

  transfer = (o: TransferOptions): Promise<TransferResult> => this.call('transfer', 'run', async () => {
    this.transfers.push(o);
    if (this.destination.journal?.preparedDigest) this.violations.push('a prepared root was copied into again');
    if (this.transferWait) await this.transferWait;
    if (o.signal?.aborted) return { status: 'cancelled', entries: o.entries.map((e) => ({ id: e.id, status: 'cancelled' as const })), blockers: [] };
    if (this.transferResult) return this.transferResult(o);
    for (const e of o.entries) {
      o.onProgress?.({ id: e.id, kind: e.kind, state: 'verified', pass: 1, done: 2, total: 2, bytes: 64, totalBytes: 64, items: 2, updatedAt: 0 });
    }
    return {
      status: 'verified', blockers: [],
      entries: o.entries.map((e) => ({ id: e.id, status: 'verified' as const, passes: 1, files: [...e.files] })),
    };
  });
}

function controller(w: World, o: Partial<HandoverDeps> = {}): Handover {
  return new Handover({
    fleetId, store: w.store, gateway: w.gateway, local: mac, machines: [mac, trift],
    side: async (id) => w.side(id), transfer: w.transfer, rsync: async () => '/opt/rsync', stateDir: '/tmp/archi-controller',
    clock: { now: () => w.now, sleep: async () => {} }, emit: (e) => w.events.push(e), retry: { attempts: 3, firstDelayMs: 1 },
    ...o,
  });
}

const landedOf = (w: World): LandedRoot[] => w.destination.landedSeen ?? [];

/** Where the fleet ended up: back on the source with nothing left open, or on the destination with everything completed. */
function settledOn(w: World): 'source' | 'destination' {
  expect(w.violations).toEqual([]);
  if (w.record.generation === G) {
    expect(w.record).toEqual({ fleetId, generation: G, ownerMachineId: w.source.id });
    expect(w.source.running).toBe(true);
    expect(w.source.journal).toBeUndefined();
    expect(w.destination.journal).toBeUndefined();
    expect(w.destination.activated).toBe(false);
    expect(w.store.j).toBeUndefined();
    return 'source';
  }
  expect(w.record).toEqual({ fleetId, generation: G + 1, ownerMachineId: w.destination.id });
  expect(w.destination.activated).toBe(true);
  expect(w.destination.sealed).toBe(true);
  expect(w.destination.journal).toBeUndefined();
  expect(w.source.journal).toBeUndefined();
  expect(w.source.running).toBe(false);
  expect(w.source.sealed).toEqual(landedOf(w));
  expect(w.store.j).toBeUndefined();
  return 'destination';
}

/** A new controller, as many times as it takes, doing the one thing the journals leave safe. */
async function recover(w: World, first: 'resume' | 'abort' = 'resume'): Promise<Outcome[]> {
  w.heal();
  const outcomes: Outcome[] = [];
  let how = first;
  for (let i = 0; i < 3; i++) {
    const c = controller(w);
    const out = how === 'abort' ? await c.abort() : await c.resume();
    outcomes.push(out);
    if (out.status !== 'interrupted' && !(out.status === 'complete' && out.pending?.length)) break;
    how = 'resume';
  }
  return outcomes;
}

const phases = (w: World): HandoverPhase[] => w.events.flatMap((e) => (e.event === 'handover.changed' ? [e.data.phase] : []));
const opIndex = (w: World, op: string): number => w.ops.indexOf(op);

describe('the controller transaction', () => {
  it('moves the fleet through every step in the spec\'s order, checking each answer, and leaves nothing open', async () => {
    const w = new World();
    const out = await controller(w).start(trift, {});

    expect(out).toEqual({
      status: 'complete', transactionId: 'tx-1', generation: G + 1,
      characters: [{ id: 'c_ada', ok: true }, { id: 'c_bo', ok: false, error: expect.stringContaining('SessionStart') }],
    });
    const order = ['gateway:begin', 'mac:handover.freeze', 'trift:handover.claim', 'transfer:run', 'trift:handover.prepare', 'gateway:ready', 'gateway:commit',
      'trift:handover.activate', 'trift:handover.complete', 'mac:handover.complete', 'gateway:complete'].map((op) => opIndex(w, op));
    expect(order.every((at) => at >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(phases(w)).toEqual(['begin', 'freeze', 'transfer', 'verify', 'prepare', 'ready', 'commit', 'activate', 'complete']);
    // rows for the sheet: each root and session file as it lands, each character as it comes up
    const entity = (id: string) => w.events.find((e) => e.event === 'handover.entity' && e.data.id === id);
    expect(entity('r_app')).toEqual({ event: 'handover.entity', data: { transactionId: 'tx-1', kind: 'root', id: 'r_app', phase: 'verify', done: 2, total: 2, bytes: 64, totalBytes: 64 } });
    expect(entity('s0')).toMatchObject({ data: { kind: 'session', phase: 'verify' } });
    expect(entity('c_bo')).toEqual({ event: 'handover.entity', data: { transactionId: 'tx-1', kind: 'character', id: 'c_bo', phase: 'activate', error: expect.stringContaining('SessionStart') } });
    expect(w.events[0]).toMatchObject({ event: 'handover.preflight', data: { blockers: [], summary: { roots: 2 } } });
    expect(settledOn(w)).toBe('destination');
    expect(w.events.at(-1)).toEqual({ event: 'handover.result', data: out });
  });

  it('carries what a character that came up still waits on in its terminal into its row and the result', async () => {
    const w = new World();
    const notice = 'codex waits at its "Trust this folder?" prompt in bo\'s terminal; answer it there';
    const activate = w.destination.answers['handover.activate'] as (p: unknown) => object;
    w.destination.answers['handover.activate'] = ((p: unknown) => {
      activate(p);
      return { characters: [{ id: 'c_ada', ok: true }, { id: 'c_bo', ok: true, notice }] };
    }) as never;
    const out = await controller(w).start(trift, {});

    expect(out).toMatchObject({ status: 'complete', characters: [{ id: 'c_ada', ok: true }, { id: 'c_bo', ok: true, notice }] });
    const row = w.events.find((e) => e.event === 'handover.entity' && e.data.id === 'c_bo');
    expect(row).toEqual({ event: 'handover.entity', data: { transactionId: 'tx-1', kind: 'character', id: 'c_bo', phase: 'activate', notice } });
  });

  it('writes each root only where its claim says, under the excludes and Git keep rules it was proven with, and each session into its stage as one entry', async () => {
    const w = new World();
    await controller(w).start(trift, {});
    const [run] = w.transfers;
    expect(run.roles).toEqual({ source: 'local', destination: 'remote' });
    expect(run.master).toBe(w.masters.trift);
    expect(run.transactionId).toBe('tx-1');
    const roots = run.entries.filter((e): e is RootEntry => e.kind === 'root');
    // a folded worktree travels inside the repository that holds it
    expect(roots.map((r) => [r.id, r.rootKind, r.claim.check.path, r.claim.excludes])).toEqual([
      ['r_app', 'repo', '/real/home/ada/app', ['node_modules/', 'logs/']],
      ['r_git', 'gitdir', '/real/home/ada/app.git', ['node_modules/', 'logs/']],
    ]);
    const stage = (i: number) => resolvePaths(FLEET_HOMES.trift).sessionStage('tx-1', i);
    expect(run.entries.filter((e) => e.kind === 'session').map((e) => [e.id, e.sourceHome, e.stage, e.files.map((f) => f.path)])).toEqual([
      ['s0', '/Users/ada/.claude', stage(0), [`projects/-app/${SID}.jsonl`, `projects/-app/${SID}/subagents/a.jsonl`]],
      ['s1', '/Users/ada/.codex', stage(1), [`sessions/rollout-${CODEX}.jsonl`]],
    ]);
    // prepare and the source's seal take what the transfer verified, not the frozen manifest's lists
    expect(w.destination.landedSeen).toEqual([{ id: 'r_app', files: roots[0].files }, { id: 'r_git', files: roots[1].files }]);
    expect(w.source.sealed).toEqual(w.destination.landedSeen);
  });

  it('keeps a journal of routes and progress, and never a token, not even in what a failure said', async () => {
    const w = new World();
    const prepare = w.destination.answers['handover.prepare'];
    let failures = 0;
    w.destination.answers['handover.prepare'] = ((p: never) => {
      if (failures++ < 1) throw new Error(`ws://127.0.0.1:52011 closed; the handshake sent ${TOKEN}`);
      return prepare(p);
    }) as never;
    await controller(w, { secrets: () => [TOKEN] }).start(trift, {});
    expect(w.transfers[0].secrets).toEqual([TOKEN]);
    expect(JSON.stringify(w.events)).toContain('[redacted]');

    // an interrupted run keeps what went wrong, scrubbed
    const down = new World();
    down.destination.answers['handover.prepare'] = (() => { throw new Error(`ws://127.0.0.1:52011 closed; the handshake sent ${TOKEN}`); }) as never;
    const out = await controller(down, { secrets: () => [TOKEN] }).start(trift, {});
    expect(out).toMatchObject({ status: 'interrupted', phase: 'prepare', error: expect.stringContaining('[redacted]') });
    expect(JSON.stringify([out, down.events, down.store.written])).not.toContain(TOKEN);

    const written = w.store.written;
    expect(written.length).toBeGreaterThan(5);
    expect(written.at(-1)).toMatchObject({
      transactionId: 'tx-1', generation: G, phase: 'complete', source: { machineId: mac, name: 'mac' }, destination: { machineId: trift, name: 'trift', ssh: 'trift' },
      entries: { r_app: 'verified', r_git: 'verified' },
    });
    expect(JSON.stringify(written)).not.toContain(TOKEN);
    expect(written.every((j) => Object.keys(j).every((k) => !/token|secret/i.test(k)))).toBe(true);
  });

  it('pulls a fleet from the far machine to this one over that machine\'s master', async () => {
    const w = new World({ pull: true });
    const out = await controller(w).start(mac, {});
    expect(out.status).toBe('complete');
    expect(w.transfers[0].roles).toEqual({ source: 'remote', destination: 'local' });
    expect(w.transfers[0].master).toBe(w.masters.trift);
    expect(settledOn(w)).toBe('destination');
  });

  it('refuses an answer that names another transaction, generation, machine or manifest, and goes no further', async () => {
    type Tamper = { name: string; set(w: World): void; stopsBefore: string };
    const tampers: Tamper[] = [
      {
        name: 'a Begin for other machines', stopsBefore: 'mac:handover.freeze',
        set: (w) => { const begin = w.gateway.begin; w.gateway.begin = async (p) => ({ ...(await begin(p)), transaction: { ...w.record.transaction!, toMachineId: mac } }); },
      },
      {
        name: 'a manifest for another generation', stopsBefore: 'trift:handover.claim',
        set: (w) => { const f = w.source.answers['handover.freeze']; w.source.answers['handover.freeze'] = (async (p: never) => { const r = await (f(p) as Promise<{ manifest: FrozenManifest }>); return { manifest: { ...r.manifest, generation: 3 } }; }) as never; },
      },
      {
        name: 'a manifest for another transaction', stopsBefore: 'trift:handover.claim',
        set: (w) => { const f = w.source.answers['handover.freeze']; w.source.answers['handover.freeze'] = (async (p: never) => { const r = await (f(p) as Promise<{ manifest: FrozenManifest }>); return { manifest: { ...r.manifest, transactionId: 'tx-9' } }; }) as never; },
      },
      {
        name: 'a claim that leaves a root out', stopsBefore: 'transfer:run',
        set: (w) => { const c = w.destination.answers['handover.claim']; w.destination.answers['handover.claim'] = ((p: never) => { const r = c(p) as { roots: unknown[] }; return { roots: r.roots.slice(1) }; }) as never; },
      },
      {
        name: 'a claim that names a root the manifest does not carry', stopsBefore: 'transfer:run',
        set: (w) => { const c = w.destination.answers['handover.claim']; w.destination.answers['handover.claim'] = ((p: never) => { const r = c(p) as { roots: { id: string }[] }; return { roots: [...r.roots, { ...r.roots[0], id: 'r_elsewhere' }] }; }) as never; },
      },
      {
        name: 'a transfer that verified a root no entry named', stopsBefore: 'trift:handover.prepare',
        set: (w) => { w.transferResult = (o) => ({ status: 'verified', blockers: [], entries: o.entries.map((e) => ({ id: `${e.id}-x`, status: 'verified' as const, passes: 1, files: [] })) }); },
      },
      {
        name: 'a Ready granted on another prepared state', stopsBefore: 'gateway:commit',
        set: (w) => { const ready = w.gateway.ready; w.gateway.ready = async (p) => ready({ ...p, preparedDigest: 'e'.repeat(64) }); },
      },
      {
        name: 'a Commit that hands the fleet to another machine', stopsBefore: 'trift:handover.activate',
        set: (w) => { const commit = w.gateway.commit; w.gateway.commit = async (p) => ({ ...(await commit(p)), ownerMachineId: mac }); w.gateway.get = async () => ({ ...structuredClone(w.record), ownerMachineId: mac }); },
      },
    ];
    for (const t of tampers) {
      const w = new World();
      t.set(w);
      const out = await controller(w).start(trift, {});
      expect(out.status, t.name).not.toBe('complete');
      expect(opIndex(w, t.stopsBefore), t.name).toBe(-1);
      expect(w.violations, t.name).toEqual([]);
      expect(w.destination.activated, t.name).toBe(false);
    }
  });
});

describe('a manifest over other path roots', () => {
  it('stops before any root is claimed when the source froze over path roots other than the ones it was sent', async () => {
    const w = new World();
    const freeze = w.source.answers['handover.freeze'];
    w.source.answers['handover.freeze'] = (async (p: never) => {
      const r = await (freeze as (x: never) => Promise<{ manifest: FrozenManifest }>)(p);
      const manifest = { ...r.manifest, destinationRoots: { home: '/' } };
      w.source.kept = manifest;
      w.source.journal!.digest = manifestDigest(manifest);
      return { manifest };
    }) as never;
    const out = await controller(w).start(trift, {});
    expect(out).toMatchObject({ status: 'interrupted', phase: 'freeze', error: expect.stringContaining('path roots') });
    expect(w.ops).not.toContain('trift:handover.claim');
  });
});

describe('preflight', () => {
  it('stops before Begin with the source\'s blockers, and touches nothing', async () => {
    const w = new World();
    w.source.preflightBlockers = [{ code: 'shell_busy', message: 'ada\'s terminal is running npm run dev', entity: { kind: 'character', id: 'c_ada' } }];
    const out = await controller(w).start(trift, {});
    expect(out).toEqual({ status: 'blocked', phase: 'begin', blockers: w.source.preflightBlockers });
    expect(w.ops.filter((op) => !/^(gateway:get|mac:|trift:)(system\.info|ownership\.get|handover\.(preflight|inspect|status)|get)?/.test(op))).toEqual([]);
    expect(w.store.j).toBeUndefined();
    expect(w.record).toEqual({ fleetId, generation: G, ownerMachineId: mac });
  });

  it('adds the destination\'s roots and room, the destination\'s git, and what differs between the machines', async () => {
    const w = new World();
    w.destination.diverged.add('r_git');
    w.destination.probe = { exists: true, writable: true, caseInsensitive: true, freeBytes: 10, collisions: [] };
    w.infos[trift] = { agentAdapters: [...info(trift).agentAdapters.map((a) => (a.kind === 'claude' ? { ...a, version: '2.1.290' } : a))] };
    const r = await controller(w).preflight(trift, {});
    const codes = (list: Blocker[]) => list.map((b) => [b.code, b.entity?.id]);
    expect(codes(r.blockers)).toEqual(expect.arrayContaining([
      ['destination_diverged', 'r_git'],
      ['destination_no_space', undefined],
      ['path_collision', 'r_app'],
    ]));
    expect(r.blockers.find((b) => b.code === 'path_collision')!.message).toMatch(/README\.md.*Readme\.md|Readme\.md.*README\.md/);
    expect(codes(r.warnings)).toEqual(expect.arrayContaining([['codex_trust', 'c_bo'], ['config_difference', undefined]]));
    expect(r.warnings.find((x) => x.code === 'config_difference')!.message).toMatch(/2\.1\.280.*2\.1\.290/);
    // the source is told where the destination keeps its fleet
    expect(w.preflightDestinationHome).toBe(FLEET_HOMES.trift);
    expect(w.store.j).toBeUndefined();
  });

  it('warns that Codex asks to trust a carried folder only where the destination does not trust it yet', async () => {
    const w = new World();
    // bo's Codex works in a worktree of app, which Codex trusts through app itself
    const preflight = w.source.answers['handover.preflight'] as (p: unknown) => { manifest: FrozenManifest };
    w.source.answers['handover.preflight'] = ((p: unknown) => {
      const r = preflight(p);
      r.manifest.snapshot.characters.c_bo.cwd = '/Users/ada/app/.claude/worktrees/x';
      r.manifest.snapshot.characters.c_bo.repo = { root: '/Users/ada/app/.claude/worktrees/x', mainRoot: '/Users/ada/app', branch: 'x', isWorktree: true };
      return r;
    }) as never;
    let asked: unknown;
    const inspect = w.destination.answers['handover.inspect'] as (p: unknown) => object;
    w.destination.answers['handover.inspect'] = ((p: { resumes?: unknown }) => { asked = p.resumes; return inspect(p); }) as never;
    const trust = async () => (await controller(w).preflight(trift, {})).warnings.filter((x) => x.code === 'codex_trust');

    expect(await trust()).toEqual([expect.objectContaining({ entity: { kind: 'character', id: 'c_bo' }, message: expect.stringContaining('bo resumes on trift') })]);
    expect(asked).toEqual([{ kind: 'codex', cwd: '/home/ada/app/.claude/worktrees/x', repo: '/home/ada/app' }]);
    w.destination.trusted.add('/home/ada/app/.claude/worktrees/x');
    expect(await trust()).toEqual([]);
  });

  it('blocks a destination that holds a handover journal of its own, before anything is rested', async () => {
    const w = new World();
    w.destination.answers['ownership.get'] = (() => ({
      fleetId, generation: G, ownerMachineId: mac, frozen: true, journal: { role: 'destination', transactionId: 'tx-9', generation: G + 1, phase: 'prepare' },
    })) as never;
    const out = await controller(w).start(trift, {});
    expect(out).toMatchObject({ status: 'blocked', phase: 'begin', blockers: [expect.objectContaining({ code: 'transaction_open', message: expect.stringContaining('tx-9') })] });
    expect(w.ops).not.toContain('gateway:begin');
  });

  it('warns of each carried link that will point at nothing on the destination, asking it of the targets no carried root holds', async () => {
    const w = new World();
    const preflight = w.source.answers['handover.preflight'];
    w.source.answers['handover.preflight'] = ((p: never) => {
      const r = (preflight as (x: never) => { manifest: FrozenManifest })(p);
      const app = r.manifest.roots.find((x) => x.id === 'r_app')!;
      app.files.push(
        { type: 'symlink', path: 'current', target: 'Readme.md' },
        { type: 'symlink', path: 'lib/gone', target: '../missing.txt' },
        { type: 'symlink', path: 'shared', target: '/Users/ada/shared/x' },
        { type: 'symlink', path: 'out', target: '../../elsewhere' },
      );
      return r;
    }) as never;
    let asked: string[] | undefined;
    const inspect = w.destination.answers['handover.inspect'];
    w.destination.answers['handover.inspect'] = ((p: { links?: string[] }) => ({ ...(inspect as (x: unknown) => object)(p), missing: (asked = p.links ?? []).filter((l) => l !== '/home/elsewhere') })) as never;
    const pre = await controller(w).preflight(trift, {});
    expect(asked).toEqual(['/Users/ada/shared/x', '/home/elsewhere']);
    expect(pre.blockers).toEqual([]);
    expect(pre.warnings).toContainEqual({
      code: 'symlink_dangling', entity: { kind: 'root', id: 'r_app' },
      message: expect.stringMatching(/^2 links in \/home\/ada\/app will point at nothing on trift: lib\/gone, shared/),
    });
  });

  it('blocks, before anything is rested, on an rsync either end cannot drive and an ssh that would have to ask for a password', async () => {
    const local = new World();
    const noRsync = await controller(local, { rsync: async () => { throw new Error('/opt/archi/bin/rsync could not run: ENOENT'); } }).start(trift, {});
    expect(noRsync).toMatchObject({ status: 'blocked', phase: 'begin', blockers: [expect.objectContaining({ code: 'rsync_unsupported', message: expect.stringContaining('ENOENT') })] });

    const far = new World();
    far.farRsync = 'rsync  version 3.1.3  protocol version 31\n';
    const old = await controller(far).start(trift, {});
    expect(old).toMatchObject({ status: 'blocked', blockers: [expect.objectContaining({ code: 'rsync_unsupported', message: expect.stringContaining('3.1.3') })] });

    const prompt = new World();
    prompt.masterFails = new SshError('auth', 'ssh could not reach trift: linus@trift: Permission denied (publickey,password).');
    const asks = await controller(prompt).start(trift, {});
    expect(asks).toMatchObject({ status: 'blocked', blockers: [expect.objectContaining({ code: 'ssh_interactive', message: expect.stringContaining('Permission denied') })] });

    // the far daemon itself is reached over that master: a login it would ask for is the same blocker, asked once
    const daemon = new World();
    daemon.destination.answers['system.info'] = (() => { throw new SshError('auth', 'ssh could not reach trift: Permission denied (publickey).'); }) as never;
    const once = await controller(daemon).start(trift, {});
    expect(once).toMatchObject({ status: 'blocked', blockers: [expect.objectContaining({ code: 'ssh_interactive' })] });
    expect(daemon.ops.filter((op) => op === 'trift:system.info')).toHaveLength(1);
    for (const w of [local, far, prompt, daemon]) expect(w.ops).not.toContain('gateway:begin');
  });

  it('blocks at once, naming host enable, on a destination whose companion runs another fleet, and asks it only once', async () => {
    const w = new World();
    const said = 'trift answered with fleetId 47a74455-7dbc-46c0-8076-30d830cf4f72, not ours: `archi host enable trift --fleet private` gives it a copy of this fleet';
    w.destination.answers['system.info'] = (() => { throw new FleetMismatch(said); }) as never;
    const out = await controller(w).start(trift, {});
    expect(out).toEqual({ status: 'blocked', phase: 'begin', blockers: [{ code: 'identity_mismatch', message: said }] });
    expect(w.ops.filter((op) => op === 'trift:system.info')).toHaveLength(1);
    expect(w.events.filter((e) => e.event === 'handover.retry')).toEqual([]);
    expect(w.ops).not.toContain('gateway:begin');
  });

  it('tells the destination what each root brings, so a root that already holds exactly that is no blocker', async () => {
    const w = new World();
    let asked: { id: string; content?: string }[] = [];
    const inspect = w.destination.answers['handover.inspect'];
    w.destination.answers['handover.inspect'] = ((p: { roots: { id: string; content?: string }[] }) => { asked = p.roots; return (inspect as (x: unknown) => object)(p); }) as never;
    const pre = await controller(w).preflight(trift, {});
    expect(asked.map((r) => [r.id, r.content])).toEqual(replicaRoots(pre.manifest, 'destination')
      .map((r) => [r.id, contentDigest(pre.manifest.roots.find((x) => x.id === r.id)!.files)]));
  });

  /** A world whose manifest carries one graph, and whose destination keeps a worktree at a commit it cannot prove comes back. */
  function keptCommit(o: { reached: boolean; at: 'inspect' | 'claim' }) {
    const w = new World();
    const commit = 'f'.repeat(40);
    const graph = {
      id: 'g_app', commonDir: '/Users/ada/app/.git', main: { path: '/Users/ada/app', gitDir: '/Users/ada/app/.git', head: 'c'.repeat(40), branch: 'refs/heads/main', status: [], index: 'd'.repeat(64), characters: [] },
      worktrees: [], unused: [], stash: [], tips: ['e'.repeat(40)],
    };
    // the manifest preflight builds and the one freeze answers both carry the graph
    for (const method of ['handover.preflight', 'handover.freeze'] as const) {
      const answer = w.source.answers[method] as (x: never) => Promise<{ manifest: FrozenManifest }> | { manifest: FrozenManifest };
      w.source.answers[method] = (async (p: never) => {
        const r = await answer(p);
        r.manifest.git = [graph];
        return r;
      }) as never;
    }
    const unproven = [{ graph: 'g_app', path: '/home/ada/stay', commit }];
    const asked: { git?: unknown; reaches: unknown[] } = { reaches: [] };
    const inspect = w.destination.answers['handover.inspect'];
    w.destination.answers['handover.inspect'] = ((p: { git?: unknown }) => {
      asked.git = p.git;
      return { ...(inspect as (x: unknown) => object)(p), ...(o.at === 'inspect' && { unproven }) };
    }) as never;
    const claim = w.destination.answers['handover.claim'];
    w.destination.answers['handover.claim'] = ((p: never) => ({ ...(claim as (x: never) => object)(p), ...(o.at === 'claim' && { unproven }) })) as never;
    w.source.answers['handover.reaches'] = ((p: { commits: { commonDir: string; commit: string }[] }) => {
      asked.reaches.push(p);
      return { unreached: o.reached ? [] : p.commits };
    }) as never;
    return { w, asked, commit };
  }

  it('asks the source about a kept commit the destination cannot prove comes back, and blocks only on one the source cannot reach', async () => {
    const lost = keptCommit({ reached: false, at: 'inspect' });
    const out = await controller(lost.w).start(trift, {});
    expect(lost.asked.git).toEqual([{ id: 'g_app', commonDir: '/home/ada/app/.git', carried: [], tips: ['e'.repeat(40), 'c'.repeat(40)] }]);
    // the source is asked by its own path to the repository
    expect(lost.asked.reaches).toEqual([{ commits: [{ commonDir: '/Users/ada/app/.git', commit: lost.commit }] }]);
    expect(out).toEqual({
      status: 'blocked', phase: 'begin',
      blockers: [{ code: 'worktree_unused', entity: { kind: 'git', id: 'g_app' }, message: expect.stringMatching(/^\/home\/ada\/stay is a worktree no character uses that stays on trift, at ffffffffffff, which nothing mac sends back reaches/) }],
    });
    expect(lost.w.ops).not.toContain('gateway:begin');

    const moved = keptCommit({ reached: true, at: 'inspect' });
    expect((await controller(moved.w).preflight(trift, {})).blockers).toEqual([]);
  });

  it('asks the source again about a kept commit the claim cannot prove comes back, before anything is copied', async () => {
    const lost = keptCommit({ reached: false, at: 'claim' });
    const decided: Blocker[][] = [];
    const out = await controller(lost.w, { decide: async (b) => { decided.push(b); return 'cancel'; } }).start(trift, {});
    expect(decided).toEqual([[expect.objectContaining({ code: 'worktree_unused', message: expect.stringContaining('/home/ada/stay') })]]);
    expect(out).toMatchObject({ status: 'blocked', phase: 'transfer' });
    expect(lost.w.transfers).toEqual([]);
    expect(settledOn(lost.w)).toBe('source');

    const moved = keptCommit({ reached: true, at: 'claim' });
    expect(await controller(moved.w).start(trift, {})).toMatchObject({ status: 'complete' });
  });

  it('asked while the claim waits on the source about a kept commit, stops waiting at once, whether in a backoff or in the call', async () => {
    for (const how of ['backoff', 'call'] as const) {
      const { w } = keptCommit({ reached: true, at: 'claim' });
      let sent = 0;
      w.source.answers['handover.reaches'] = (() => {
        sent++;
        if (how === 'backoff') throw new Error('mac: connection reset');
        return new Promise(() => undefined);
      }) as never;
      // a backoff that would last for ever unless the cancel ends it
      const c = controller(w, { clock: { now: () => w.now, sleep: () => new Promise<void>(() => undefined) } });
      const run = c.start(trift, {});
      while (!w.ops.includes('mac:handover.reaches') || (how === 'backoff' && !w.events.some((e) => e.event === 'handover.retry'))) await new Promise((r) => setImmediate(r));
      c.cancel();
      const out = await Promise.race([run, new Promise<'hung'>((r) => { setTimeout(() => r('hung'), 1000); })]);
      expect(out, how).toMatchObject({ status: 'aborted', transactionId: 'tx-1' });
      expect(sent, how).toBe(1);
      expect(w.transfers, how).toEqual([]);
    }
  });

  it('hands the transfer the folders each claim keeps as they are', async () => {
    const w = new World();
    const claim = w.destination.answers['handover.claim'];
    w.destination.answers['handover.claim'] = ((p: never) => {
      const r = (claim as (x: never) => { roots: { id: string }[] })(p);
      return { roots: r.roots.map((x) => (x.id === 'r_app' ? { ...x, keep: ['.git/worktrees/stay'] } : x)) };
    }) as never;
    expect((await controller(w).start(trift, {})).status).toBe('complete');
    const entries = w.transfers[0].entries as RootEntry[];
    expect(entries.find((e) => e.id === 'r_app')!.claim.keep).toEqual(['.git/worktrees/stay']);
    expect(entries.find((e) => e.id === 'r_git')!.claim.keep).toBeUndefined();
  });

  it('names each character and where each root lands, so what a blocker points at can be read', async () => {
    const w = new World();
    await controller(w).preflight(trift, {});
    const pre = w.events.find((e) => e.event === 'handover.preflight');
    expect(pre?.data).toMatchObject({
      names: {
        characters: { c_ada: 'ada', c_bo: 'bo' },
        roots: { r_app: '/home/ada/app', r_wt: '/home/ada/app/.claude/worktrees/x', r_git: '/home/ada/app.git' },
        // a session row is named by the character whose session it carries
        sessions: { s0: 'ada', s1: 'bo' },
      },
    });
  });

  it('takes a root the user chose to archive as a notice, counting all it brings against the room, and archives it at claim', async () => {
    const w = new World();
    w.destination.diverged.add('r_app');
    const plain = await controller(w).preflight(trift, {});
    // room for everything but the root that stays blocked
    w.destination.probe = { ...w.destination.probe, freeBytes: spaceNeed({ ...plain.manifest, roots: plain.manifest.roots.filter((r) => r.id !== 'r_app') }).home };
    expect((await controller(w).preflight(trift, {})).blockers.map((b) => b.code)).toEqual(['destination_diverged']);

    const pre = await controller(w).preflight(trift, { archiveRoots: ['r_app'] });
    expect(pre.blockers.map((b) => b.code)).toEqual(['destination_no_space']);
    expect(pre.warnings).toContainEqual({
      code: 'destination_diverged', entity: { kind: 'root', id: 'r_app' }, message: expect.stringMatching(/^\/home\/ada\/app is archived when the handover claims it: /),
    });

    w.destination.probe = { ...w.destination.probe, freeBytes: 1e12 };
    expect(await controller(w).start(trift, { archiveRoots: ['r_app'] })).toMatchObject({ status: 'complete' });
    expect(w.destination.archived).toEqual(['r_app']);
  });

  it('blocks a missing destination root, a fleet already in a handover, and a destination that is the owner', async () => {
    const missing = new World();
    missing.destination.probe = { ...missing.destination.probe, exists: false };
    expect((await controller(missing).preflight(trift, {})).blockers.map((b) => b.code)).toContain('path_root_missing');

    const open = new World();
    open.record.transaction = { id: 'tx-0', fromMachineId: mac, toMachineId: trift, phase: 'preparing', startedAt: 1 };
    expect((await controller(open).preflight(trift, {})).blockers.map((b) => b.code)).toContain('transaction_open');

    const self = new World();
    expect((await controller(self).preflight(mac, {})).blockers.map((b) => b.code)).toContain('identity_mismatch');
  });
});

describe('rest choices and blockers after Begin', () => {
  it('freezes again under the same handover with the user\'s new choices, instead of aborting', async () => {
    const w = new World();
    w.source.blockedAgent = true;
    const decided: Blocker[][] = [];
    const out = await controller(w, { decide: async (blockers) => { decided.push(blockers); return { interruptAfterMs: 0 }; } }).start(trift, {});
    expect(out.status).toBe('complete');
    expect(decided).toEqual([[expect.objectContaining({ code: 'agent_blocked' })]]);
    expect(w.source.freezes).toEqual([{}, { interruptAfterMs: 0 }]);
    expect(w.ops).not.toContain('gateway:abort');
    expect(w.events).toContainEqual({ event: 'handover.blocked', data: { transactionId: 'tx-1', phase: 'freeze', blockers: decided[0] } });
  });

  it('says where it stands again once a decision is answered, so a replayed stream never shows it still pending', async () => {
    const rest = new World();
    rest.source.blockedAgent = true;
    await controller(rest, { decide: async () => ({ interruptAfterMs: 0 }) }).start(trift, {});
    const asked = rest.events.findIndex((e) => e.event === 'handover.blocked');
    expect(rest.events[asked + 1]).toEqual({ event: 'handover.changed', data: { transactionId: 'tx-1', phase: 'freeze' } });

    const claim = new World();
    const claimed0 = claim.destination.answers['handover.claim'];
    claim.destination.answers['handover.claim'] = ((p: never) => { if (!claim.destination.archived.length) claim.destination.diverged.add('r_app'); return claimed0(p); }) as never;
    expect((await controller(claim, { decide: async () => ({ archiveRoots: ['r_app'] }) }).start(trift, {})).status).toBe('complete');
    const claimed = claim.events.findIndex((e) => e.event === 'handover.blocked');
    expect(claim.events[claimed + 1]).toEqual({ event: 'handover.changed', data: { transactionId: 'tx-1', phase: 'transfer' } });

    const prep = new World();
    const prepared0 = prep.destination.answers['handover.prepare'];
    let refused = 0;
    prep.destination.answers['handover.prepare'] = ((p: never) => {
      if (refused++ < 1) {
        throw new Refused('blocked', '/home/ada/app changed since it was copied', { blockers: [{ code: 'destination_diverged', message: '/home/ada/app changed since it was copied', entity: { kind: 'root', id: 'r_app' } }] });
      }
      return prepared0(p);
    }) as never;
    expect((await controller(prep, { decide: async () => ({}) }).start(trift, {})).status).toBe('complete');
    const asked2 = prep.events.findIndex((e) => e.event === 'handover.blocked');
    expect(prep.events[asked2]).toMatchObject({ data: { phase: 'prepare' } });
    expect(prep.events[asked2 + 1]).toEqual({ event: 'handover.changed', data: { transactionId: 'tx-1', phase: 'prepare' } });
  });

  it('takes Interrupt and carry chosen while the rest still waits, by asking the source to freeze again', async () => {
    const w = new World();
    let release!: () => void;
    w.source.working = { waiting: new Promise<void>((r) => { release = r; }), release: () => release() };
    const c = controller(w);
    const run = c.start(trift, {});
    while (!w.ops.includes('mac:handover.freeze')) await new Promise((r) => setImmediate(r));
    c.choose({ interruptAfterMs: 0 });
    const out = await run;
    w.source.working.release();
    expect(out.status).toBe('complete');
    expect(w.source.freezes).toEqual([{}, { interruptAfterMs: 0 }]);
    expect(w.ops.filter((op) => op === 'gateway:begin')).toHaveLength(1);
  });

  it('takes a decision\'s answer as the whole of the choices, so a choice the user turned off is dropped', async () => {
    const w = new World();
    w.source.blockedAgent = true;
    const out = await controller(w, { decide: async () => ({ interruptAfterMs: 0 }) }).start(trift, { terminateShells: true });
    expect(out.status).toBe('complete');
    expect(w.source.freezes).toEqual([{ terminateShells: true }, { interruptAfterMs: 0 }]);
  });

  it('lets a freeze asked with older choices go once new ones are chosen, so its retry never asks again with them', async () => {
    const w = new World();
    let wake!: () => void;
    const freeze = w.source.answers['handover.freeze'];
    let sent = 0;
    // the first Freeze's answer is lost, and its retry waits while the user chooses again
    w.source.answers['handover.freeze'] = ((p: never) => { if (sent++ === 0) throw new Error('trift: connection reset'); return freeze(p); }) as never;
    const c = controller(w, { clock: { now: () => w.now, sleep: () => new Promise<void>((r) => { wake = r; }) } });
    const run = c.start(trift, {});
    while (!w.events.some((e) => e.event === 'handover.retry' && e.data.phase === 'freeze')) await new Promise((r) => setImmediate(r));
    c.choose({ interruptAfterMs: 0 });
    expect((await run).status).toBe('complete');
    wake();
    for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
    expect(w.source.freezes).toEqual([{ interruptAfterMs: 0 }]);
    expect(sent).toBe(2);
  });

  it('aborts, gateway first, when the user cancels at a blocker, and the fleet is the source\'s again', async () => {
    const w = new World();
    w.destination.diverged.add('r_app');
    let asked = 0;
    const out = await controller(w, { decide: async () => { asked++; return 'cancel'; } }).start(trift, {});
    expect(asked).toBe(0);
    expect(out.status).toBe('blocked');
    // preflight found the diverged root before anything began
    expect(w.ops).not.toContain('gateway:begin');

    const later = new World();
    const c = controller(later, { decide: async () => 'cancel' });
    // the root diverges only after preflight
    const claim = later.destination.answers['handover.claim'];
    later.destination.answers['handover.claim'] = ((p: never) => { later.destination.diverged.add('r_app'); return claim(p); }) as never;
    const out2 = await c.start(trift, {});
    expect(out2).toMatchObject({ status: 'blocked', phase: 'transfer', blockers: [expect.objectContaining({ code: 'destination_diverged' })] });
    expect(opIndex(later, 'gateway:abort')).toBeLessThan(opIndex(later, 'mac:handover.abort'));
    expect(settledOn(later)).toBe('source');
  });

  it('archives a diverged root the user names, and carries on', async () => {
    const w = new World();
    const claim = w.destination.answers['handover.claim'];
    w.destination.answers['handover.claim'] = ((p: never) => { if (!w.destination.archived.length) w.destination.diverged.add('r_app'); return claim(p); }) as never;
    const out = await controller(w, { decide: async () => ({ archiveRoots: ['r_app'] }) }).start(trift, {});
    expect(out.status).toBe('complete');
    expect(w.destination.archived).toEqual(['r_app']);
  });

  it('stops without preparing when the transfer refuses an entry, and leaves the choice to resume or abort', async () => {
    const w = new World();
    w.transferResult = (o) => ({
      status: 'failed', blockers: [],
      entries: o.entries.map((e, i) => (i === 0 ? { id: e.id, status: 'failed' as const, reason: 'refused' as const, code: null, error: 'ENOSPC: no space left on device' } : { id: e.id, status: 'verified' as const, passes: 1, files: [] })),
    });
    const out = await controller(w).start(trift, {});
    expect(out).toMatchObject({ status: 'interrupted', phase: 'transfer', error: expect.stringContaining('ENOSPC'), safe: ['resume', 'abort'] });
    expect(w.ops).not.toContain('trift:handover.prepare');
    expect(w.ops).not.toContain('gateway:abort');
    w.transferResult = undefined;
    await recover(w, 'abort');
    expect(settledOn(w)).toBe('source');
  });
});

describe('resuming after the destination prepared', () => {
  it('never copies into a prepared root again, even when what the transfer verified is lost', async () => {
    const probe = new World();
    await controller(probe).start(trift, {});
    // the controller dies once the destination has prepared, before it has written down the proof
    const w = new World();
    w.fault = { at: opIndex(probe, 'trift:handover.prepare'), kind: 'death' };
    await controller(w).start(trift, {});
    expect(w.destination.journal?.preparedDigest).toBeDefined();
    expect(w.store.j).toMatchObject({ phase: 'prepare' });
    expect(w.store.j?.preparedDigest).toBeUndefined();
    w.store.files.delete('tx-1/landed');
    const transfers = w.transfers.length;
    const [out] = await recover(w);
    expect(out.status).toBe('complete');
    expect(w.transfers.length).toBe(transfers);
    expect(settledOn(w)).toBe('destination');
  });
});

describe('cancellation', () => {
  it('asked while Freeze is being readied, sends no Freeze, so nothing is rested', async () => {
    const w = new World();
    const c = controller(w);
    const info = w.destination.answers['system.info'];
    let asked = 0;
    // preflight asks once; the Freeze step asks again just before it sends Freeze
    w.destination.answers['system.info'] = ((p: never) => { if (++asked === 2) c.cancel(); return info(p); }) as never;
    const out = await c.start(trift, {});
    expect(out).toMatchObject({ status: 'aborted', transactionId: 'tx-1' });
    expect(w.ops).not.toContain('mac:handover.freeze');
    expect(w.source.freezes).toEqual([]);
    expect(w.source.revived).toBe(0);
    expect(settledOn(w)).toBe('source');
  });

  it('asked while a call waits to be tried again, does not send it again', async () => {
    const w = new World();
    const info = w.destination.answers['system.info'];
    let asked = 0;
    w.destination.answers['system.info'] = ((p: never) => { if (++asked === 2) throw new Error('trift: connection reset'); return info(p); }) as never;
    const c: Handover = controller(w, { clock: { now: () => w.now, sleep: async () => { c.cancel(); } } });
    const out = await c.start(trift, {});
    expect(out).toMatchObject({ status: 'aborted', transactionId: 'tx-1' });
    expect(asked).toBe(2);
    expect(w.ops).not.toContain('mac:handover.freeze');
    expect(settledOn(w)).toBe('source');
  });

  it('asked while a Begin whose answer was lost waits to be asked again, closes the handover the gateway opened', async () => {
    const w = new World();
    const c = controller(w);
    const begin = w.gateway.begin;
    let first = true;
    w.gateway.begin = async (p) => {
      const r = await begin(p);
      if (!first) return r;
      first = false;
      c.cancel();
      throw new Error('ssh: the connection to trift closed before the answer');
    };
    const out = await c.start(trift, {});
    expect(out).toMatchObject({ status: 'aborted', transactionId: 'tx-1', phase: 'begin' });
    expect(w.ops).not.toContain('mac:handover.freeze');
    expect(settledOn(w)).toBe('source');
  });

  it('asked while a Freeze waits out its backoff, stops waiting at once', async () => {
    const w = new World();
    const freeze = w.source.answers['handover.freeze'];
    let sent = 0;
    w.source.answers['handover.freeze'] = ((p: never) => { if (sent++ === 0) throw new Error('mac: connection reset'); return freeze(p); }) as never;
    // a backoff that would last for ever unless the cancel ends it
    const c = controller(w, { clock: { now: () => w.now, sleep: () => new Promise<void>(() => undefined) } });
    const run = c.start(trift, {});
    while (!w.events.some((e) => e.event === 'handover.retry')) await new Promise((r) => setImmediate(r));
    c.cancel();
    const out = await Promise.race([run, new Promise<'hung'>((r) => { setTimeout(() => r('hung'), 1000); })]);
    expect(out).toMatchObject({ status: 'aborted', transactionId: 'tx-1' });
    expect(sent).toBe(1);
    expect(settledOn(w)).toBe('source');
  });

  it('asked once Ready is recorded, sends no Commit and aborts, gateway first', async () => {
    const w = new World();
    const c = controller(w);
    const ready = w.gateway.ready;
    w.gateway.ready = async (p) => { const r = await ready(p); c.cancel(); return r; };
    const out = await c.start(trift, {});
    expect(out).toMatchObject({ status: 'aborted', transactionId: 'tx-1' });
    expect(w.ops).not.toContain('gateway:commit');
    expect(opIndex(w, 'gateway:abort')).toBeLessThan(opIndex(w, 'mac:handover.abort'));
    expect(settledOn(w)).toBe('source');
  });

  it('asked while a Commit\'s fate is unknown, never sends it again, and stops with the abort on offer while the gateway still holds it ready', async () => {
    const w = new World();
    const c = controller(w);
    // the Commit never reaches the gateway, and its answer never comes back
    w.gateway.commit = async () => { w.ops.push('gateway:commit'); c.cancel(); throw new Error('ssh: the connection to trift closed'); };
    const out = await c.start(trift, {});
    expect(out).toMatchObject({ status: 'interrupted', phase: 'commit', safe: expect.arrayContaining(['abort']) });
    expect(w.ops.filter((op) => op === 'gateway:commit')).toHaveLength(1);
    expect(w.ops.slice(opIndex(w, 'gateway:commit'))).toContain('gateway:get');
    expect(w.record.transaction?.phase).toBe('ready-to-commit');
    expect(w.ops).not.toContain('mac:handover.abort');
    expect(w.destination.activated).toBe(false);
    await recover(w, 'abort');
    expect(settledOn(w)).toBe('source');
  });

  it('asked while a Commit\'s fate is unknown, goes on to activation when the gateway says it committed', async () => {
    const w = new World();
    const c = controller(w);
    const commit = w.gateway.commit;
    w.gateway.commit = async (p) => { await commit(p); c.cancel(); throw new Error('ssh: the connection to trift closed'); };
    const out = await c.start(trift, {});
    expect(out).toEqual({ status: 'detached', transactionId: 'tx-1' });
    expect(await c.finished).toMatchObject({ status: 'complete' });
    expect(w.ops.filter((op) => op === 'gateway:commit')).toHaveLength(1);
    expect(w.ops).not.toContain('gateway:abort');
    expect(settledOn(w)).toBe('destination');
  });

  it('before Freeze, clears the Begin and leaves the source untouched', async () => {
    const w = new World();
    const c = controller(w);
    const begin = w.gateway.begin;
    w.gateway.begin = async (p) => { const r = await begin(p); c.cancel(); return r; };
    const out = await c.start(trift, {});
    expect(out).toMatchObject({ status: 'aborted', phase: 'begin' });
    expect(w.ops).not.toContain('mac:handover.freeze');
    expect(w.source.frozen).toBe(false);
    expect(settledOn(w)).toBe('source');
  });

  it('after Freeze, aborts at the gateway first and then gives the source its fleet back', async () => {
    const w = new World();
    let release!: () => void;
    w.transferWait = new Promise((r) => { release = r; });
    const c = controller(w);
    const run = c.start(trift, {});
    while (!w.ops.includes('transfer:run')) await new Promise((r) => setImmediate(r));
    c.cancel();
    release();
    const out = await run;
    expect(out).toMatchObject({ status: 'aborted', transactionId: 'tx-1' });
    expect(opIndex(w, 'gateway:abort')).toBeLessThan(opIndex(w, 'mac:handover.abort'));
    expect(w.source.revived).toBe(1);
    expect(settledOn(w)).toBe('source');
  });

  it('after Commit, only stops telling the observer, and the move goes on to completion', async () => {
    const w = new World();
    const c = controller(w);
    const commit = w.gateway.commit;
    w.gateway.commit = async (p) => { const r = await commit(p); c.cancel(); return r; };
    const out = await c.start(trift, {});
    expect(out).toEqual({ status: 'detached', transactionId: 'tx-1' });
    const seen = w.events.length;
    expect(await c.finished).toMatchObject({ status: 'complete' });
    expect(w.events.length).toBe(seen);
    expect(w.ops).not.toContain('gateway:abort');
    expect(settledOn(w)).toBe('destination');
  });

  it('hands the gateway\'s record of the moved fleet to whatever routes to it next', async () => {
    const w = new World();
    const moved: OwnerRecord[] = [];
    expect((await controller(w, { moved: (r) => moved.push(r) }).start(trift, {})).status).toBe('complete');
    expect(moved).toEqual([{ fleetId, generation: G + 1, ownerMachineId: trift }]);
  });

  it('after Commit, still hands every event to the record it keeps, the rest of the move and its result included', async () => {
    const w = new World();
    const recorded: HandoverEvent[] = [];
    const c = controller(w, { record: (e) => recorded.push(e) });
    const commit = w.gateway.commit;
    w.gateway.commit = async (p) => { const r = await commit(p); c.cancel(); return r; };
    expect(await c.start(trift, {})).toEqual({ status: 'detached', transactionId: 'tx-1' });
    const seen = w.events.length;
    await c.finished;
    expect(w.events.length).toBe(seen);
    expect(recorded.slice(0, seen)).toEqual(w.events);
    expect(recorded).toContainEqual({ event: 'handover.changed', data: { transactionId: 'tx-1', phase: 'activate' } });
    expect(recorded.at(-1)).toEqual({ event: 'handover.result', data: expect.objectContaining({ status: 'complete' }) });
  });

  it('relays what a daemon reports of its own rest and activation to the watcher and the record alike', async () => {
    const w = new World();
    const recorded: HandoverEvent[] = [];
    const c = controller(w, { record: (e) => recorded.push(e) });
    const row: HandoverEvent = { event: 'handover.entity', data: { transactionId: 'tx-1', kind: 'character', id: 'c_ada', phase: 'freeze' } };
    c.relay(row);
    expect(w.events).toEqual([row]);
    expect(recorded).toEqual([row]);
  });

  it('while activation runs, lets the watcher go at once and leaves activation to finish', async () => {
    const w = new World();
    let release!: () => void;
    const starting = new Promise<void>((r) => { release = r; });
    const activate = w.destination.answers['handover.activate'];
    w.destination.answers['handover.activate'] = (async (p: never) => { await starting; return activate(p); }) as never;
    const c = controller(w);
    const run = c.start(trift, {});
    while (!w.ops.includes('trift:handover.activate')) await new Promise((r) => setImmediate(r));
    c.cancel();
    expect(await run).toEqual({ status: 'detached', transactionId: 'tx-1' });
    release();
    expect(await c.finished).toMatchObject({ status: 'complete' });
    expect(w.ops).not.toContain('gateway:abort');
    expect(settledOn(w)).toBe('destination');
  });
});

describe('an unknown commit', () => {
  it('asks the gateway, and goes forward when it committed', async () => {
    const w = new World();
    const commit = w.gateway.commit;
    w.gateway.commit = async (p) => { await commit(p); throw new Error('ssh: the connection to trift closed'); };
    const out = await controller(w).start(trift, {});
    expect(out.status).toBe('complete');
    expect(w.ops.filter((op) => op === 'gateway:commit')).toHaveLength(1);
    expect(settledOn(w)).toBe('destination');
  });

  it('never aborts the source while the gateway cannot say, and a later resume finds the commit', async () => {
    const w = new World();
    const commit = w.gateway.commit;
    w.gateway.commit = async (p) => { await commit(p); w.down.add('gateway'); throw new Error('ssh: the connection to trift closed'); };
    const out = await controller(w).start(trift, {});
    expect(out).toMatchObject({ status: 'interrupted', phase: 'commit', safe: [] });
    expect(w.ops).not.toContain('mac:handover.abort');
    expect(w.source.frozen).toBe(true);
    w.gateway.commit = commit;
    await recover(w);
    expect(settledOn(w)).toBe('destination');
  });

  it('refuses an abort asked once the gateway has committed, and only goes forward', async () => {
    const w = new World();
    const activate = w.destination.answers['handover.activate'];
    w.destination.answers['handover.activate'] = (() => { throw new Error('trift went to sleep'); }) as never;
    const out = await controller(w).start(trift, {});
    expect(out).toMatchObject({ status: 'interrupted', phase: 'activate', safe: ['resume'] });
    const abort = await controller(w).abort();
    expect(abort).toMatchObject({ status: 'interrupted', safe: ['resume'] });
    expect(w.ops).not.toContain('gateway:abort');
    w.destination.answers['handover.activate'] = activate;
    await recover(w);
    expect(settledOn(w)).toBe('destination');
  });
});

describe('Complete', () => {
  it('seals and closes the destination first, finishes the source when it can, and a resume finishes it later', async () => {
    const w = new World();
    const complete = w.source.answers['handover.complete'];
    w.source.answers['handover.complete'] = (() => { throw new Error('the Mac\'s daemon is restarting'); }) as never;
    const out = await controller(w).start(trift, {});
    // why the source is still to finish is said, not dropped
    expect(out).toMatchObject({ status: 'complete', pending: ['source'], error: expect.stringContaining('restarting') });
    expect(w.destination.sealed).toBe(true);
    expect(w.record).toEqual({ fleetId, generation: G + 1, ownerMachineId: trift });
    // the source stays fenced by its own journal meanwhile
    expect(w.source.running).toBe(false);
    expect(w.store.j).toMatchObject({ phase: 'complete', pending: ['source'] });
    w.source.answers['handover.complete'] = complete;
    const [again] = await recover(w);
    expect(again).toMatchObject({ status: 'complete' });
    expect(settledOn(w)).toBe('destination');
  });
});

describe('resuming a handover the destination may have finished', () => {
  const committedWorld = (): World => {
    const w = new World();
    w.record = { fleetId, generation: G + 1, ownerMachineId: trift, transaction: { id: 'tx-1', fromMachineId: mac, toMachineId: trift, phase: 'committed', startedAt: 1 } };
    w.source.journal = { tx: 'tx-1', generation: G, phase: 'freeze', digest: 'x' };
    w.source.frozen = true;
    w.source.kept = manifestFor('tx-1');
    w.store.j = {
      version: 1, fleetId, transactionId: 'tx-1', generation: G, choices: {}, phase: 'commit', startedAt: 1, updatedAt: 1,
      source: { machineId: mac, name: 'mac' }, destination: { machineId: trift, name: 'trift', ssh: 'trift' },
    };
    return w;
  };

  it('never completes over a destination journal that could not be read, and offers nothing until it is looked at', async () => {
    const w = committedWorld();
    w.destination.answers['handover.status'] = (() => ({ characters: [], roots: [], quarantined: '/home/ada/.archipelago/handover/journal.json.broken-1' })) as never;
    const out = await controller(w).resume();
    expect(out).toMatchObject({ status: 'interrupted', safe: [], error: expect.stringContaining('journal.json.broken-1') });
    expect(w.ops).not.toContain('gateway:complete');
    expect(w.ops).not.toContain('mac:handover.complete');
    expect(w.record.transaction?.phase).toBe('committed');
  });

  it('counts the destination done only when it owns the fleet at the generation the handover moved it to', async () => {
    const w = committedWorld();
    // the destination holds no journal, and never took the fleet
    w.destination.answers['ownership.get'] = (() => ({ fleetId, generation: G, ownerMachineId: mac, frozen: false })) as never;
    const out = await controller(w).resume();
    expect(out.status).toBe('interrupted');
    expect(w.ops).toContain('trift:handover.activate');
    expect(w.ops).not.toContain('gateway:complete');
    expect(w.record.transaction?.phase).toBe('committed');
  });

  it('finishes a handover the gateway has moved on past without leaving the gateway pending', async () => {
    const w = committedWorld();
    w.destination.journal = { tx: 'tx-1', generation: G + 1, phase: 'activate', preparedDigest: 'p' };
    w.destination.activated = true;
    // a later handover took the fleet on to G + 2 on the destination
    w.record = { fleetId, generation: G + 2, ownerMachineId: trift };
    const out = await controller(w).resume();
    expect(out).toEqual({ status: 'complete', transactionId: 'tx-1', generation: G + 1, characters: [] });
    expect(w.store.j).toBeUndefined();
  });

  it('never reports an aborted handover complete once the fleet moved on without it', async () => {
    const w = committedWorld();
    w.store.j = { ...w.store.j!, phase: 'aborted' };
    w.source.journal = undefined;
    w.source.frozen = false;
    w.record = { fleetId, generation: G + 1, ownerMachineId: trift };
    const c = controller(w);
    expect((await c.status()).verdict).toMatchObject({ standing: 'superseded', safe: [] });
    const out = await c.resume();
    expect(out).toMatchObject({ status: 'interrupted', safe: [] });
    expect(w.ops).not.toContain('trift:handover.complete');
  });
});

describe('reading the controller journal', () => {
  it('only a run that writes the journal sets aside one it cannot read; status never does', async () => {
    const w = new World();
    await controller(w).status();
    expect(w.store.asides).toEqual([false]);
    await controller(w).resume();
    await controller(w).abort();
    await controller(w).start(trift, {});
    expect(w.store.asides.slice(1, 4)).toEqual([true, true, true]);
  });
});

describe('a controller that dies or loses its network after any await', () => {
  // the happy run, to learn how many calls there are and which one commits
  const probe = new World();
  const probeRun = controller(probe).start(trift, {});
  const kinds: Fault['kind'][] = ['death', 'lost', 'dropped', 'partition'];

  it('ends with the fleet on exactly one machine, and after the commit on the destination, whatever strikes where', async () => {
    await probeRun;
    const total = probe.n;
    const committedAt = opIndex(probe, 'gateway:commit');
    expect(total).toBeGreaterThan(25);
    const results: string[] = [];
    for (let at = 0; at < total; at++) {
      for (const kind of kinds) {
        if (probe.ops[at].startsWith('store:') && kind !== 'death') continue;
        const w = new World();
        w.fault = { at, kind };
        const what = `${kind} after ${probe.ops[at]} (${at})`;
        const first = await controller(w).start(trift, {}).catch((e: unknown) => ({ status: 'threw', error: String(e) }));
        expect((first as { status: string }).status, what).not.toBe('threw');
        const committed = w.moved();
        const outcomes = await recover(w);
        let where: string;
        try { where = settledOn(w); } catch (e) { throw new Error(`${what}: ${(e as Error).message}\n${JSON.stringify(first)}\n${JSON.stringify(outcomes)}\n${w.ops.join(' ')}`); }
        // a commit that took effect is final, whatever the controller saw of it
        if (committed) expect(where, what).toBe('destination');
        if (at > committedAt) expect(committed, what).toBe(true);
        expect(outcomes.at(-1)!.status, what).not.toBe('interrupted');
        results.push(`${at}:${kind}:${where}`);
      }
    }
    expect(results.length).toBeGreaterThan(60);
  });

  it('takes the fleet back with an abort from any point before the commit, and refuses one after it', async () => {
    await probeRun;
    const committedAt = opIndex(probe, 'gateway:commit');
    for (let at = 0; at < probe.n; at++) {
      for (const kind of kinds) {
        if (probe.ops[at].startsWith('store:') && kind !== 'death') continue;
        const w = new World();
        const what = `${kind} after ${probe.ops[at]} (${at})`;
        w.fault = { at, kind };
        await controller(w).start(trift, {});
        const committed = w.moved();
        const left = w.store.j !== undefined;
        const outcomes = await recover(w, 'abort');
        let where: string;
        try { where = settledOn(w); } catch (e) { throw new Error(`${what}: ${(e as Error).message}\n${JSON.stringify(outcomes)}\n${w.ops.join(' ')}`); }
        expect(where, what).toBe(committed ? 'destination' : 'source');
        if (at > committedAt) expect(committed, what).toBe(true);
        // an abort asked of a fleet that moved, with anything of it still open, is refused, and only a resume goes on
        if (committed && left) expect(outcomes[0], what).toMatchObject({ status: 'interrupted', safe: ['resume'] });
      }
    }
  });
});

describe('the real adapters', () => {
  it('finishes a committed handover and caches the route to its new owner, which owner resolution then reads', async () => {
    const ssh = installFakeSsh();
    const prefix = makeHome();
    const home = makeHome();
    const saved = process.env.ARCHI_GATEWAY_PREFIX;
    process.env.ARCHI_GATEWAY_PREFIX = prefix;
    const authority = await startAuthorityServer({ prefix });
    const daemons: WebSocketServer[] = [];
    // a daemon that answers what finishing a handover asks of it
    const daemon = async (answers: Record<string, unknown>): Promise<number> => {
      const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
      daemons.push(wss);
      await new Promise((r) => wss.once('listening', r));
      wss.on('connection', (ws) => {
        let authed = false;
        ws.on('message', (raw) => {
          if (!authed) { authed = true; ws.send(JSON.stringify({ id: 0, result: { ok: true, protocol: PROTOCOL_VERSION } })); return; }
          const req = JSON.parse(raw.toString()) as { id: number; method: string };
          ws.send(JSON.stringify({ id: req.id, result: answers[req.method] ?? {} }));
        });
      });
      return (wss.address() as { port: number }).port;
    };
    try {
      const registry = MachineRegistry.load(makeHome());
      registry.add({
        name: 'trift', ssh: 'trift.test', platform: 'linux', arch: 'arm64',
        home: '/home/ada', archiBase: '/home/ada/.local/share/archipelago', pathRoots: { home: '/home/ada' }, gateway: false,
      }, trift);
      const fleet = FleetId.parse(crypto.randomUUID());
      const local = registry.localId;
      // the gateway, here, holds the handover to trift committed at generation 1
      const client = await AuthorityClient.connect(prefix);
      await client.create({ fleetId: fleet, initialOwnerMachineId: local });
      const begun = await client.begin({ fleetId: fleet, expectedGeneration: 0, fromMachineId: local, toMachineId: trift });
      const tx = begun.transaction!.id;
      await client.ready({ fleetId: fleet, transactionId: tx, expectedGeneration: 0, preparedDigest: 'd'.repeat(64), sourceFrozen: true });
      await client.commit({ fleetId: fleet, transactionId: tx, expectedGeneration: 0 });
      client.close();

      fs.writeFileSync(path.join(home, 'fleet.json'), JSON.stringify({ id: fleet, gatewayMachineId: local }));
      fs.writeFileSync(path.join(home, 'node.json'), JSON.stringify({}));
      fs.writeFileSync(path.join(home, 'port'), String(await daemon({
        'handover.status': { characters: [], roots: [] }, 'ownership.get': { fleetId: fleet, generation: 0, ownerMachineId: local, frozen: true },
      })));
      fs.writeFileSync(path.join(home, 'token'), `${TOKEN}\n`);
      ssh.answer({
        fleetId: fleet, machineId: trift, release: 'dev', protocol: PROTOCOL_VERSION, host: '127.0.0.1', token: 'trift-token', generation: 1,
        port: await daemon({ 'handover.status': { characters: [], roots: [] }, 'ownership.get': { fleetId: fleet, generation: 1, ownerMachineId: trift, frozen: false } }),
      });
      fileStore(path.join(home, 'controller')).write({
        version: 1, fleetId: fleet, transactionId: tx, generation: 0, choices: {}, phase: 'activate', startedAt: 1, updatedAt: 1,
        source: { machineId: local, name: registry.localMachine().name }, destination: { machineId: trift, name: 'trift', ssh: 'trift.test' },
      });

      const c = connectHandover({ fleetHome: home, registry });
      try {
        expect(await c.handover.resume()).toMatchObject({ status: 'complete', transactionId: tx, generation: 1 });
      } finally {
        await c.close();
      }
      expect(readRoute(home)).toMatchObject({ ownerMachineId: trift, generation: 1 });
      // this gateway has no ssh route from here, so the cached route is what leads to the fleet
      const owner = await resolveOwner(home, { deps: { registry, openMaster: (d) => SshMaster.open({ destination: d, socketDir: ssh.socketDir }), now: () => new Date() } });
      expect(owner).toMatchObject({ id: trift });
    } finally {
      process.env.ARCHI_GATEWAY_PREFIX = saved;
      if (saved === undefined) delete process.env.ARCHI_GATEWAY_PREFIX;
      for (const wss of daemons) await new Promise((r) => wss.close(r));
      await authority.close();
      ssh.clean();
      cleanHomes();
    }
  });

  it('hands the source the far fleet home its companion reports, not one worked out from its home', async () => {
    const ssh = installFakeSsh();
    const prefix = makeHome();
    const home = makeHome();
    const saved = process.env.ARCHI_GATEWAY_PREFIX;
    process.env.ARCHI_GATEWAY_PREFIX = prefix;
    const authority = await startAuthorityServer({ prefix });
    const daemons: WebSocketServer[] = [];
    const asked: Record<string, unknown>[] = [];
    const daemon = async (answers: Record<string, (p: Record<string, unknown>) => unknown>): Promise<number> => {
      const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
      daemons.push(wss);
      await new Promise((r) => wss.once('listening', r));
      wss.on('connection', (ws) => {
        let authed = false;
        ws.on('message', (raw) => {
          if (!authed) { authed = true; ws.send(JSON.stringify({ id: 0, result: { ok: true, protocol: PROTOCOL_VERSION } })); return; }
          const req = JSON.parse(raw.toString()) as { id: number; method: string; params: Record<string, unknown> };
          ws.send(JSON.stringify({ id: req.id, result: answers[req.method]?.(req.params) ?? {} }));
        });
      });
      return (wss.address() as { port: number }).port;
    };
    try {
      const registry = MachineRegistry.load(makeHome());
      registry.add({
        name: 'trift', ssh: 'trift.test', platform: 'linux', arch: 'arm64',
        home: '/home/ada', archiBase: '/home/ada/.local/share/archipelago', pathRoots: { home: '/home/ada' }, gateway: false,
      }, trift);
      const local = registry.localId;
      const client = await AuthorityClient.connect(prefix);
      await client.create({ fleetId, initialOwnerMachineId: local });
      client.close();
      fs.writeFileSync(path.join(home, 'fleet.json'), JSON.stringify({ id: fleetId, gatewayMachineId: local }));
      fs.writeFileSync(path.join(home, 'node.json'), JSON.stringify({}));
      fs.writeFileSync(path.join(home, 'token'), `${TOKEN}\n`);
      fs.writeFileSync(path.join(home, 'port'), String(await daemon({
        'system.info': () => info(local),
        'ownership.get': () => ({ fleetId, generation: 0, ownerMachineId: local, frozen: false }),
        'handover.preflight': (p) => {
          asked.push(p);
          const manifest = manifestFor(undefined, local, trift);
          return { manifestSummary: { digest: manifestDigest(manifest), roots: 2, files: 5, bytes: 100, sessions: 2 }, blockers: [], warnings: [], manifest };
        },
      })));
      ssh.answer({
        fleetId, machineId: trift, release: 'dev', protocol: PROTOCOL_VERSION, host: '127.0.0.1', token: 'trift-token', generation: 0, fleetHome: '/srv/fleets/ada',
        port: await daemon({
          'system.info': () => info(trift),
          'ownership.get': () => ({ fleetId, generation: 0, ownerMachineId: local, frozen: false }),
          'handover.inspect': (p) => ({ roots: (p.roots as { id: string; path: string }[]).map((r) => ({ id: r.id, check: { ok: true, path: r.path, kind: 'absent' } })), pathRoots: {} }),
        }),
      });
      ssh.reply(['rsync', '--version'], { stdout: 'rsync  version 3.2.7  protocol version 31\n' });

      const c = connectHandover({ fleetHome: home, registry });
      try {
        await c.handover.preflight(trift, {});
      } finally {
        await c.close();
      }
      expect(asked).toEqual([expect.objectContaining({ destination: expect.objectContaining({ fleetHome: '/srv/fleets/ada' }) })]);
    } finally {
      process.env.ARCHI_GATEWAY_PREFIX = saved;
      if (saved === undefined) delete process.env.ARCHI_GATEWAY_PREFIX;
      for (const wss of daemons) await new Promise((r) => wss.close(r));
      await authority.close();
      ssh.clean();
      cleanHomes();
    }
  });

  it('reads a daemon\'s refusal as its answer, and a call that never answered as a client to open again', async () => {
    const opened: string[] = [];
    let clients = 0;
    let fail: 'refuse' | 'drop' | undefined;
    const daemon = reconnecting(async () => {
      const n = `client ${++clients}`;
      opened.push(n);
      return {
        call: (async () => {
          if (fail === 'refuse') throw new ApiError('blocked', 'bo is waiting on an answer', { blockers: [{ code: 'agent_blocked', message: 'bo' }] });
          if (fail === 'drop') throw new Error('archid connection closed');
          return { answered: n };
        }) as never,
        close: () => opened.push(`${n} closed`),
        closed: false,
      };
    });
    expect(await daemon.call('state.get', {})).toEqual({ answered: 'client 1' });
    fail = 'refuse';
    const refused = await daemon.call('state.get', {}).catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(Refused);
    expect(refused).toMatchObject({ code: 'blocked', data: { blockers: [{ code: 'agent_blocked' }] } });
    fail = 'drop';
    await expect(daemon.call('state.get', {})).rejects.toThrow('connection closed');
    await new Promise((r) => setImmediate(r));
    fail = undefined;
    expect(await daemon.call('state.get', {})).toEqual({ answered: 'client 2' });
    expect(opened).toEqual(['client 1', 'client 1 closed', 'client 2']);
  });

  it('lets go only the client a failed call used, never one a later call has opened since', async () => {
    type Pending = { resolve(v: unknown): void; reject(e: Error): void };
    const clients: { calls: Pending[]; closed: boolean }[] = [];
    const daemon = reconnecting(async () => {
      const c = { calls: [] as Pending[], closed: false };
      clients.push(c);
      return {
        call: (() => new Promise((resolve, reject) => { c.calls.push({ resolve, reject }); })) as never,
        // as a socket's close lands later, the calls still out on it fail only when the test says
        close: () => { c.closed = true; },
        get closed() { return c.closed; },
      };
    });
    const tick = () => new Promise((r) => { setImmediate(r); });
    const a = daemon.call('state.get', {}).catch((e: Error) => e.message);
    const b = daemon.call('state.get', {}).catch((e: Error) => e.message);
    await tick();
    // the first client's link breaks under both calls, and a third call opens a second client between their failures
    clients[0].calls[0].reject(new Error('archid connection closed'));
    expect(await a).toBe('archid connection closed');
    const c = daemon.call('state.get', {});
    await tick();
    clients[0].calls[1].reject(new Error('archid connection closed'));
    expect(await b).toBe('archid connection closed');
    await tick();

    expect(clients).toHaveLength(2);
    expect(clients[1].closed).toBe(false);
    clients[1].calls[0].resolve({ answered: 2 });
    expect(await c).toEqual({ answered: 2 });
  });

  it('opens another client for a call when the daemon closed the last one between calls, and answers at once', async () => {
    const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    await new Promise((r) => wss.once('listening', r));
    const sockets: WebSocket[] = [];
    wss.on('connection', (ws) => {
      sockets.push(ws);
      const connection = sockets.length;
      let authed = false;
      ws.on('message', (raw) => {
        if (!authed) { authed = true; ws.send(JSON.stringify({ id: 0, result: { ok: true, protocol: PROTOCOL_VERSION } })); return; }
        ws.send(JSON.stringify({ id: (JSON.parse(raw.toString()) as { id: number }).id, result: { connection } }));
      });
    });
    const url = `ws://127.0.0.1:${(wss.address() as { port: number }).port}`;
    let last: Client | undefined;
    const daemon = reconnecting(async () => (last = await Client.connectEndpoint({ url, token: 't' })));
    try {
      expect(await daemon.call('state.get', {})).toEqual({ connection: 1 });
      // the far daemon restarts, or the master under its forward drops, while no call is out
      const closed = new Promise<void>((r) => last!.onClose(r));
      sockets[0].terminate();
      await closed;

      const at = Date.now();
      const answer = await Promise.race([daemon.call('state.get', {}), new Promise((r) => { setTimeout(() => r('no answer within 2 s'), 2000).unref(); })]);
      expect(answer).toEqual({ connection: 2 });
      expect(Date.now() - at).toBeLessThan(1000);
    } finally {
      daemon.close();
      await new Promise((r) => wss.close(r));
    }
  });

  it('stops at a prepare the destination closes on as too large to read, sent once and never again', async () => {
    const w = new World();
    const near = w.daemon('trift');
    const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    await new Promise((r) => wss.once('listening', r));
    let prepares = 0;
    let connections = 0;
    wss.on('connection', (ws) => {
      connections++;
      let authed = false;
      ws.on('message', (raw) => {
        if (!authed) { authed = true; ws.send(JSON.stringify({ id: 0, result: { ok: true, protocol: PROTOCOL_VERSION } })); return; }
        const req = JSON.parse(raw.toString()) as { id: number; method: 'state.get'; params: never };
        if (req.method === ('handover.prepare' as string)) { prepares++; ws.close(1009, 'request too large'); return; }
        near.call(req.method, req.params).then(
          (result) => ws.send(JSON.stringify({ id: req.id, result })),
          (e: Refused) => ws.send(JSON.stringify({ id: req.id, error: { code: e.code, message: e.message, ...(e.data && { data: e.data }) } })),
        );
      });
    });
    const url = `ws://127.0.0.1:${(wss.address() as { port: number }).port}`;
    const daemon = reconnecting(() => Client.connectEndpoint({ url, token: 't' }));
    try {
      const out = await controller(w, { side: async (id) => (id === trift ? { ...w.side(id), daemon } : w.side(id)) }).start(trift);
      expect(prepares).toBe(1);
      expect(w.events.filter((e) => e.event === 'handover.retry')).toEqual([]);
      expect(out).toMatchObject({ status: 'interrupted', phase: 'prepare', error: expect.stringContaining('request too large'), safe: ['resume', 'abort'] });
      // the socket it closed is not asked again: the next call opens another
      expect(await daemon.call('system.info', {})).toMatchObject({ machineId: trift });
      expect(connections).toBe(2);
    } finally {
      daemon.close();
      await new Promise((r) => wss.close(r));
    }
  });

  it('asks the gateway over ssh, reads its refusal as an answer, and its silent authority as none', async () => {
    const runs: string[][] = [];
    let frame: unknown = { result: { record: { fleetId, generation: G, ownerMachineId: mac } } };
    const master = { run: async (argv: string[]) => { runs.push(argv); return { code: 0, signal: null, stdout: `${JSON.stringify(frame)}\n`, stderr: '', truncated: false }; } };
    const exe = '/home/ada/.local/share/archipelago/current/bin/archi';
    const gateway = gatewayOf((op, id, params) => remoteOwner({ master, exe, op, fleetId: id, ...(params && { params }) }), fleetId);
    expect(await gateway.get()).toEqual({ fleetId, generation: G, ownerMachineId: mac });
    await gateway.ready({ transactionId: 'tx-1', expectedGeneration: G, preparedDigest: 'd'.repeat(64) });
    const params = JSON.parse(runs[1][runs[1].indexOf('--params') + 1].slice(1, -1));
    expect(runs[1].slice(1, 3)).toEqual(['gateway', 'owner']);
    expect(params).toEqual({ transactionId: 'tx-1', expectedGeneration: G, preparedDigest: 'd'.repeat(64), sourceFrozen: true });
    frame = { error: { code: 'generation_mismatch', message: 'this fleet is at generation 5, not 4', data: { expected: 4, actual: 5 } } };
    await expect(gateway.commit({ transactionId: 'tx-1', expectedGeneration: G })).rejects.toMatchObject({ name: 'Refused', code: 'generation_mismatch', data: { actual: 5 } });
    frame = { error: { code: 'disconnected', message: 'the gateway authority did not answer on its socket' } };
    const silent = await gateway.get().catch((e: unknown) => e);
    expect(silent).not.toBeInstanceOf(Refused);
  });

  it('relays the daemon\'s own handover rows as they arrive and never its phases, reads the gateway\'s record, and keeps its token to scrub', async () => {
    const prefix = makeHome();
    const home = makeHome();
    const saved = process.env.ARCHI_GATEWAY_PREFIX;
    process.env.ARCHI_GATEWAY_PREFIX = prefix;
    const authority = await startAuthorityServer({ prefix });
    const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    await new Promise((r) => wss.once('listening', r));
    const row = { transactionId: 'tx-9', kind: 'character', id: 'c_ada', phase: 'freeze' };
    wss.on('connection', (ws) => {
      let authed = false;
      ws.on('message', (raw) => {
        if (!authed) { authed = true; ws.send(JSON.stringify({ id: 0, result: { ok: true, protocol: PROTOCOL_VERSION } })); return; }
        const req = JSON.parse(raw.toString()) as { id: number; method: string };
        ws.send(JSON.stringify({ event: 'state.patch', data: { ops: [] } }));
        // the daemon's journal reports its own step on every write: only the controller says where the handover is
        ws.send(JSON.stringify({ event: 'handover.changed', data: { transactionId: 'tx-9', phase: 'freeze' } }));
        ws.send(JSON.stringify({ event: 'handover.entity', data: row }));
        ws.send(JSON.stringify({ id: req.id, result: { characters: [], roots: [] } }));
      });
    });
    try {
      const registry = MachineRegistry.load(path.join(home, 'config'));
      const fleet = FleetId.parse(crypto.randomUUID());
      const client = await AuthorityClient.connect(prefix);
      await client.create({ fleetId: fleet, initialOwnerMachineId: registry.localId });
      client.close();
      fs.writeFileSync(path.join(home, 'fleet.json'), JSON.stringify({ id: fleet, gatewayMachineId: registry.localId }));
      fs.writeFileSync(path.join(home, 'node.json'), JSON.stringify({}));
      fs.writeFileSync(path.join(home, 'port'), String((wss.address() as { port: number }).port));
      fs.writeFileSync(path.join(home, 'token'), `${TOKEN}\n`);

      const recorded: HandoverEvent[] = [];
      const c = connectHandover({ fleetHome: home, registry, record: (e) => recorded.push(e) });
      try {
        expect(await c.owner()).toEqual({ fleetId: fleet, generation: 0, ownerMachineId: registry.localId });
        expect((await c.handover.status()).verdict.standing).toBe('none');
        expect(recorded).toEqual([{ event: 'handover.entity', data: row }]);
        expect(c.secrets()).toContain(TOKEN);
      } finally {
        await c.close();
      }
    } finally {
      process.env.ARCHI_GATEWAY_PREFIX = saved;
      if (saved === undefined) delete process.env.ARCHI_GATEWAY_PREFIX;
      await new Promise((r) => wss.close(r));
      await authority.close();
      cleanHomes();
    }
  });
});
