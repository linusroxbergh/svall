import fs from 'node:fs';
import type { Duplex } from 'node:stream';
import { z } from 'zod';
import { ApiError, MachineId, PROTOCOL_VERSION, STATE_SCHEMA_VERSION, methods, type LinkFrame, type MachineLink, type MethodName, type Result } from '@svall/protocol';
import { boundary } from '../failpoints.js';
import type { Logger } from '../log.js';
import type { MachineEntry } from '../machine.js';
import type { Paths } from '../paths.js';
import type { HomeDocs } from '../placement/docs-sync.js';
import type { Mirror } from '../placement/mirror.js';
import type { Staged } from '../placement/replay.js';
import { tokenFor } from '../placement/workers.js';
import { PRIVATE } from '../profile.js';
import { svallExe } from '../release.js';
import type { Store } from '../store.js';
import { shq } from '../text.js';
import { Inventory, RobotSync, Snapshot } from '../worker/snapshot.js';
import { SshMaster } from './ssh.js';
import { answerCall, LinkStream, MAX_LINE } from './stream.js';

/** How often the home pings a worker; a ping still unanswered at the next beat closes the link. */
export const HEARTBEAT_MS = 15_000;
const FIRST_RETRY_MS = 1_000;
const LAST_RETRY_MS = 60_000;
const PUSH_AFTER_MS = 250;
// how often a worker in mismatch is greeted again
const REHELLO_MS = 5 * 60_000;
// how long each worker has to answer what the home asks them all
const ASK_MS = 5_000;

export type Via = { ssh: string; controlSocket: string };
export type Transport = (entry: MachineEntry) => Promise<{ stream: Duplex; via: Via }>;

/** What a worker says of itself once it has taken the home's token; one that names no schema or protocol reads as another build. */
const WorkerHello = z.object({
  t: z.literal('hello'), workerMachineId: MachineId, bootId: z.string(), release: z.string(), schema: z.number().optional(), protocol: z.number().optional(),
  agentHomes: Snapshot.shape.agentHomes, home: z.string(),
});
export type WorkerHello = z.infer<typeof WorkerHello>;

/** What `onEvent` throws for a kind of event it does not take, which the link skips. */
export class UnknownEvent extends Error {}

type Options = {
  paths: Paths;
  store: Store;
  machines: () => MachineEntry[];
  connect: Transport;
  log: Logger;
  release: string;
  onReport(r: RobotSync, machine: MachineId): void;
  /** Any event but a report: it reads the disk before the event's hold, the `change` it answers writes the store inside it
   *  and never throws, and `after` runs once the write is tried. */
  onEvent(kind: string, data: unknown, machine: MachineId): Promise<Staged | void>;
  onInventory(inv: Inventory, machine: MachineId): Promise<void>;
  /** A call the worker sends on to the home, as a CLI in one of its panes makes it. */
  onCall?(method: string, params: unknown): Promise<unknown>;
  /** A notification from a linked worker, never journaled nor acked. */
  onNotify?(kind: string, data: unknown, machine: MachineId): void;
  /** A worker's inventory and the outbox past it are taken, and snapshots go to it. */
  onSynced?(machine: MachineId): void;
  /** A worker's stream closed. */
  onLost?(machine: MachineId): void;
  snapshot: () => Snapshot;
  /** The home's agent configuration, which a worker takes once linked and before a move. */
  mirror?: Pick<Mirror, 'push'>;
  /** The fleet's docs, which a worker takes once linked and after they change. */
  docs?: Pick<HomeDocs, 'push' | 'watch'>;
};

/** The far `svall worker link` over this machine's ssh master to the worker. */
export function sshTransport(o: { profile: string; log: Logger }): Transport {
  return async ({ record }) => {
    if (!record.ssh) throw new Error(`${record.name} has no ssh destination in the registry`);
    const master = await SshMaster.open({ destination: record.ssh });
    const { stream, exited } = master.stream([shq(svallExe(record.svallBase)), 'worker', 'link', ...(o.profile === PRIVATE ? [] : ['-p', shq(o.profile)])]);
    void exited.then(async (r) => {
      if (r.code !== 0 && r.stderr.trim()) o.log.error(`${record.name}: svall worker link exited ${r.code ?? r.signal}: ${r.stderr.trim().slice(0, 400)}`);
      await master.close().catch((e: Error) => o.log.error(`${record.name}: the ssh master did not close: ${e.message}`));
    });
    return { stream, via: { ssh: record.ssh, controlSocket: master.socket } };
  };
}

/** One worker as the home holds it: a stream that reconnects with backoff, and how far the home has taken its outbox. */
export class WorkerLink {
  readonly machine: MachineId;
  // the inventory is taken and every snapshot goes to it
  synced = false;
  private readonly name: string;
  private stream?: LinkStream;
  private route?: Via;
  private peer?: WorkerHello;
  // the hello of a worker on a state schema or link protocol this home cannot read, greeted again until it matches
  private odd?: WorkerHello;
  private rehello?: NodeJS.Timeout;
  private token?: string;
  private inventory?: Inventory;
  private acked = 0;
  private last = 0;
  private applying: Promise<void> = Promise.resolve();
  private waiting: { version: number; done(): void }[] = [];
  // the newest snapshot the worker has taken, and who waits for one
  private taken = 0;
  private takers: { version: number; done(): void }[] = [];
  private answered = true;
  // who waits in `linked`
  private linkers: ((linked: boolean) => void)[] = [];
  private heartbeat?: NodeJS.Timeout;
  private retry?: NodeJS.Timeout;
  private retryMs = FIRST_RETRY_MS;
  private lastWhy?: string;
  private stopped = false;
  // a docs push runs, and another is due after it
  private sendingDocs = false;
  private docsAgain = false;

  constructor(private entry: MachineEntry, private o: Options, private pushSoon: () => void) {
    this.machine = entry.id;
    this.name = entry.record.name;
  }

  connected(): boolean {
    return this.peer !== undefined;
  }

  hello(): WorkerHello | undefined {
    return this.peer;
  }

  mismatch(): WorkerHello | undefined {
    return this.odd;
  }

  /** Resolves true once the worker is synced; false after `timeoutMs`, once the link stops or the worker greets in mismatch. */
  linked(timeoutMs: number): Promise<boolean> {
    if (this.synced) return Promise.resolve(true);
    if (this.stopped || this.odd || timeoutMs <= 0) return Promise.resolve(false);
    return new Promise((resolve) => {
      const timer = setTimeout(() => settle(false), timeoutMs);
      const settle = (linked: boolean) => {
        clearTimeout(timer);
        this.linkers = this.linkers.filter((l) => l !== settle);
        resolve(linked);
      };
      this.linkers.push(settle);
    });
  }

  /** Greets a worker in mismatch again on its stream, as after its upgrade. */
  greetAgain(): void {
    if (this.odd && this.stream) this.greet(this.stream);
  }

  via(): Via {
    if (!this.peer || !this.route) throw this.unreachable();
    return this.route;
  }

  outboxDrained(): boolean {
    return this.synced && this.last === this.acked;
  }

  start(): void {
    void this.attempt();
  }

  stop(): void {
    this.stopped = true;
    clearTimeout(this.retry);
    clearTimeout(this.rehello);
    this.stream?.close();
    this.settleLinked(false);
  }

  call<T>(method: string, params: unknown, o?: { timeoutMs?: number; signal?: AbortSignal }): Promise<T> {
    if (!this.stream || !this.peer) return Promise.reject(this.unreachable());
    return this.stream.call<T>(method, params, o).catch((e: unknown) => {
      throw e instanceof ApiError && e.code === 'not_reachable' ? this.unreachable() : e;
    });
  }

  /** Streams `file`, or the bytes given, as blob `id`, which the worker has said it takes. */
  sendBlob(id: string, file: string | Buffer): Promise<void> {
    if (!this.stream || !this.peer) return Promise.reject(this.unreachable());
    const sent = Buffer.isBuffer(file) ? this.stream.sendBlob(id, file, file.length) : this.stream.sendBlob(id, fs.createReadStream(file), fs.statSync(file).size);
    return sent.catch((e: unknown) => {
      throw e instanceof ApiError && e.code === 'not_reachable' ? this.unreachable() : e;
    });
  }

  /** Writes blob `id` to `into` as the worker sends it; to be asked before the worker is told to send. */
  receiveBlob(id: string, into: string): Promise<{ sha256: string }> {
    if (!this.stream || !this.peer) return Promise.reject(this.unreachable());
    return this.stream.receiveBlob(id, into);
  }

  /** Sends `snap` to a synced worker; settles once the worker has taken it or the link is gone. */
  push(snap: Snapshot): Promise<void> {
    if (!this.synced || !this.stream) return Promise.resolve();
    this.stream.send({ t: 'snapshot', version: snap.version, data: snap });
    return new Promise((done) => this.waiting.push({ version: snap.version, done }));
  }

  /** Sends the home's agent configuration; a failure is logged, the mirror being a convenience. */
  pushMirror(): Promise<void> {
    if (!this.o.mirror || !this.connected()) return Promise.resolve();
    return this.o.mirror.push(this).then(() => {}, (e: Error) => this.o.log.error(`${this.name}: the agent configuration was not mirrored: ${e.message}`));
  }

  /** Sends the fleet's docs to a synced worker, and once more after if they change meanwhile. */
  pushDocs(): void {
    const { docs } = this.o;
    if (!docs || !this.synced) return;
    if (this.sendingDocs) { this.docsAgain = true; return; }
    this.sendingDocs = true;
    void docs.push(this, this.acked).catch((e: Error) => this.o.log.error(`${this.name}: the docs were not sent: ${e.message}`)).finally(() => {
      this.sendingDocs = false;
      if (this.docsAgain) { this.docsAgain = false; this.pushDocs(); }
    });
  }

  /** Resolves once the worker has taken a snapshot of `version` or later, over this stream or one after it. */
  took(version: number): Promise<void> {
    if (this.taken >= version) return Promise.resolve();
    return new Promise((done) => this.takers.push({ version, done }));
  }

  private settleLinked(linked: boolean): void {
    for (const settle of [...this.linkers]) settle(linked);
  }

  // what a hook throws is logged, and the link goes on
  private hook(failed: string, run: () => void): void {
    try { run(); } catch (e) { this.o.log.error(`${this.name}: ${failed}: ${(e as Error).message}`); }
  }

  private unreachable(): ApiError {
    return new ApiError('not_reachable', `${this.name} is not reachable`);
  }

  private async attempt(): Promise<void> {
    this.retry = undefined;
    let token: string | undefined;
    let conn: Awaited<ReturnType<Transport>>;
    try {
      // read at each try: issuing a new token replaces the one the worker accepts
      token = tokenFor(this.o.paths, this.machine);
      if (!token) return this.lost(`no token for ${this.name} in ${this.o.paths.workersFile}`, false);
      conn = await this.o.connect(this.entry);
    } catch (e) {
      return this.lost((e as Error).message);
    }
    const stream: LinkStream = new LinkStream(conn.stream, {
      onFrame: (f) => { if (stream === this.stream) this.take(stream, f); },
      onClose: (err) => { if (stream === this.stream) this.closed(err); },
    });
    if (this.stopped) return stream.close();
    this.stream = stream;
    this.route = conn.via;
    this.token = token;
    this.answered = true;
    this.heartbeat = setInterval(() => {
      if (!this.answered) {
        this.o.log.error(`${this.name}: a ping went unanswered for ${HEARTBEAT_MS / 1000} s, closing the link`);
        stream.close();
        return;
      }
      this.answered = false;
      stream.send({ t: 'ping' });
    }, HEARTBEAT_MS);
    this.greet(stream);
  }

  private greet(stream: LinkStream): void {
    stream.send({ t: 'hello', token: this.token, release: this.o.release, schema: STATE_SCHEMA_VERSION, protocol: PROTOCOL_VERSION });
  }

  private take(stream: LinkStream, f: LinkFrame): void {
    if (f.t === 'hello') return this.greeted(stream, f);
    if (this.odd) {
      if (f.t === 'pong') this.answered = true;
      return;
    }
    if (!this.peer) {
      this.o.log.error(`${this.name}: ${f.t} before hello, closing the link`);
      stream.close();
      return;
    }
    switch (f.t) {
      case 'inventory':
      case 'event':
        this.applying = this.applying.then(() => this.apply(stream, f));
        return;
      case 'snapshot.ack':
        for (const w of this.waiting.filter((w) => w.version <= f.version)) w.done();
        this.waiting = this.waiting.filter((w) => w.version > f.version);
        this.taken = Math.max(this.taken, f.version);
        for (const w of this.takers.filter((w) => w.version <= this.taken)) w.done();
        this.takers = this.takers.filter((w) => w.version > this.taken);
        // a link that got this far is a good one; a failure before it keeps the backoff growing
        this.retryMs = FIRST_RETRY_MS;
        this.lastWhy = undefined;
        return;
      case 'pong':
        this.answered = true;
        return;
      case 'call':
        void answerCall(stream, f, this.o.onCall && ((params) => this.o.onCall!(f.method, params)));
        return;
      case 'notify':
        this.hook(`a ${f.kind} notification not taken`, () => this.o.onNotify?.(f.kind, f.data, this.machine));
        return;
      default:
        this.o.log.error(`${this.name}: ${f.t} from a worker is not taken`);
    }
  }

  private greeted(stream: LinkStream, f: LinkFrame): void {
    const hello = WorkerHello.safeParse(f);
    if (!hello.success || hello.data.workerMachineId !== this.machine) {
      this.o.log.error(`${this.name}: ${hello.success ? `answers as machine ${hello.data.workerMachineId}, not ${this.machine}` : 'answered with a hello svalld cannot read'}, closing the link`);
      stream.close();
      return;
    }
    const h = hello.data;
    clearTimeout(this.rehello);
    // the stream and the ssh master under it stay up, with every terminal on that master
    if (h.schema !== STATE_SCHEMA_VERSION || h.protocol !== PROTOCOL_VERSION) {
      if (!this.odd) {
        this.o.log.error(`${this.name}: runs release ${h.release} on state schema ${h.schema ?? '?'} and link protocol ${h.protocol ?? '?'}, where this svalld reads ${STATE_SCHEMA_VERSION} and ${PROTOCOL_VERSION}; nothing passes until it is upgraded`);
        this.mark({ name: this.name, reachable: false, since: Date.now(), release: h.release, mismatch: true });
      }
      this.odd = h;
      this.rehello = setTimeout(() => this.greetAgain(), REHELLO_MS);
      this.settleLinked(false);
      return;
    }
    this.odd = undefined;
    this.peer = h;
    this.mark({ name: this.name, reachable: true, since: Date.now(), release: h.release, home: h.home, mismatch: undefined });
    this.o.log.info(`${this.name}: linked, release ${h.release}`);
  }

  // the inventory, then the outbox the worker replays from the home's ack, each event applied once and on disk, with the
  // epoch and seq it was applied at, before its ack
  private async apply(stream: LinkStream, f: Extract<LinkFrame, { t: 'inventory' | 'event' }>): Promise<void> {
    if (stream !== this.stream) return;
    try {
      if (f.t === 'inventory') {
        const inv = Inventory.parse(f);
        const replayed = this.o.store.state.machines?.[this.machine]?.replayed;
        this.inventory = inv;
        // past the worker's acked seq lie the events the home took whose ack was lost, none past the worker's last; a new
        // epoch is a journal begun afresh
        this.acked = replayed && replayed.epoch === inv.epoch ? Math.min(Math.max(inv.acked, replayed.seq), inv.last) : inv.acked;
        this.last = inv.last;
        // the events past the worker's acked seq reach the disk before they are acked
        if (this.acked > inv.acked && !(await this.o.store.flush())) throw new Error('state.json was not written');
        stream.send({ t: 'ack', seq: this.acked });
      } else {
        const { inventory } = this;
        if (!inventory) throw new Error('an event came before the inventory');
        this.last = Math.max(this.last, f.seq);
        if (f.seq > this.acked) {
          const staged = f.kind === 'robot.sync' ? undefined : await this.o.onEvent(f.kind, f.data, this.machine).catch((e: unknown) => {
            if (!(e instanceof UnknownEvent)) throw e;
            this.o.log.error(`${this.name}: event ${f.seq} (${f.kind}) is not one this svalld takes; skipped`);
          });
          await this.o.store.withheld(async () => {
            if (f.kind === 'robot.sync') this.o.onReport(RobotSync.parse(f.data), this.machine);
            else if (staged) staged.change();
            this.mark({ name: this.name, replayed: { epoch: inventory.epoch, seq: f.seq } });
          });
          const written = await boundary('home.event.applied', () => this.o.store.flush());
          if (staged) staged.after?.();
          if (!written) throw new Error('state.json was not written');
          // gone meanwhile: the worker replays the event on its next stream
          if (stream !== this.stream) return;
          this.acked = f.seq;
          // what the home made of a docs change, a refused delete included, reaches the worker in docs packed past this seq
          if (staged && staged.docs) this.pushDocs();
        }
        stream.send({ t: 'ack', seq: this.acked });
      }
      if (!this.synced && this.inventory && this.acked >= this.inventory.last) {
        await this.o.onInventory(this.inventory, this.machine);
        if (stream !== this.stream) return;
        this.synced = true;
        this.settleLinked(true);
        this.hook('onSynced failed', () => this.o.onSynced?.(this.machine));
        this.pushSoon();
        void this.pushMirror();
        this.pushDocs();
      }
    } catch (e) {
      this.o.log.error(`${this.name}: ${f.t === 'event' ? `event ${f.seq} (${f.kind})` : 'the inventory'} not taken, closing the link: ${(e as Error).message}`);
      stream.close();
    }
  }

  private closed(err?: Error): void {
    clearInterval(this.heartbeat);
    clearTimeout(this.rehello);
    this.stream = this.route = this.peer = this.odd = this.inventory = undefined;
    this.synced = false;
    for (const w of this.waiting.splice(0)) w.done();
    this.lost(err?.message ?? 'the link closed');
    this.hook('onLost failed', () => this.o.onLost?.(this.machine));
  }

  private lost(why: string, again = true): void {
    if (this.stopped) return;
    const held = this.o.store.state.machines?.[this.machine];
    if (held?.reachable !== false || held.mismatch) this.mark({ name: this.name, reachable: false, since: Date.now(), mismatch: undefined });
    if (!again) return;
    if (why !== this.lastWhy) this.o.log.error(`${this.name} is not reachable: ${why}; trying again`);
    this.lastWhy = why;
    this.retry = setTimeout(() => void this.attempt(), this.retryMs);
    this.retryMs = Math.min(this.retryMs * 2, LAST_RETRY_MS);
  }

  // over what the entry holds; a key the patch sets to undefined goes
  private mark(patch: Partial<MachineLink> & Pick<MachineLink, 'name'>): void {
    this.o.store.update((d) => {
      const next: Record<string, unknown> = { ...d.machines?.[this.machine], ...patch };
      for (const [k, v] of Object.entries(next)) if (v === undefined) delete next[k];
      (d.machines ??= {})[this.machine] = next as MachineLink;
    });
  }
}

/** The home's links: one per machine in the registry that holds a token of this fleet's. */
export class HomeLinks {
  private links = new Map<MachineId, WorkerLink>();
  private queued?: { promise: Promise<number>; fire(): void };
  private unsubscribe?: () => void;
  private unwatchDocs?: () => void;
  private oversize = false;
  // set while the links run
  private pushSoon?: () => void;

  constructor(private o: Options) {}

  start(): void {
    // send() says once itself that a snapshot is over the limit
    const pushSoon = () => {
      this.pushSnapshot().catch((e: Error) => { if (!(e instanceof ApiError && e.code === 'too_large')) this.o.log.error(`snapshot not pushed: ${e.message}`); });
    };
    this.pushSoon = pushSoon;
    this.refresh();
    // every change while a worker is synced reaches it
    this.unsubscribe = this.o.store.subscribe(() => { if ([...this.links.values()].some((l) => l.synced)) pushSoon(); });
    // and every change to the docs, but to the worker whose note it was
    this.unwatchDocs = this.o.docs?.watch((except) => { for (const l of this.links.values()) if (l.machine !== except) l.pushDocs(); });
  }

  /** Links each machine in the registry that holds a token of this fleet's and is not linked yet, and greets each in mismatch again. */
  refresh(): void {
    const pushSoon = this.pushSoon;
    if (!pushSoon) return;
    for (const link of this.links.values()) link.greetAgain();
    try {
      for (const entry of this.o.machines()) {
        if (this.links.has(entry.id) || !tokenFor(this.o.paths, entry.id)) continue;
        const link = new WorkerLink(entry, this.o, pushSoon);
        this.links.set(entry.id, link);
        link.start();
      }
    } catch (e) {
      this.o.log.error(`a worker is not linked: ${(e as Error).message}`);
    }
  }

  stop(): void {
    this.pushSoon = undefined;
    this.unsubscribe?.();
    this.unwatchDocs?.();
    for (const link of this.links.values()) link.stop();
    this.queued?.fire();
  }

  for(machine: MachineId): WorkerLink | undefined {
    return this.links.get(machine);
  }

  /** The workers a call reaches now. */
  connectedWorkers(): MachineId[] {
    return [...this.links.values()].filter((l) => l.connected()).map((l) => l.machine);
  }

  /** Sends `machine` the home's agent configuration, as before a move; resolves whether or not it went. */
  pushMirror(machine: MachineId): Promise<void> {
    return this.links.get(machine)?.pushMirror() ?? Promise.resolve();
  }

  call<T>(machine: MachineId, method: string, params: unknown, o?: { timeoutMs?: number; signal?: AbortSignal }): Promise<T> {
    const link = this.links.get(machine);
    if (link) return link.call<T>(method, params, o);
    let name: string = machine;
    try { name = this.o.machines().find((m) => m.id === machine)?.record.name ?? machine; } catch { /* the id names it */ }
    return Promise.reject(new ApiError('not_reachable', `${name} is not reachable`));
  }

  /** One snapshot for every call within 250 ms, to every synced worker; resolves with its version once each has taken it,
   *  and rejects too_large for one over the link's line limit. */
  pushSnapshot(): Promise<number> {
    if (this.queued) return this.queued.promise;
    let fire!: () => void;
    const promise = new Promise<number>((resolve, reject) => {
      const timer = setTimeout(() => fire(), PUSH_AFTER_MS);
      fire = () => {
        clearTimeout(timer);
        this.queued = undefined;
        this.send().then(resolve, reject);
      };
    });
    this.queued = { promise, fire };
    return promise;
  }

  private async send(): Promise<number> {
    const snap = this.o.snapshot();
    // a line over the limit would close every link it went out on
    const bytes = Buffer.byteLength(JSON.stringify({ t: 'snapshot', version: snap.version, data: snap }));
    if (bytes > MAX_LINE) {
      const why = `the fleet's snapshot is ${bytes} bytes, over the link's limit of ${MAX_LINE}`;
      if (!this.oversize) this.o.log.error(`${why}; no worker gets it`);
      this.oversize = true;
      throw new ApiError('too_large', why);
    }
    this.oversize = false;
    await Promise.all([...this.links.values()].map((l) => l.push(snap)));
    return snap.version;
  }
}

/** What every connected worker answers `method` with, each asked at once with no params; one that fails, takes
 *  longer than ASK_MS or answers what the method's result is not is left out. */
export async function askWorkers<M extends MethodName>(links: Pick<HomeLinks, 'call' | 'connectedWorkers'>, method: M): Promise<{ machine: MachineId; answer: Result<M> }[]> {
  const result: z.ZodType = methods[method].result;
  const answers = await Promise.all(links.connectedWorkers().map((machine) =>
    links.call<unknown>(machine, method, {}, { timeoutMs: ASK_MS }).then((raw) => {
      const answer = result.safeParse(raw);
      return answer.success ? { machine, answer: answer.data as Result<M> } : undefined;
    }, () => undefined)));
  return answers.filter((a) => a !== undefined);
}
