import path from 'node:path';
import { z } from 'zod';
import {
  Blocker, type AgentKind, type FleetId, type HandoverChoices, type HandoverPhase, type KeptCommit, type LandedRoot, type MachineId, type ManifestSummary, type MethodName, type OwnerRecord,
  type Params, type Result, type ResumeFolder, type RootClaim, type SystemInfo, type TransferManifestV1, type TransferRoot, type Warning,
  type CharacterResult, type HandoverEvent, type Outcome, type SafeAction, type Verdict,
} from '@svall/protocol';
import { boundary } from '@svall/svalld/handover/failpoints';
import { graphsHere } from '@svall/svalld/handover/git-import';
import { canonicalDigest } from '@svall/svalld/handover/hash';
import { settle } from '@svall/svalld/handover/inventory';
import { landingFolder, manifestDigest, spaceNeed } from '@svall/svalld/handover/manifest';
import { holds } from '@svall/svalld/handover/portable-path';
import { caseCollisions } from '@svall/svalld/handover/probe';
import { ARCHIVABLE, replicaRoots } from '@svall/svalld/handover/replicas';
import { resumeFolders } from '@svall/svalld/handover/sessions/registry';
import { resolvePaths } from '@svall/svalld/paths';
import { FIRST_DELAY, FleetMismatch, MachineMismatch, MAX_DELAY, retryable } from './connection.js';
import { entryEvent, namesOf, Observer } from './events.js';
import { redact } from './process.js';
import { ProgressJournal, transactionDir } from './progress.js';
import { assess, type ControllerJournal, type ControllerStore, type FrozenManifest, type Observation, type Route, type Seen } from './recovery.js';
import { SshError } from './ssh.js';
import { farRsync, transfer as runTransfer, type Master, type RootEntry, type SessionEntry, type TransferOptions, type TransferResult } from './transfer.js';

/** A definite answer from a daemon or the gateway: it will not do what was asked, and says why. */
export class Refused extends Error {
  constructor(readonly code: string, message: string, readonly data?: Record<string, unknown>) {
    super(message);
    this.name = 'Refused';
  }
}

class Cancelled extends Error {
  constructor() { super('the handover was cancelled'); }
}

/** Blockers found after Begin that the user did not choose a way around. */
class Blocked extends Error {
  constructor(readonly phase: HandoverPhase, readonly blockers: Blocker[]) { super(blockers.map((b) => b.message).join('; ')); }
}

/** A step that cannot go on: an answer that does not fit what was asked, or one that never came. */
class Stopped extends Error {
  constructor(readonly phase: HandoverPhase, message: string, readonly safe: SafeAction[]) { super(message); }
}

/** An abort that found the gateway had moved the fleet: only going forward is left. */
class Moved extends Error {}

/** A daemon the controller calls. A `Refused` is its answer; any other error leaves the call's fate unknown. */
export type Daemon = { call<M extends MethodName>(method: M, params: Params<M>): Promise<Result<M>> };

/** The gateway's compare-and-swap operations on this fleet's record, answered the same way. */
export type Gateway = {
  get(): Promise<OwnerRecord>;
  begin(p: { expectedGeneration: number; fromMachineId: MachineId; toMachineId: MachineId }): Promise<OwnerRecord>;
  ready(p: { transactionId: string; expectedGeneration: number; preparedDigest: string }): Promise<OwnerRecord>;
  commit(p: { transactionId: string; expectedGeneration: number }): Promise<OwnerRecord>;
  abort(p: { transactionId: string; expectedGeneration: number }): Promise<OwnerRecord>;
  complete(p: { transactionId: string; generation: number }): Promise<OwnerRecord>;
};

/** One machine as the controller reaches it: its daemon, its home and fleet home, and the master rsync rides to a far one. */
export type Side = { route: Route; daemon: Daemon; home: string; fleetHome: string; master?: () => Promise<Master> };

export type HandoverClock = { now(): number; sleep(ms: number): Promise<void> };

export type HandoverDeps = {
  fleetId: FleetId;
  store: ControllerStore;
  gateway: Gateway;
  /** the machine this controller runs on, and each machine a handover of this fleet can involve */
  local: MachineId;
  machines: MachineId[];
  side(machineId: MachineId): Promise<Side>;
  /** where a machine is reached, from the registry, without dialling it */
  route(machineId: MachineId): Route;
  transfer?: (o: TransferOptions) => Promise<TransferResult>;
  /** the local rsync, found only when a transfer needs it, and where the transfer keeps its progress journal and filters */
  rsync(): Promise<string>;
  stateDir: string;
  clock?: HandoverClock;
  emit?(e: HandoverEvent): void;
  /** Every event, those after a cancel let the watcher go included: what a helper keeps and serves. */
  record?(e: HandoverEvent): void;
  /** Asks the user about blockers found after Begin: new choices to try the step again with, or cancel. Without it, the handover aborts. */
  decide?(blockers: Blocker[], phase: HandoverPhase): Promise<HandoverChoices | 'cancel'>;
  retry?: { attempts: number; firstDelayMs: number };
  /** The gateway's record once the fleet has moved, for whatever routes to it next. */
  moved?(record: OwnerRecord): void;
  /** The daemon tokens this controller holds: never written to a journal, an event or a transfer record. */
  secrets?(): string[];
};

/** What preflight found; a machine that already runs the fleet, or a frozen source, is refused before any manifest is asked for. */
export type Preflight = { generation: number; blockers: Blocker[]; warnings: Warning[] } & ({ summary: ManifestSummary; manifest: TransferManifestV1 } | { summary?: undefined; manifest?: undefined });

const RETRY = { attempts: 4, firstDelayMs: FIRST_DELAY };
const PHASES: readonly HandoverPhase[] = ['begin', 'freeze', 'transfer', 'verify', 'prepare', 'ready', 'commit', 'activate', 'complete'];
const PRE_COMMIT: SafeAction[] = ['resume', 'abort'];

const realClock: HandoverClock = { now: Date.now, sleep: (ms) => new Promise((r) => { setTimeout(r, ms); }) };
const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e));
const blockersOf = (e: Refused): Blocker[] => {
  const said = z.array(Blocker).safeParse(e.data?.blockers);
  return said.success ? said.data : [{ code: 'path_unsupported', message: e.message }];
};
const after = (phase: HandoverPhase, than: HandoverPhase): boolean => PHASES.indexOf(phase) > PHASES.indexOf(than);
const describe = (r: OwnerRecord): string =>
  `${r.ownerMachineId} at generation ${r.generation}${r.transaction ? ` in handover ${r.transaction.id} (${r.transaction.phase})` : ''}`;

/** What an ssh that would have to ask for a password or a host key says, as the blocker a handover, which asks nothing, raises. */
const interactive = (e: unknown): Blocker | undefined => (e instanceof SshError && (e.kind === 'auth' || e.kind === 'host_key')
  ? { code: 'ssh_interactive', message: `ssh would have to ask before it could go on, and a handover asks nothing: ${e.message}` } : undefined);

/** A destination whose companion runs another fleet there, or a gateway an alias now leads elsewhere, as the blocker that names it. */
const foreign = (e: unknown): Blocker | undefined => (e instanceof FleetMismatch || e instanceof MachineMismatch ? { code: 'identity_mismatch', message: e.message } : undefined);

/** A companion on another protocol, or one whose svall does not run, which only an upgrade changes. */
const incompatible = (e: unknown): Blocker | undefined => (e instanceof SshError && e.kind === 'version' ? { code: 'incompatible_protocol', message: e.message } : undefined);

/** Worth asking again: an ssh a transport comes back from, a call whose answer never came, or a daemon that could not reach the gateway. */
const transient = (e: unknown): boolean => {
  if (e instanceof SshError) return retryable(e);
  if (e instanceof Refused) return e.code === 'authority_unreachable';
  return !(e instanceof Cancelled || e instanceof Blocked || e instanceof Stopped || e instanceof Moved);
};

/** What differs between the machines in a way the fleet feels: an agent CLI at another release. */
function differences(source: Side, a: SystemInfo, destination: Side, b: SystemInfo, m: TransferManifestV1): Warning[] {
  const kinds = new Set(Object.values(m.snapshot.characters).flatMap((c) => [c.agent?.kind, c.second?.agent?.kind]));
  return a.agentAdapters.flatMap((x): Warning[] => {
    const y = b.agentAdapters.find((z) => z.kind === x.kind);
    if (!kinds.has(x.kind) || !x.version || !y?.version || x.version === y.version) return [];
    return [{
      code: 'config_difference',
      message: `${x.kind} ${x.version} runs on ${source.route.name} and ${y.version} on ${destination.route.name}; each keeps its own login, settings, skills and MCP servers, which do not move with the fleet`,
    }];
  });
}

/** A link a carried root holds, where its target lies, and whether what a carried root copies there holds it; undefined when none does. */
type CarriedLink = { root: TransferRoot; path: string; at: string; carried?: boolean };

function carriedLinks(m: TransferManifestV1): CarriedLink[] {
  const carried = m.roots.filter((r) => !r.foldedInto);
  const innermostFirst = [...carried].sort((a, b) => b.path.length - a.path.length);
  // every path a root carries and every folder holding one, gathered once per root a link leads into
  const held = new Map<TransferRoot, Set<string>>();
  const heldBy = (root: TransferRoot): Set<string> => {
    let names = held.get(root);
    if (!names) {
      names = new Set();
      for (const f of root.files) for (let i = f.path.indexOf('/'); i !== -1; i = f.path.indexOf('/', i + 1)) names.add(f.path.slice(0, i));
      for (const f of root.files) names.add(f.path);
      held.set(root, names);
    }
    return names;
  };
  return carried.flatMap((r) => r.files.flatMap((f): CarriedLink[] => {
    if (f.type !== 'symlink') return [];
    const from = f.path === '' ? path.posix.dirname(r.path) : path.posix.join(r.path, path.posix.dirname(f.path));
    const at = path.posix.resolve(from, f.target);
    const holder = innermostFirst.find((x) => holds(x.path, at));
    const rel = holder && path.posix.relative(holder.path, at);
    return [{ root: r, path: f.path, at, ...(holder && { carried: rel === '' || heldBy(holder).has(rel!) }) }];
  }));
}

/** Each root whose links will point at nothing on the destination: carried as they are, which only a warning says. */
function danglingLinks(links: CarriedLink[], missing: Set<string>, where: string): Warning[] {
  const byRoot = new Map<string, { root: TransferRoot; names: string[] }>();
  for (const l of links) {
    if (l.carried ?? !missing.has(l.at)) continue;
    const held = byRoot.get(l.root.id) ?? { root: l.root, names: [] };
    held.names.push(l.path || path.posix.basename(l.root.path));
    byRoot.set(l.root.id, held);
  }
  return [...byRoot.values()].map(({ root, names }) => ({
    code: 'symlink_dangling', entity: { kind: 'root', id: root.id },
    message: `${names.length} ${names.length === 1 ? 'link' : 'links'} in ${root.path} will point at nothing on ${where}: ${names.slice(0, 5).join(', ')}${names.length > 5 ? ', …' : ''}; each is carried as it is`,
  }));
}

// the question each agent asks of a folder it has not trusted, and how the user answers it
const TRUST = {
  claude: { code: 'claude_trust', agent: 'Claude', answer: ', with "No, exit" preselected; choose "Yes, I trust this folder" in that terminal' },
  codex: { code: 'codex_trust', agent: 'Codex', answer: '; answer it in that terminal' },
} as const;

/** Svall never writes the destination's agent settings, so each agent asks to trust these folders the first time it resumes there. */
function trustWarnings(m: TransferManifestV1, untrusted: { characterId: string; kind: AgentKind }[], where: string): Warning[] {
  // a handover carries no OpenCode session, so none resumes there to ask
  return untrusted.flatMap((f) => (f.kind === 'opencode' ? [] : [{
    code: TRUST[f.kind].code,
    message: `${TRUST[f.kind].agent} asks whether to trust its folder the first time ${m.snapshot.characters[f.characterId]?.name ?? f.characterId} resumes on ${where}${TRUST[f.kind].answer}`,
    entity: { kind: 'character', id: f.characterId },
  }]));
}

/** Only Claude has a bypass mode to warn about, which it does until the destination's Claude has accepted it once. */
function bypassWarnings(m: TransferManifestV1, warned: { characterId: string }[], where: string): Warning[] {
  return warned.map((f) => ({
    code: 'claude_bypass',
    message: `Claude warns that ${m.snapshot.characters[f.characterId]?.name ?? f.characterId} resumes in Bypass Permissions mode on ${where}, with "No, exit" preselected; choose "Yes, I accept" in that terminal`,
    entity: { kind: 'character', id: f.characterId },
  }));
}

/**
 * One handover of one fleet, driven from this controller: preflight, then Begin, Freeze, Transfer, Verify,
 * Prepare, Ready, Commit, Activate and Complete, each checked against what it answers and journaled before the
 * next. Before the commit a cancel or a blocker aborts, gateway first; after it only the destination goes on.
 */
export class Handover {
  /** The whole run, including what goes on after a cancel past the commit detached the watcher. */
  finished?: Promise<Outcome>;
  private observer: Observer;
  private clock: HandoverClock;
  private cancel$ = new AbortController();
  private committed = false;
  private j?: ControllerJournal;
  private sides = new Map<MachineId, Promise<Side>>();
  private chosen?: HandoverChoices;
  /** where each root's claim moved what it held before, which its rows keep saying */
  private archived = new Map<string, string>();
  private wakeChosen?: () => void;
  private onDetach?: () => void;

  constructor(private d: HandoverDeps) {
    this.observer = new Observer(d.emit, d.record);
    this.clock = d.clock ?? realClock;
  }

  /** What would stop a handover to `to` before anything moves: the source's checks, the destination's roots and room, and what differs between them. */
  async preflight(to: MachineId, choices: HandoverChoices = {}): Promise<Preflight> {
    const record = await this.retrying('begin', () => this.d.gateway.get());
    const from = record.ownerMachineId;
    if (to === from) {
      const message = `${this.d.route(to).name} already runs this fleet, at generation ${record.generation}; there is nothing to hand it`;
      return { generation: record.generation, blockers: [{ code: 'identity_mismatch', message }], warnings: [] };
    }
    const blockers: Blocker[] = [];
    const mismatch = (message: string) => blockers.push({ code: 'identity_mismatch', message });
    if (record.transaction) {
      blockers.push({ code: 'transaction_open', message: `this fleet is already in handover ${record.transaction.id} (${record.transaction.phase}); resume or abort it first` });
    }
    if (from !== this.d.local && to !== this.d.local) mismatch('this controller moves a fleet only to or from the machine it runs on');
    const [source, destination] = await Promise.all([this.side(from), this.side(to)]);
    const [a, b, owned, receiving] = await Promise.all([
      this.retrying('begin', () => source.daemon.call('system.info', {})),
      this.retrying('begin', () => destination.daemon.call('system.info', {})),
      this.retrying('begin', () => source.daemon.call('ownership.get', {})),
      this.retrying('begin', () => destination.daemon.call('ownership.get', {})),
    ]);
    if (a.machineId !== from) mismatch(`${source.route.name} answered as machine ${a.machineId}, not ${from}`);
    if (b.machineId !== to) mismatch(`${destination.route.name} answered as machine ${b.machineId}, not ${to}`);
    if (owned.fleetId !== this.d.fleetId || owned.ownerMachineId !== from || owned.generation !== record.generation) {
      blockers.push({ code: 'generation_mismatch', message: `${source.route.name} holds this fleet for ${owned.ownerMachineId} at generation ${owned.generation}, and the gateway for ${from} at ${record.generation}` });
    }
    if (owned.frozen && !record.transaction) blockers.push({ code: 'transaction_open', message: `${source.route.name} is frozen for a handover the gateway no longer holds; abort it first` });
    blockers.push(...await this.linkChecks(source, destination));
    const held = receiving.journal;
    if (held) {
      blockers.push({ code: 'transaction_open', message: `${destination.route.name} holds handover ${held.transactionId} open as its ${held.role} (${held.phase}); resume or abort it first` });
    }
    // a frozen source answers no preflight, and a transaction_open blocker above already says why
    if (owned.frozen) return { generation: record.generation, blockers: settle(blockers), warnings: [] };
    const pre = await this.retrying('begin', () => source.daemon.call('handover.preflight', {
      toMachineId: to, choices, source: { home: source.home }, destination: { info: b, home: destination.home, fleetHome: destination.fleetHome },
    }));
    // a manifest answered without its file lists would have the destination judge every root as empty
    const stripped = pre.blockers.some((x) => x.code === 'too_many_files' || x.code === 'manifest_too_large');
    const there = stripped ? { blockers: [], warnings: [] } : await this.destinationChecks(source, destination, pre.manifest, choices);
    blockers.push(...pre.blockers, ...there.blockers);
    const warnings = [...pre.warnings, ...there.warnings, ...differences(source, a, destination, b, pre.manifest)];
    const out = { generation: record.generation, summary: pre.manifestSummary, blockers: settle(blockers), warnings: settle(warnings), manifest: pre.manifest };
    this.observer.send({ event: 'handover.preflight', data: { summary: out.summary, blockers: out.blockers, warnings: out.warnings, names: namesOf(pre.manifest) } });
    return out;
  }

  /** Preflight, and then the transaction from Begin, unless preflight found what stops it. */
  start(to: MachineId, choices: HandoverChoices = {}): Promise<Outcome> {
    return this.watch(async () => {
      const open = this.d.store.read(true);
      if (open) return { status: 'interrupted', transactionId: open.transactionId, phase: open.phase, error: 'a handover of this fleet is already open here; resume it, which goes the one safe way on', safe: ['resume'] };
      let pre: Preflight;
      try { pre = await this.preflight(to, choices); } catch (e) {
        const stops = interactive(e) ?? foreign(e) ?? incompatible(e);
        if (!stops) throw e;
        return { status: 'blocked', phase: 'begin', blockers: [stops] };
      }
      if (pre.blockers.length || !pre.manifest) return { status: 'blocked', phase: 'begin', blockers: pre.blockers };
      if (this.cancel$.signal.aborted) return { status: 'aborted', phase: 'begin' };
      const [source, destination] = await Promise.all([this.side(pre.manifest.fromMachineId), this.side(to)]);
      const now = this.clock.now();
      this.j = { version: 1, fleetId: this.d.fleetId, generation: pre.generation, source: source.route, destination: destination.route, choices, phase: 'begin', startedAt: now, updatedAt: now };
      this.d.store.write(this.j);
      return this.forward(false);
    });
  }

  /** Goes the one safe way on from where the journals say the handover stands. */
  resume(): Promise<Outcome> {
    return this.watch(async () => {
      const o = await this.observe(true);
      const v = assess(o);
      if (v.action === 'none') return v.standing === 'none' ? { status: 'none', reason: v.reason } : this.stuck(v);
      // a journal rebuilt from the daemons' goes on from the destination's phase, or with none anywhere, from whether the source froze: each only that machine can say
      const silent = o.controller || v.standing !== 'open' ? undefined
        : o.destination?.ok === false ? `the destination did not say how far it got (${o.destination.error})`
          : v.phase === undefined && o.source?.ok === false ? `the source did not say how far it got (${o.source.error})` : undefined;
      if (silent) return this.stuck({ ...v, reason: `this controller keeps no journal of ${v.transactionId}, and ${silent}; resume once it answers` });
      try { await this.adopt(o, v); } catch (e) { return this.stopped(e); }
      if (v.action === 'finish-abort') return this.letGo({ status: 'aborted', transactionId: v.transactionId, phase: v.phase ?? 'begin' }).catch((e: unknown) => this.stopped(e));
      if (v.action === 'finish') {
        this.committed = true;
        return this.complete([]);
      }
      // a destination that holds no journal of a committed handover has completed it only if it runs the fleet it was handed
      const owns = o.destination?.ok ? o.destination.value.ownership : undefined;
      const completed = v.standing === 'committed' && !v.journals.destination && v.generation !== undefined
        && owns?.ownerMachineId === v.toMachineId && owns?.generation === v.generation + 1;
      return this.forward(v.standing === 'committed', completed);
    });
  }

  /** Takes the fleet back to the source, while nothing has committed it anywhere. */
  abort(): Promise<Outcome> {
    return this.watch(async () => {
      const o = await this.observe(true);
      const v = assess(o);
      if (!v.safe.includes('abort')) return v.standing === 'none' ? { status: 'none', reason: v.reason } : this.stuck(v);
      // a journal rebuilt without the source's could not say whether it froze, so nothing would unfreeze it
      if (!o.controller && v.phase === undefined && o.source?.ok === false) {
        return this.stuck({ ...v, reason: `this controller keeps no journal of ${v.transactionId}, and the source did not say how far it got (${o.source.error}); abort once it answers` });
      }
      try { await this.adopt(o, v); } catch (e) { return this.stopped(e); }
      const done: Outcome = { status: 'aborted', transactionId: v.transactionId, phase: v.phase ?? 'begin' };
      try {
        return await (v.action === 'finish-abort' ? this.letGo(done) : this.undo(done));
      } catch (e) {
        if (e instanceof Moved) return this.interrupted(v.phase ?? 'commit', `the gateway has committed ${v.transactionId}; only a resume goes on`, ['resume']);
        return this.stopped(e);
      }
    });
  }

  /** How the handover stands, from the four journals, without changing anything. */
  async status(): Promise<{ observation: Observation; verdict: Verdict }> {
    const observation = await this.observe();
    return { observation, verdict: assess(observation) };
  }

  /** New rest choices for a freeze still waiting on a terminal: the source is asked to freeze again with them. */
  choose(choices: HandoverChoices): void {
    this.chosen = { ...this.chosen, ...choices };
    this.wakeChosen?.();
  }

  /** A daemon's own row of a character's rest or activation, passed on in the shape it arrived in. */
  relay(e: HandoverEvent): void {
    this.observer.send(e);
  }

  /** Before Freeze a clean stop; after it a safe abort; after the commit it only stops telling the watcher, and the move goes on. */
  cancel(): void {
    if (this.committed) this.detach();
    else this.cancel$.abort();
  }

  private detach(): void {
    this.observer.detach();
    this.onDetach?.();
  }

  private watch(work: () => Promise<Outcome>): Promise<Outcome> {
    const finished = work().catch((e: unknown) => this.failed(e)).then((out) => {
      this.observer.send({ event: 'handover.result', data: out });
      return out;
    });
    this.finished = finished;
    return new Promise((resolve) => {
      this.onDetach = () => resolve({ status: 'detached', transactionId: this.j?.transactionId ?? '' });
      void finished.then(resolve);
    });
  }

  /** Runs the transaction on from wherever its journal stands, each step skipped once its digest is recorded. */
  private async forward(committed: boolean, activated = false): Promise<Outcome> {
    this.committed = committed;
    let characters: CharacterResult[] = [];
    try {
      if (!committed) await this.precommit();
      if (!activated) characters = await this.activate();
    } catch (e) {
      if (e instanceof Moved) return this.forward(true);
      return this.stopped(e);
    }
    return this.complete(characters);
  }

  private async precommit(): Promise<void> {
    await this.begin();
    if (this.cancel$.signal.aborted) throw new Cancelled();
    const [source, destination] = await this.pair();
    const manifest = await this.freeze(source, destination);
    let prepared = this.journal.preparedDigest;
    while (!prepared) {
      const landed = await this.landed(destination, manifest);
      if (typeof landed === 'string') {
        prepared = landed;
        this.save({ preparedDigest: prepared });
        break;
      }
      try {
        prepared = await this.prepare(destination, manifest, landed);
      } catch (e) {
        if (!(e instanceof Refused && e.code === 'blocked')) throw e;
        // what landed no longer holds: copied again once the user has seen why
        this.save({ choices: await this.decide('prepare', blockersOf(e)), landedDigest: undefined });
        this.phase('prepare');
      }
    }
    await this.ready(prepared);
    await this.commit();
  }

  /** Begin: the gateway opens the transaction from the source to the destination at generation g. */
  private async begin(): Promise<void> {
    if (this.journal.transactionId) return;
    const { source, destination, generation } = this.journal;
    let record: OwnerRecord;
    let unanswered = false;
    try {
      // its answer is read even after a cancel: it names the transaction the abort has to close
      record = await this.retrying('begin', async () => {
        try {
          return await this.cancellable(() => this.d.gateway.begin({ expectedGeneration: generation, fromMachineId: source.machineId, toMachineId: destination.machineId }), false);
        } catch (e) {
          if (transient(e)) unanswered = true;
          throw e;
        }
      }, this.cancel$.signal);
    } catch (e) {
      // a Begin whose answer never came may have opened the handover all the same: then the abort has one to close
      let opened: { id: string } | undefined;
      if (unanswered) {
        try { opened = await this.openedHere(); } catch (asked) {
          // a cancel is not taken as done while the gateway cannot say: the journal stays for the abort that closes it
          if (e instanceof Cancelled) {
            throw new Stopped('begin', `cancelled while Begin went unanswered, and the gateway cannot say whether it opened this handover (${messageOf(asked)}); abort once it answers`, ['abort']);
          }
        }
      }
      if (opened) {
        this.save({ transactionId: opened.id });
        this.phase('begin');
        if (e instanceof Cancelled) throw e;
        return;
      }
      if (!(e instanceof Refused)) throw e;
      const code = e.code === 'generation_mismatch' ? 'generation_mismatch' : e.code === 'not_owner' || e.code === 'invalid_request' ? 'identity_mismatch' : 'transaction_open';
      throw new Blocked('begin', [{ code, message: `the gateway would not begin this handover: ${e.message}` }]);
    }
    const tx = record.transaction;
    if (!tx || record.generation !== generation || record.ownerMachineId !== source.machineId || tx.fromMachineId !== source.machineId
      || tx.toMachineId !== destination.machineId || tx.phase !== 'preparing') {
      throw new Stopped('begin', `the gateway answered Begin with ${describe(record)}, not a handover from ${source.name} to ${destination.name} preparing at generation ${generation}`, PRE_COMMIT);
    }
    this.save({ transactionId: tx.id });
    this.phase('begin');
  }

  /** The handover the gateway holds preparing between this journal's machines at its generation, which only this Begin can have opened. */
  private async openedHere(): Promise<{ id: string } | undefined> {
    const { source, destination, generation } = this.journal;
    const r = await this.d.gateway.get();
    const tx = r.transaction;
    const ours = tx?.phase === 'preparing' && r.generation === generation && r.ownerMachineId === source.machineId
      && tx.fromMachineId === source.machineId && tx.toMachineId === destination.machineId;
    return ours ? tx : undefined;
  }

  /** Freeze: the source fences, rests its terminals with the user's choices, and answers the manifest it froze. */
  private async freeze(source: Side, destination: Side): Promise<FrozenManifest> {
    const { transactionId: tx, generation } = this.tx;
    const kept = this.journal.manifestDigest ? this.d.store.manifest(tx, this.journal.manifestDigest) : undefined;
    if (kept) return kept;
    // a journal rebuilt from the daemons' may stand past Freeze already: the source answers its manifest again, and the handover goes on from there
    if (!after(this.journal.phase, 'freeze')) this.phase('freeze');
    const info = await this.retrying('freeze', () => this.cancellable(() => destination.daemon.call('system.info', {})), this.cancel$.signal);
    for (;;) {
      if (this.chosen) this.save({ choices: { ...this.journal.choices, ...this.take() } });
      const params: Params<'handover.freeze'> = {
        transactionId: tx, generation, choices: this.journal.choices,
        source: { home: source.home }, destination: { info, home: destination.home, fleetHome: destination.fleetHome },
      };
      let answer: Result<'handover.freeze'> | 'chosen';
      try {
        answer = await this.orChosen((attempt) => this.retrying('freeze', () => this.cancellable(() => source.daemon.call('handover.freeze', params)), AbortSignal.any([this.cancel$.signal, attempt])));
      } catch (e) {
        // a rest that did not come to rest gave the fleet back; the user's answer is a freeze asked again, not an abort
        if (!(e instanceof Refused && e.code === 'blocked')) throw e;
        this.save({ choices: await this.decide('freeze', blockersOf(e)) });
        // an answered decision is not the stream's last word, so a replay never shows it pending
        this.phase('freeze');
        continue;
      }
      if (answer === 'chosen') continue;
      const m = answer.manifest;
      const wrong = m.transactionId !== tx ? `handover ${m.transactionId}` : m.generation !== generation ? `generation ${m.generation}`
        : m.fromMachineId !== source.route.machineId || m.toMachineId !== destination.route.machineId ? `a move from ${m.fromMachineId} to ${m.toMachineId}`
          : m.fleet.id !== this.d.fleetId ? `fleet ${m.fleet.id}`
            : m.home !== source.home ? 'a home other than the one it was sent' : undefined;
      if (wrong) throw new Stopped('freeze', `${source.route.name} froze with a manifest for ${wrong}`, PRE_COMMIT);
      const digest = manifestDigest(m);
      if (this.journal.manifestDigest && digest !== this.journal.manifestDigest) {
        throw new Stopped('freeze', `${source.route.name} answered manifest ${digest}, not the ${this.journal.manifestDigest} it froze with`, PRE_COMMIT);
      }
      this.d.store.saveManifest(tx, m);
      this.save({ manifestDigest: digest });
      return m;
    }
  }

  /**
   * What the transfer verified in each root: kept from an earlier run, or copied now. Once a prepare may have
   * run, a destination that prepared answers without it, since copying again would undo its Git import.
   */
  private async landed(destination: Side, manifest: FrozenManifest): Promise<LandedRoot[] | string> {
    const { transactionId: tx } = this.tx;
    const kept = this.journal.landedDigest ? this.d.store.landed(tx, this.journal.landedDigest) : undefined;
    if (kept) return kept;
    if (after(this.journal.phase, 'verify')) {
      try {
        return (await this.retrying('prepare', () => this.cancellable(() => destination.daemon.call('handover.prepare', this.prepareParams(manifest, []))), this.cancel$.signal)).preparedDigest;
      } catch (e) {
        if (!(e instanceof Refused && e.code === 'not_ready')) throw e;
      }
    }
    return this.transfer(manifest);
  }

  /** Transfer and Verify: the destination claims each root, then rsync mirrors every root and session file and proves the copy. */
  private async transfer(manifest: FrozenManifest): Promise<LandedRoot[]> {
    const { transactionId: tx } = this.tx;
    const [source, destination] = await this.pair();
    for (;;) {
      this.phase('transfer');
      const claims = await this.claim(destination, manifest);
      // rsync runs here, so this machine has to be one end of the copy
      if (!source.master === !destination.master) {
        throw new Stopped('transfer', `${source.route.name} and ${destination.route.name} are ${source.master ? 'both reached over ssh' : 'neither reached over ssh'}, so rsync has no link from this machine`, PRE_COMMIT);
      }
      const far = source.master ? source : destination;
      const master = await this.retrying('transfer', () => this.cancellable(far.master!), this.cancel$.signal);
      const rsync = await this.d.rsync().catch((e: unknown) => { throw new Stopped('transfer', `this machine has no rsync a handover can drive: ${messageOf(e)}`, PRE_COMMIT); });
      const entries = this.entries(manifest, claims, destination);
      if (this.cancel$.signal.aborted) throw new Cancelled();
      const result = await (this.d.transfer ?? runTransfer)({
        transactionId: tx, roles: source.master ? { source: 'remote', destination: 'local' } : { source: 'local', destination: 'remote' },
        master, rsync, entries, stateDir: this.d.stateDir, signal: this.cancel$.signal, secrets: this.d.secrets?.() ?? [],
        onProgress: (p) => this.observer.send(entryEvent(tx, p, this.archived.get(p.id))),
      });
      if (result.status === 'cancelled' || this.cancel$.signal.aborted) throw new Cancelled();
      if (result.status === 'blocked') {
        this.save({ choices: await this.decide('transfer', result.blockers) });
        continue;
      }
      const failed = result.entries.find((e) => e.status === 'failed');
      // a refused entry is never written past: the transaction stops, whatever the others did
      if (failed?.status === 'failed' || result.status !== 'verified') {
        throw new Stopped('transfer', failed?.status === 'failed' ? `${failed.id}: ${failed.error}` : result.failure?.error ?? `the transfer ended ${result.status}`, PRE_COMMIT);
      }
      const landed: LandedRoot[] = [];
      for (const r of replicaRoots(manifest)) {
        const done = result.entries.find((e) => e.id === r.id);
        if (done?.status !== 'verified') throw new Stopped('transfer', `the transfer verified nothing in root ${r.id} (${r.path})`, PRE_COMMIT);
        landed.push({ id: r.id, files: done.files });
      }
      this.d.store.saveLanded(tx, landed);
      this.save({ landedDigest: canonicalDigest(landed) });
      this.phase('verify');
      return landed;
    }
  }

  /**
   * The destination's claim on each carried root, exactly one each; a root it will not take goes to the user. What an
   * earlier transfer of this handover verified in a root, which its copy there may hold since, goes with it.
   */
  private async claim(destination: Side, manifest: FrozenManifest): Promise<RootClaim[]> {
    const { transactionId: tx, generation } = this.tx;
    const carried = replicaRoots(manifest).map((r) => r.id).sort();
    const progress = new ProgressJournal(tx, transactionDir(tx, this.d.stateDir));
    const landed = carried.flatMap((id): LandedRoot[] => { const files = progress.verified(id); return files ? [{ id, files }] : []; });
    for (;;) {
      const archive = this.journal.choices.archiveRoots;
      const r = await this.retrying('transfer', () => this.cancellable(() => destination.daemon.call('handover.claim', {
        transactionId: tx, generation: generation + 1, manifest, manifestDigest: this.journal.manifestDigest!, ...(archive?.length ? { archive } : {}), ...(landed.length && { landed }),
      })), this.cancel$.signal);
      const ids = r.roots.map((c) => c.id).sort();
      if (ids.length !== carried.length || ids.some((id, i) => id !== carried[i])) {
        throw new Stopped('transfer', `${destination.route.name} claimed ${ids.join(', ') || 'nothing'}, and the manifest carries ${carried.join(', ')}`, PRE_COMMIT);
      }
      for (const c of r.roots) {
        if (!c.archivedTo) continue;
        this.archived.set(c.id, c.archivedTo);
        this.observer.send({ event: 'handover.entity', data: { transactionId: tx, kind: 'root', id: c.id, phase: 'transfer', archivedTo: c.archivedTo } });
      }
      const refused = r.roots.flatMap((c) => (c.check.ok ? [] : [c.check.blocker]));
      const [source] = await this.pair();
      const lost = await this.lostCommits(source, destination, manifest, r.unproven, 'transfer', this.cancel$.signal);
      if (!refused.length && !lost.length) return r.roots;
      this.save({ choices: await this.decide('transfer', [...refused, ...lost]) });
      this.phase('transfer');
    }
  }

  /** Each carried root, written only where and as its claim says; each session's files into the stage prepare places them from. */
  private entries(manifest: FrozenManifest, claims: RootClaim[], destination: Side): (RootEntry | SessionEntry)[] {
    const roots = replicaRoots(manifest).map((r): RootEntry => {
      const root = manifest.roots.find((x) => x.id === r.id)!;
      const c = claims.find((x) => x.id === r.id)!;
      return {
        kind: 'root', id: r.id, rootKind: root.kind, entry: root.entry, path: root.path,
        claim: { excludes: c.excludes, check: c.check, ...(c.keep?.length && { keep: c.keep }) }, files: root.files,
      };
    });
    const stage = (i: number) => resolvePaths(destination.fleetHome).sessionStage(manifest.transactionId, i);
    const sessions = manifest.sessions.flatMap((s, i): SessionEntry[] => (s.sourceHome ? [{ kind: 'session', id: `s${i}`, sourceHome: s.sourceHome, stage: stage(i), files: s.files }] : []));
    return [...roots, ...sessions];
  }

  private prepareParams(manifest: FrozenManifest, landed: LandedRoot[]): Params<'handover.prepare'> {
    const { transactionId, generation } = this.tx;
    return { transactionId, generation: generation + 1, manifest, manifestDigest: this.journal.manifestDigest!, landed };
  }

  /** Prepare: the destination proves what landed, imports Git, places the sessions and writes the state it would run. */
  private async prepare(destination: Side, manifest: FrozenManifest, landed: LandedRoot[]): Promise<string> {
    this.phase('prepare');
    const r = await this.retrying('prepare', () => this.cancellable(() => destination.daemon.call('handover.prepare', this.prepareParams(manifest, landed))), this.cancel$.signal);
    this.save({ preparedDigest: r.preparedDigest });
    return r.preparedDigest;
  }

  /** Ready: the gateway records that the source is frozen and the destination has prepared this state. */
  private async ready(preparedDigest: string): Promise<void> {
    const { transactionId, generation } = this.tx;
    this.phase('ready');
    let record: OwnerRecord;
    try {
      record = await this.retrying('ready', () => this.cancellable(() => this.d.gateway.ready({ transactionId, expectedGeneration: generation, preparedDigest })), this.cancel$.signal);
    } catch (e) {
      // an earlier attempt that got as far as the commit
      if (e instanceof Refused && e.code === 'handover_committed') return;
      throw e instanceof Refused ? new Stopped('ready', `the gateway would not record ${transactionId} ready: ${e.message}`, PRE_COMMIT) : e;
    }
    const tx = record.transaction;
    if (record.generation !== generation || tx?.id !== transactionId || tx.phase !== 'ready-to-commit' || tx.preparedDigest !== preparedDigest) {
      throw new Stopped('ready', `the gateway answered Ready with ${describe(record)} on prepared state ${tx?.preparedDigest ?? 'none'}, not ${preparedDigest}`, PRE_COMMIT);
    }
  }

  /**
   * Commit: the gateway moves the fleet to the destination at g + 1. An answer that never comes is a question
   * for the gateway's record, never a reason to give the source its fleet back; after a cancel it is not asked again.
   */
  private async commit(): Promise<void> {
    const { transactionId, generation } = this.tx;
    const to = this.journal.destination.machineId;
    const committed = (r: OwnerRecord) => r.generation === generation + 1 && r.ownerMachineId === to && r.transaction?.id === transactionId && r.transaction.phase === 'committed';
    if (this.cancel$.signal.aborted) throw new Cancelled();
    this.phase('commit');
    const { attempts } = this.d.retry ?? RETRY;
    for (let n = 1; ; n++) {
      let asked: unknown;
      try {
        const record = await boundary('controller.commit', () => this.d.gateway.commit({ transactionId, expectedGeneration: generation }));
        if (!committed(record)) throw new Stopped('commit', `the gateway answered the commit with ${describe(record)}; ask it again before anything else`, []);
        break;
      } catch (e) {
        if (e instanceof Stopped) throw e;
        asked = e;
      }
      const record = await this.retrying('commit', () => this.d.gateway.get()).catch(() => undefined);
      if (!record) throw new Stopped('commit', `whether ${transactionId} committed is unknown (${messageOf(asked)}); resume asks the gateway again`, []);
      if (committed(record)) break;
      const tx = record.transaction;
      if (this.cancel$.signal.aborted && record.generation === generation) {
        throw new Stopped('commit', `cancelled while the commit of ${transactionId} went unanswered, and the gateway holds ${describe(record)}; abort, or resume to commit`, PRE_COMMIT);
      }
      if (asked instanceof Refused || tx?.id !== transactionId || tx.phase !== 'ready-to-commit' || n >= attempts) {
        throw new Stopped('commit', `the gateway did not commit ${transactionId} and holds ${describe(record)}: ${messageOf(asked)}`, record.generation === generation ? PRE_COMMIT : []);
      }
    }
    this.committed = true;
    if (this.cancel$.signal.aborted) this.detach();
  }

  /** Activate: the destination confirms the commit, runs the prepared state and starts the terminals the handover rested. */
  private async activate(): Promise<CharacterResult[]> {
    const { transactionId, generation } = this.tx;
    const destination = await this.side(this.journal.destination.machineId);
    this.phase('activate');
    const r = await this.retrying('activate', () => destination.daemon.call('handover.activate', { transactionId, generation: generation + 1 }));
    for (const c of r.characters) {
      this.observer.send({ event: 'handover.entity', data: { transactionId, kind: 'character', id: c.id, phase: 'activate', ...(c.error && { error: c.error }), ...(c.notice && { notice: c.notice }) } });
    }
    return r.characters;
  }

  /**
   * Complete, once the destination runs the fleet: it seals and closes its journal, then the source does, and the
   * gateway clears the transaction. A source that cannot be reached is finished by a later resume; its own journal
   * fences it meanwhile.
   */
  private async complete(characters: CharacterResult[]): Promise<Outcome> {
    const { transactionId, generation } = this.tx;
    try {
      const destination = await this.side(this.journal.destination.machineId);
      this.phase('complete');
      await this.retrying('complete', () => destination.daemon.call('handover.complete', { transactionId, generation: generation + 1 }));
      const pending: ('source' | 'gateway')[] = [];
      const said: string[] = [];
      const landed = this.journal.landedDigest ? this.d.store.landed(transactionId, this.journal.landedDigest) : undefined;
      try {
        const source = await this.side(this.journal.source.machineId);
        await this.retrying('complete', () => source.daemon.call('handover.complete', { transactionId, generation, ...(landed && { landed }) }));
      } catch (e) {
        pending.push('source');
        said.push(`${this.journal.source.name}: ${messageOf(e)}`);
      }
      try {
        const record = await this.retrying('complete', () => this.d.gateway.complete({ transactionId, generation: generation + 1 }));
        this.d.moved?.(record);
      } catch (e) {
        // the gateway holds another handover since, or has moved the fleet on past this one: this one is done there
        const past = e instanceof Refused && (e.code === 'transaction_mismatch' || (e.code === 'generation_mismatch' && Number(e.data?.actual) > generation + 1));
        if (!past) {
          pending.push('gateway');
          said.push(`the gateway: ${messageOf(e)}`);
        }
      }
      const done: Outcome = { status: 'complete', transactionId, generation: generation + 1, characters };
      // the journal stays open, so a resume finishes what is pending
      if (pending.length) return { ...done, pending, error: this.scrub(said.join('; ')) };
      this.d.store.clear(transactionId);
      return done;
    } catch (e) {
      return this.stopped(e);
    }
  }

  /** A pre-commit abort: the gateway first, whose answer decides everything else, then each side lets go. */
  private async undo(done: Outcome): Promise<Outcome> {
    const { transactionId, generation } = this.journal;
    if (transactionId) {
      try {
        await this.retrying('aborted', () => this.d.gateway.abort({ transactionId, expectedGeneration: generation }));
      } catch (e) {
        if (!(e instanceof Refused)) throw e;
        if (e.code === 'handover_committed') throw new Moved();
        if (e.code === 'generation_mismatch') {
          const record = await this.retrying('aborted', () => this.d.gateway.get());
          if (record.generation > generation && record.ownerMachineId !== this.journal.source.machineId) throw new Moved();
          throw new Stopped('aborted', `the gateway holds ${describe(record)}, so ${transactionId} cannot be aborted from here`, []);
        }
        // the gateway holds another handover or none: this one can no longer commit
        if (e.code !== 'transaction_mismatch') throw new Stopped('aborted', `the gateway would not abort ${transactionId}: ${e.message}`, ['abort']);
      }
    }
    return this.letGo(done);
  }

  /** After the gateway let go: the source takes its fleet back and reopens what it rested, and the destination drops what it prepared. */
  private async letGo(done: Outcome): Promise<Outcome> {
    const { transactionId, generation, phase } = this.journal;
    if (!transactionId) {
      this.d.store.clear();
      return done;
    }
    this.save({ phase: 'aborted' });
    this.observer.send({ event: 'handover.changed', data: { transactionId, phase: 'aborted' } });
    // a Freeze never sent froze nothing, and the destination has nothing of it
    if (phase !== 'begin') {
      const source = await this.side(this.journal.source.machineId);
      await this.retrying('aborted', () => source.daemon.call('handover.abort', { transactionId, generation }));
      // a destination that cannot be reached leaves the journal open, for the abort that lets it go later
      try {
        const destination = await this.side(this.journal.destination.machineId);
        await this.retrying('aborted', () => destination.daemon.call('handover.abort', { transactionId, generation: generation + 1 }));
      } catch (e) {
        // a destination with no journal of this handover has nothing to let go, and says so as not its fleet
        if (!(e instanceof Refused && e.code === 'not_owner')) throw e;
      }
    }
    this.d.store.clear(transactionId);
    return done;
  }

  /** How a step that could not go on ends: aborted before the commit when that was the user's word or a blocker, else stopped where it is. */
  private async stopped(e: unknown): Promise<Outcome> {
    const j = this.j;
    const tx = j?.transactionId;
    const phase = j?.phase ?? 'begin';
    if (!this.committed && (e instanceof Cancelled || e instanceof Blocked) && j) {
      const done: Outcome = e instanceof Blocked ? { status: 'blocked', transactionId: tx, phase: e.phase, blockers: e.blockers } : { status: 'aborted', transactionId: tx, phase };
      try {
        return await this.undo(done);
      } catch (abortErr) {
        if (abortErr instanceof Moved) return this.forward(true);
        return this.interrupted(phase, `${e.message}; the abort did not finish: ${messageOf(abortErr)}`, abortErr instanceof Stopped ? abortErr.safe : ['abort']);
      }
    }
    const safe = e instanceof Stopped ? e.safe : this.committed ? ['resume' as const] : phase === 'commit' ? [] : PRE_COMMIT;
    return this.interrupted(e instanceof Stopped ? e.phase : phase, messageOf(e), this.committed ? safe.filter((s) => s === 'resume') : safe);
  }

  private interrupted(phase: HandoverPhase, said: string, safe: SafeAction[]): Outcome {
    return { status: 'interrupted', ...(this.j?.transactionId && { transactionId: this.j.transactionId }), phase, error: this.scrub(said), safe };
  }

  private failed(e: unknown): Outcome {
    return {
      status: 'interrupted', ...(this.j?.transactionId && { transactionId: this.j.transactionId }), phase: this.j?.phase ?? 'begin',
      error: this.scrub(messageOf(e)), safe: this.committed ? ['resume'] : [],
    };
  }

  private scrub(text: string): string {
    return redact(text, this.d.secrets?.() ?? []);
  }

  private stuck(v: Verdict): Outcome {
    return { status: 'interrupted', ...(v.transactionId && { transactionId: v.transactionId }), phase: v.phase ?? 'begin', error: v.reason, safe: v.safe };
  }

  /** Blockers go to the user, whose new choices try the step again; without an answer, or with Cancel, the handover aborts. */
  private async decide(phase: HandoverPhase, blockers: Blocker[]): Promise<HandoverChoices> {
    const found = settle(blockers);
    this.observer.send({ event: 'handover.blocked', data: { ...(this.j?.transactionId && { transactionId: this.j.transactionId }), phase, blockers: found, ...(this.j && { choices: this.j.choices }) } });
    const answer = this.d.decide ? await this.cancellable(() => this.d.decide!(found, phase)) : 'cancel';
    if (answer === 'cancel') throw new Blocked(phase, found);
    // the answer is the whole of the choices: one the user turned off is gone
    return answer;
  }

  /**
   * The commits of worktrees that stay on the destination which it could not prove the copy coming back holds, asked of
   * the source, whose refs are the ones that copy brings: each one they do not reach is a blocker. `stop` is a cancel.
   */
  private async lostCommits(
    source: Side, destination: Side, m: TransferManifestV1, unproven: readonly KeptCommit[] | undefined, phase: HandoverPhase, stop?: AbortSignal,
  ): Promise<Blocker[]> {
    if (!unproven?.length) return [];
    const commonDir = new Map((m.git ?? []).map((g) => [g.id, g.commonDir]));
    const asked = unproven.flatMap((u) => { const dir = commonDir.get(u.graph); return dir ? [{ commonDir: dir, commit: u.commit }] : []; });
    let unreached: { commonDir: string; commit: string }[];
    let why = '';
    try {
      const ask = () => source.daemon.call('handover.reaches', { commits: asked });
      ({ unreached } = asked.length ? await this.retrying(phase, () => (stop ? this.cancellable(ask) : ask()), stop) : { unreached: [] });
    } catch (e) {
      if (!(e instanceof Refused)) throw e;
      unreached = asked;
      why = ` (${source.route.name} could not say: ${e.message})`;
    }
    const lost = (u: KeptCommit) => !commonDir.has(u.graph) || unreached.some((x) => x.commonDir === commonDir.get(u.graph) && x.commit === u.commit);
    return unproven.filter(lost).map((u) => ({
      code: 'worktree_unused', entity: { kind: 'git', id: u.graph },
      message: `${u.path} is a worktree no character uses that stays on ${destination.route.name}, at ${u.commit.slice(0, 12)}, which nothing ${source.route.name} sends back reaches${why}, so the copy that comes back would not hold that commit; put it on a branch on ${source.route.name}, or remove this worktree on ${destination.route.name}`,
    }));
  }

  /** Whether rsync runs at both ends of the link a transfer takes; the master under it has to open without asking anything. */
  private async linkChecks(source: Side, destination: Side): Promise<Blocker[]> {
    const out: Blocker[] = [];
    await this.d.rsync().catch((e: unknown) => { out.push({ code: 'rsync_unsupported', message: `this machine has no rsync a handover can drive: ${messageOf(e)}` }); });
    const far = source.master ? source : destination.master ? destination : undefined;
    if (!far) return out;
    const r = await farRsync(await far.master!());
    if (r && 'blocker' in r) out.push({ ...r.blocker, message: `${far.route.name}: ${r.blocker.message}` });
    else if (r) throw new Error(`${far.route.name}: ${r.failure.error}`);
    return out;
  }

  /** The destination's own read of the roots it would receive, of the folders they land in, and of where carried links lead there. */
  private async destinationChecks(source: Side, destination: Side, m: TransferManifestV1, choices: HandoverChoices): Promise<{ blockers: Blocker[]; warnings: Warning[] }> {
    const carried = replicaRoots(m);
    const folderOf = (p: string): string => landingFolder(p, m.home);
    const sessionFolders = m.sessions.map((s) => folderOf(s.destinationHome ?? m.home));
    const dirs = carried.filter((c) => c.entry === 'dir');
    const folders = [...new Set([...carried.map((c) => folderOf(c.path)), ...sessionFolders, ...dirs.map((c) => c.path)])];
    const where = destination.route.name;
    const links = carriedLinks(m);
    const ask = [...new Set(links.flatMap((l) => (l.carried === undefined ? [l.at] : [])))];
    const resuming = resumeFolders(m);
    let r: Result<'handover.inspect'>;
    try {
      const roots = carried.map((c) => ({ ...c, files: m.roots.find((x) => x.id === c.id)!.files }));
      const git = graphsHere(m);
      const resumes = resuming.map(({ kind, cwd, repo, root, bypass }) => ({ kind, cwd, ...(repo && { repo }), ...(root && { root }), ...(bypass && { bypass }) }));
      r = await this.retrying('begin', () => destination.daemon.call('handover.inspect', {
        roots, excludes: m.excludes, folders, ...(ask.length && { links: ask }), ...(git.length && { git }), ...(resumes.length && { resumes }),
      }));
    } catch (e) {
      if (!(e instanceof Refused)) throw e;
      return { blockers: [{ code: 'identity_mismatch', message: `${where} will not read the roots it would receive: ${e.message}` }], warnings: [] };
    }
    // a root the user chose to archive is set aside at claim, and arrives as a first copy
    const archived = new Set(r.roots.filter((x) => !x.check.ok && ARCHIVABLE.has(x.check.blocker.code)
      && choices.archiveRoots?.some((n) => n === x.id || n === x.check.path || n === carried.find((c) => c.id === x.id)?.path)).map((x) => x.id));
    const blockers: Blocker[] = [
      ...r.roots.flatMap((x) => (x.check.ok || archived.has(x.id) ? [] : [x.check.blocker])),
      ...await this.lostCommits(source, destination, m, r.unproven, 'begin'),
    ];
    const notices: Warning[] = r.roots.flatMap((x) => (!x.check.ok && archived.has(x.id)
      ? [{ ...x.check.blocker, message: `${x.check.path} is archived when the handover claims it: ${x.check.blocker.message}` }] : []));
    // a root lands at the path it has here, so what holds it outside the home has to be there already
    for (const root of carried) {
      const folder = folderOf(root.path);
      if (r.folders[folder]?.exists) continue;
      blockers.push({
        code: 'parent_missing', entity: { kind: 'root', id: root.id },
        message: folder === m.home ? `${where} has no ${folder}, the home ${root.path} lands in`
          : `${where} has no ${folder}, which ${root.path} lands in; a folder outside the home arrives at the same path there, so make ${folder} on ${where} first`,
      });
    }
    const absent = new Set(r.roots.filter((x) => (x.check.ok && x.check.kind === 'absent') || archived.has(x.id)).map((x) => x.id));
    // rsync writes a folder already there from inside it, and a file or a new folder from the folder above it
    const written = new Set([
      ...carried.filter((c) => c.entry === 'file' || absent.has(c.id)).map((c) => folderOf(c.path)), ...sessionFolders,
      ...dirs.filter((c) => !absent.has(c.id)).map((c) => c.path),
    ]);
    for (const folder of written) {
      if (r.folders[folder]?.exists && !r.folders[folder].writable) blockers.push({ code: 'path_unsupported', message: `${folder} on ${where} cannot be written` });
    }
    // a first copy needs every byte; a root already holding a replica needs only what changed
    for (const [folder, bytes] of Object.entries(spaceNeed({ ...m, roots: m.roots.filter((x) => absent.has(x.id)) }))) {
      const probe = r.folders[folder];
      if (probe?.exists && probe.freeBytes < bytes) {
        blockers.push({ code: 'destination_no_space', message: `${where} has ${probe.freeBytes} bytes free under ${folder}, and the handover needs ${bytes}` });
      }
    }
    const folding = (p: string): boolean => (r.folders[p]?.exists ? r.folders[p] : r.folders[folderOf(p)])?.caseInsensitive ?? false;
    for (const root of m.roots.filter((x) => !x.foldedInto && folding(x.path))) {
      const clash = caseCollisions(root.files.map((f) => f.path));
      if (clash.length) {
        const shown = clash.slice(0, 3).map((g) => g.join(' and ')).join('; ');
        blockers.push({
          code: 'path_collision', entity: { kind: 'root', id: root.id },
          message: `${root.path} would hold names that differ only by case or Unicode normalization, which ${where} does not tell apart: ${shown}${clash.length > 3 ? `; and ${clash.length - 3} more` : ''}`,
        });
      }
    }
    const asks = (f: ResumeFolder) => (r.untrusted ?? []).some((u) => u.kind === f.kind && u.cwd === f.cwd);
    const warns = (f: ResumeFolder) => !!f.bypass && (r.bypassWarned ?? []).some((u) => u.kind === f.kind && u.cwd === f.cwd);
    return {
      blockers,
      warnings: [
        ...notices, ...danglingLinks(links, new Set(r.missing ?? []), where), ...trustWarnings(m, resuming.filter(asks), where), ...bypassWarnings(m, resuming.filter(warns), where),
      ],
    };
  }

  /** The four journals: this controller's, the gateway's record, and what each daemon holds. `aside` moves a journal that cannot be read out of the way. */
  private async observe(aside = false): Promise<Observation> {
    const controller = this.d.store.read(aside);
    const gateway = await this.seen(() => this.retrying('begin', () => this.d.gateway.get()));
    const tx = gateway.ok ? gateway.value.transaction : undefined;
    const from = controller?.source.machineId ?? tx?.fromMachineId;
    const to = controller?.destination.machineId ?? tx?.toMachineId;
    const status = (id: MachineId) => this.seen(async () => (await this.side(id, false)).daemon.call('handover.status', {}));
    const owned = (id: MachineId) => this.seen(async () => (await this.side(id, false)).daemon.call('ownership.get', {}));
    type Status = Seen<Result<'handover.status'>>;
    const source = async (id: MachineId, asked?: Status): Promise<Observation['source']> => {
      const [s, o] = await Promise.all([asked ?? status(id), owned(id)]);
      return s.ok && o.ok ? { ok: true, value: { status: s.value, ownership: o.value } } : { ok: false, error: s.ok ? (o as { error: string }).error : s.error };
    };
    const destination = async (id: MachineId, asked?: Status): Promise<Observation['destination']> => {
      const [s, o] = await Promise.all([asked ?? status(id), owned(id)]);
      return s.ok ? { ok: true, value: { status: s.value, ...(o.ok && { ownership: o.value }) } } : s;
    };
    if (from && to) {
      const [s, d] = await Promise.all([source(from), destination(to)]);
      return { controller, gateway, source: s, destination: d };
    }
    // no journal names the machines: a daemon that holds a handover says which side of it it is
    const held = await Promise.all(this.d.machines.map(async (id) => ({ id, s: await status(id) })));
    const on = (side: 'fromMachineId' | 'toMachineId') => held.find((x) => x.s.ok && x.s.value.transaction?.[side] === x.id);
    const [f, t] = [on('fromMachineId'), on('toMachineId')];
    const [s, d] = await Promise.all([f && source(f.id, f.s), t && destination(t.id, t.s)]);
    return { controller, gateway, ...(s && { source: s }), ...(d && { destination: d }) };
  }

  /** The journal a resume or abort acts on: the controller's own, or one rebuilt from the other three. */
  private async adopt(o: Observation, v: Verdict): Promise<void> {
    const now = this.clock.now();
    const [from, to] = o.controller ? [o.controller.source, o.controller.destination].map((r) => r.machineId) : [v.fromMachineId, v.toMachineId];
    if (from && to && from !== this.d.local && to !== this.d.local) {
      const name = (id: MachineId): string => { try { return this.d.route(id).name; } catch { return id; } };
      const [a, b] = [name(from), name(to)];
      throw new Stopped(v.phase ?? 'begin', `this machine is neither the source ${a} nor the destination ${b} of ${v.transactionId ?? 'this handover'}, so a transfer from here would copy onto its own disk; run it on ${a} or ${b}`, []);
    }
    if (o.controller) {
      this.j = o.controller;
      if (!this.j.transactionId && v.transactionId) this.save({ transactionId: v.transactionId });
      return;
    }
    if (!v.fromMachineId || !v.toMachineId || v.generation === undefined) throw new Stopped('begin', v.reason, []);
    const [source, destination] = [this.d.route(v.fromMachineId), this.d.route(v.toMachineId)];
    this.j = {
      version: 1, fleetId: this.d.fleetId, ...(v.transactionId && { transactionId: v.transactionId }), generation: v.generation,
      source, destination, choices: {}, phase: v.phase ?? 'begin', startedAt: now, updatedAt: now,
    };
    this.d.store.write(this.j);
  }

  private get journal(): ControllerJournal {
    if (!this.j) throw new Error('no handover journal is open');
    return this.j;
  }

  private get tx(): { transactionId: string; generation: number } {
    const { transactionId, generation } = this.journal;
    if (!transactionId) throw new Error('the handover has not begun');
    return { transactionId, generation };
  }

  private save(patch: Partial<ControllerJournal>): void {
    const next = { ...this.journal, ...patch, updatedAt: this.clock.now() };
    for (const k of Object.keys(patch) as (keyof ControllerJournal)[]) if (patch[k] === undefined) delete next[k];
    this.d.store.write(next);
    this.j = next;
  }

  private phase(phase: HandoverPhase): void {
    if (this.journal.phase !== phase) this.save({ phase });
    this.observer.send({ event: 'handover.changed', data: { transactionId: this.tx.transactionId, phase } });
  }

  private pair(): Promise<[Side, Side]> {
    return Promise.all([this.side(this.journal.source.machineId), this.side(this.journal.destination.machineId)]);
  }

  /** One machine as the controller reaches it, asked for again as a daemon call would be unless only looked at (`retry` false). */
  private side(id: MachineId, retry = true): Promise<Side> {
    let held = this.sides.get(id);
    if (!held) {
      held = retry ? this.retrying(this.j?.phase ?? 'begin', () => this.d.side(id)) : this.d.side(id);
      this.sides.set(id, held);
      held.catch(() => this.sides.delete(id));
    }
    return held;
  }

  private async seen<T>(read: () => Promise<T>): Promise<Seen<T>> {
    try { return { ok: true, value: await read() }; } catch (e) { return { ok: false, error: messageOf(e) }; }
  }

  /** Asks again after a call whose answer never came, backing off; `stop` ends the wait and asks no more. */
  private async retrying<T>(phase: HandoverPhase, call: () => Promise<T>, stop?: AbortSignal): Promise<T> {
    const { attempts, firstDelayMs } = this.d.retry ?? RETRY;
    let delay = firstDelayMs;
    for (let n = 1; ; n++) {
      try {
        return await call();
      } catch (e) {
        if (!transient(e) || n >= attempts) throw e;
        this.observer.send({ event: 'handover.retry', data: { ...(this.j?.transactionId && { transactionId: this.j.transactionId }), phase, attempt: n, error: this.scrub(messageOf(e)) } });
        await this.pause(delay, stop);
        if (stop?.aborted) throw new Cancelled();
        delay = Math.min(delay * 2, MAX_DELAY);
      }
    }
  }

  private pause(ms: number, stop?: AbortSignal): Promise<void> {
    if (!stop) return this.clock.sleep(ms);
    if (stop.aborted) return Promise.resolve();
    return new Promise((resolve) => {
      const done = (): void => { stop.removeEventListener('abort', done); resolve(); };
      stop.addEventListener('abort', done, { once: true });
      void this.clock.sleep(ms).then(done);
    });
  }

  /** Sends a call only while no cancel has been asked, and unless told to wait for its answer, stops waiting once one is. */
  private cancellable<T>(send: () => Promise<T>, race = true): Promise<T> {
    const signal = this.cancel$.signal;
    if (signal.aborted) return Promise.reject(new Cancelled());
    const p = send();
    if (!race) return p;
    return new Promise((resolve, reject) => {
      const stop = () => { p.catch(() => undefined); reject(new Cancelled()); };
      signal.addEventListener('abort', stop, { once: true });
      p.then((v) => { signal.removeEventListener('abort', stop); resolve(v); }, (e: unknown) => { signal.removeEventListener('abort', stop); reject(e); });
    });
  }

  // a freeze still waiting when the user chooses again is left to its source, which answers the new one instead; its attempt ends, so it is never sent again
  private orChosen<T>(send: (attempt: AbortSignal) => Promise<T>): Promise<T | 'chosen'> {
    const attempt = new AbortController();
    return new Promise((resolve, reject) => {
      const p = send(attempt.signal);
      const wake = (): void => { clear(); attempt.abort(); p.catch(() => undefined); resolve('chosen'); };
      const clear = (): void => { if (this.wakeChosen === wake) this.wakeChosen = undefined; };
      this.wakeChosen = wake;
      p.then((v) => { clear(); resolve(v); }, (e: unknown) => { clear(); reject(e); });
    });
  }

  private take(): HandoverChoices | undefined {
    const c = this.chosen;
    this.chosen = undefined;
    return c;
  }
}
