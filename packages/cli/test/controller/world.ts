import crypto from 'node:crypto';
import path from 'node:path';
import { expect } from 'vitest';
import {
  FleetConfig, FleetId, FleetState, MachineId, PROTOCOL_VERSION, TRANSFER_SCHEMA_VERSION, emptyState,
  type Blocker, type Character, type HandoverChoices, type HandoverEvent, type HandoverPhase, type LandedRoot, type Outcome, type OwnerRecord, type SystemInfo, type TransferFile,
} from '@svall/protocol';
import { transition, type OwnerOp } from '@svall/svalld/gateway/authority';
import { canonicalDigest } from '@svall/svalld/handover/hash';
import { manifestDigest } from '@svall/svalld/handover/manifest';
import { replicaRoots } from '@svall/svalld/handover/replicas';
import { Handover, Refused, type Daemon, type Gateway, type HandoverDeps, type Side } from '../../src/controller/handover.js';
import type { ControllerJournal, ControllerStore, FrozenManifest } from '../../src/controller/recovery.js';
import type { Master, TransferOptions, TransferResult } from '../../src/controller/transfer.js';

export const fleetId = FleetId.parse(crypto.randomUUID());
export const mac = MachineId.parse(crypto.randomUUID());
export const trift = MachineId.parse(crypto.randomUUID());
export const SID = '3f2b8c1e-6a4d-4e7b-9c21-5d8f0a1b2c3d';
export const CODEX = '01a0cd02-8ea0-75c1-89b3-89718ecbd91f';
export const TOKEN = 'daemon-t0ken-never-written';
export const G = 4;

const sha = (s: string): string => crypto.createHash('sha256').update(s).digest('hex');
export const file = (p: string): TransferFile => ({ type: 'file', path: p, mode: 0o644, size: p.length, mtimeMs: 0, sha256: sha(p) });
export const char = (id: string, name: string, cwd: string, over: Partial<Character> = {}): Character => ({
  id, islandId: 'home', cell: { x: 0, y: 1 }, name, portrait: 'fox', note: '', instructions: '', cwd, context: [],
  shell: { lastOutputAt: 0 }, unread: false, revive: { command: '' }, ...over,
});

// both machines have the same home, and so the same fleet home
export const HOME = '/Users/ada';
export const FLEET_HOME = '/Users/ada/.svall';
export const at = (p: string): string => path.posix.join(HOME, p);

/** The manifest a source freezes: a repository with a folded worktree, a Git directory of its own, and one Claude session. */
export function manifestFor(tx: string | undefined, from = mac, to = trift): FrozenManifest {
  const snapshot = emptyState();
  snapshot.characters.c_ada = char('c_ada', 'ada', at('app'), {
    agent: { kind: 'claude', sessionId: SID, transcriptPath: at(`.claude/projects/-app/${SID}.jsonl`), status: 'idle', lastActivityAt: 0 },
  });
  snapshot.characters.c_bo = char('c_bo', 'bo', at('app'), {
    agent: { kind: 'codex', sessionId: CODEX, transcriptPath: at(`.codex/sessions/rollout-${CODEX}.jsonl`), status: 'idle', lastActivityAt: 0 },
  });
  return {
    version: TRANSFER_SCHEMA_VERSION, transactionId: tx as string, generation: G, fromMachineId: from, toMachineId: to,
    home: HOME, fleet: FleetConfig.parse({ id: fleetId, gatewayMachineId: trift }),
    snapshot: FleetState.parse(snapshot), excludes: ['node_modules/', 'logs/'],
    roots: [
      { id: 'r_app', kind: 'repo', entry: 'dir', path: at('app'), files: [file('a.txt'), file('Readme.md'), file('README.md')] },
      { id: 'r_wt', kind: 'worktree', entry: 'dir', path: at('app/.claude/worktrees/x'), foldedInto: 'r_app', files: [] },
      { id: 'r_git', kind: 'gitdir', entry: 'dir', path: at('app.git'), files: [file('HEAD'), file('logs/HEAD')] },
    ],
    sessions: [
      {
        characterId: 'c_ada', agent: 'claude', sessionId: SID, sourcePath: at(`.claude/projects/-app/${SID}.jsonl`),
        sourceHome: at('.claude'), destinationHome: at('.claude'), destinationPath: at(`.claude/projects/-app/${SID}.jsonl`), adapter: 1,
        files: [file(`projects/-app/${SID}.jsonl`), file(`projects/-app/${SID}/subagents/a.jsonl`)],
      },
      {
        characterId: 'c_bo', agent: 'codex', sessionId: CODEX, sourcePath: at(`.codex/sessions/rollout-${CODEX}.jsonl`),
        sourceHome: at('.codex'), destinationHome: at('.codex'), destinationPath: at(`.codex/sessions/rollout-${CODEX}.jsonl`), adapter: 1,
        files: [file(`sessions/rollout-${CODEX}.jsonl`)],
      },
    ],
  };
}

export const info = (machineId: MachineId, over: Partial<SystemInfo> = {}): SystemInfo => ({
  machineId, release: 'dev', protocol: PROTOCOL_VERSION, stateSchema: emptyState().version, transferSchema: TRANSFER_SCHEMA_VERSION,
  platform: machineId === mac ? 'darwin' : 'linux', arch: 'arm64', git: '2.43.0',
  agentAdapters: [
    { kind: 'claude', version: '2.1.280', adapter: 1, home: at('.claude'), loggedIn: true, hooks: true },
    { kind: 'codex', version: '0.156.1', adapter: 1, home: at('.codex'), loggedIn: true, hooks: true },
  ],
  ...over,
});

/** The line of the controller's source a request is sent from, read off the stack it is sent on. */
export const callSite = (): number | undefined => {
  const at = /\/controller\/handover\.ts:(\d+):/.exec(new Error().stack ?? '');
  return at ? Number(at[1]) : undefined;
};

class Died extends Error {}
/**
 * What strikes the call at `at`: the controller dies after it, its answer is lost, the request is lost, its machine
 * drops off the network, the request reaches its party twice, or it is held back until the call after it there is answered.
 */
export type Fault = { at: number; kind: 'death' | 'lost' | 'dropped' | 'partition' | 'duplicate' | 'stale' };

/** A daemon's answers, keyed by method, as the real service gives them. */
type Answers = Record<string, (p: never) => unknown>;
/** What the controller told the source of the two machines. */
type Sent = { source: { home: string }; destination: { home: string; fleetHome: string } };
export type Probe = { exists: boolean; writable: boolean; caseInsensitive: boolean; freeBytes: number };

export class FakeSource {
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
    'handover.preflight': (p: Sent) => {
      if (this.frozen) throw new Refused('frozen', 'this fleet is frozen for a handover');
      const manifest = manifestFor(undefined, this.id, this.other);
      this.w.sent.push({ method: 'handover.preflight', source: p.source, destination: { home: p.destination.home, fleetHome: p.destination.fleetHome } });
      return { manifestSummary: { digest: manifestDigest(manifest), roots: 2, files: 5, bytes: 100, sessions: 2 }, blockers: this.preflightBlockers, warnings: [], manifest };
    },
    'handover.freeze': (p: { transactionId: string; generation: number; choices: HandoverChoices } & Sent) => {
      this.w.sent.push({ method: 'handover.freeze', source: p.source, destination: { home: p.destination.home, fleetHome: p.destination.fleetHome } });
      return this.freeze(p);
    },
    'handover.abort': (p: { transactionId: string; generation: number }) => this.abort(p),
    'handover.complete': (p: { transactionId: string; generation: number; landed?: LandedRoot[] }) => this.complete(p),
  };

  get other(): MachineId { return this.id === mac ? trift : mac; }

  status() {
    const j = this.journal;
    return j ? { transaction: { id: j.tx, fromMachineId: this.id, toMachineId: this.other, phase: j.phase, startedAt: 1 } } : {};
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
    this.sealed = p.landed ?? replicaRoots(this.kept!).map((x) => ({ id: x.id, files: this.kept!.roots.find((y) => y.id === x.id)!.files }));
    this.owner = { generation: r.generation, machine: r.ownerMachineId };
    this.journal = undefined;
    return {};
  }
}

export class FakeDestination {
  claims = new Map<string, string>();
  journal?: { tx: string; generation: number; phase: HandoverPhase; preparedDigest?: string };
  activated = false;
  activations = 0;
  sealed = false;
  /** roots holding work no handover left, until a claim archives them */
  diverged = new Set<string>();
  /** roots that already hold the replica an earlier handover left */
  replicas = new Set<string>();
  archived: string[] = [];
  probe: Probe = { exists: true, writable: true, caseInsensitive: false, freeBytes: 1e12 };
  /** what a folder reads as when it is not `probe` */
  folders: Record<string, Probe> = {};
  landedSeen?: LandedRoot[];
  /** the folders its Codex already trusts */
  trusted = new Set<string>();
  /** the folders where its Claude starts in bypass mode without warning first */
  accepted = new Set<string>();

  constructor(private w: World, readonly id: MachineId) {}

  get running(): boolean { return this.activated; }

  answers: Answers = {
    'system.info': () => info(this.id, this.w.infos[this.id]),
    'ownership.get': () => ({ fleetId, generation: this.w.record.generation, ownerMachineId: this.w.record.ownerMachineId, frozen: false }),
    'handover.status': () => {
      const j = this.journal;
      return j ? { transaction: { id: j.tx, fromMachineId: this.w.other(this.id), toMachineId: this.id, phase: j.phase, startedAt: 1 } } : {};
    },
    'handover.inspect': (p: { roots: { id: string; path: string }[]; folders: string[]; resumes?: { kind: string; cwd: string; bypass?: boolean }[] }) => ({
      roots: p.roots.map((r) => ({
        id: r.id,
        check: this.diverged.has(r.id) ? { ok: false, path: r.path, blocker: this.divergedBlocker(r.id, r.path) } : { ok: true, path: r.path, kind: this.replicas.has(r.id) ? 'replica' : 'absent' },
      })),
      folders: Object.fromEntries(p.folders.map((f) => [f, this.folders[f] ?? this.probe])),
      untrusted: (p.resumes ?? []).filter((f) => !this.trusted.has(`${f.kind} ${f.cwd}`)).map(({ kind, cwd }) => ({ kind, cwd })),
      bypassWarned: (p.resumes ?? []).filter((f) => f.bypass && !this.accepted.has(`${f.kind} ${f.cwd}`)).map(({ kind, cwd }) => ({ kind, cwd })),
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
      roots: replicaRoots(p.manifest).map((root) => {
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
    const carried = replicaRoots(p.manifest);
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
 * Both machines, the gateway, the transfer and the controller's store, with one fault that can strike any call.
 */
export class World {
  record: OwnerRecord = { fleetId, generation: G, ownerMachineId: mac };
  mac: FakeSource | FakeDestination;
  trift: FakeSource | FakeDestination;
  store: MemoryStore;
  infos: Record<string, Partial<SystemInfo>> = {};
  ops: string[] = [];
  /** the controller's source line each call of `ops` was made from */
  sites: (number | undefined)[] = [];
  violations: string[] = [];
  events: HandoverEvent[] = [];
  transfers: TransferOptions[] = [];
  transferResult?: (o: TransferOptions) => TransferResult;
  transferWait?: Promise<void>;
  fault?: Fault;
  dead = false;
  down = new Set<string>();
  /** requests held back, each delivered once the call after it to its port is answered */
  private held: { port: string; effect: () => unknown }[] = [];
  n = 0;
  now = 1000;
  txn = 0;
  sent: (Sent & { method: string })[] = [];
  farRsync = 'rsync  version 3.2.7  protocol version 31\n';
  masters = {
    trift: {
      socket: '/tmp/svall-ssh/trift', check: async () => true,
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

  /** A new controller process on a network that works again, after whatever was held back has arrived. */
  async heal(): Promise<void> {
    this.fault = undefined;
    this.dead = false;
    this.down.clear();
    await this.release();
  }

  /** Delivers the requests held back from `port`, or from every port; their answers go nowhere. */
  private async release(port?: string): Promise<void> {
    const due = this.held.filter((h) => port === undefined || h.port === port);
    this.held = this.held.filter((h) => !due.includes(h));
    for (const h of due) {
      try { await h.effect(); } catch { /* a refusal nobody hears */ }
      this.checkInvariants();
    }
  }

  private checkInvariants(): void {
    if (this.source.running && this.destination.running) this.violations.push('both machines ran the fleet at once');
  }

  /** One call into the world, with the fault that strikes it. */
  async call<T>(port: string, name: string, effect: () => T | Promise<T>): Promise<T> {
    if (this.dead) throw new Died('the controller is gone');
    if (this.down.has(port)) throw new Error(`${port} did not answer ${name}: connection refused`);
    const k = this.n++;
    this.ops.push(`${port}:${name}`);
    this.sites[k] = callSite();
    const f = this.fault?.at === k ? this.fault : undefined;
    if (f?.kind === 'dropped') throw new Error(`${port} did not answer ${name}: connection reset`);
    if (f?.kind === 'partition') { this.down.add(port); throw new Error(`${port} did not answer ${name}: connection refused`); }
    if (f?.kind === 'stale') {
      this.held.push({ port, effect });
      throw new Error(`${port} did not answer ${name} in time`);
    }
    let result: T | undefined;
    let refusal: unknown;
    try { result = await effect(); } catch (e) { refusal = e; }
    this.checkInvariants();
    // a request held back reaches its party only once the one sent after it has been answered
    await this.release(port);
    if (f?.kind === 'duplicate') {
      try { await effect(); } catch { /* the second delivery's answer goes nowhere */ }
      this.checkInvariants();
    }
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
        // what the wire carries: the params as JSON
        return answer(JSON.parse(JSON.stringify(params)) as never);
      })) as Daemon['call'],
    };
  }

  side(id: MachineId): Side {
    const name = id === mac ? 'mac' : 'trift';
    return {
      route: { machineId: id, name, ...(id === trift && { ssh: 'trift' }) },
      daemon: this.daemon(name),
      home: HOME,
      fleetHome: FLEET_HOME,
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

export function controller(w: World, o: Partial<HandoverDeps> = {}): Handover {
  return new Handover({
    fleetId, store: w.store, gateway: w.gateway, local: mac, machines: [mac, trift],
    side: async (id) => w.side(id), route: (id) => w.side(id).route, transfer: w.transfer, rsync: async () => '/opt/rsync', stateDir: '/tmp/svall-controller',
    clock: { now: () => w.now, sleep: async () => {} }, emit: (e) => w.events.push(e), retry: { attempts: 3, firstDelayMs: 1 },
    ...o,
  });
}

const landedOf = (w: World): LandedRoot[] => w.destination.landedSeen ?? [];

/** Where the fleet ended up: back on the source with nothing left open, or on the destination with everything completed. */
export function settledOn(w: World): 'source' | 'destination' {
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
export async function recover(w: World, first: 'resume' | 'abort' = 'resume'): Promise<Outcome[]> {
  await w.heal();
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

/** A world whose manifest carries one graph, and whose destination keeps a worktree at a commit it cannot prove comes back. */
export function keptCommit(o: { reached: boolean; at: 'inspect' | 'claim' }) {
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
  const unproven = [{ graph: 'g_app', path: '/Users/ada/stay', commit }];
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

export const phases = (w: World): HandoverPhase[] => w.events.flatMap((e) => (e.event === 'handover.changed' ? [e.data.phase] : []));
export const opIndex = (w: World, op: string): number => w.ops.indexOf(op);
