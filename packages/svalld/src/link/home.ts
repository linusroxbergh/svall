import fs from 'node:fs';
import type { Duplex } from 'node:stream';
import { z } from 'zod';
import { ApiError, MachineId, type LinkFrame, type MachineLink } from '@svall/protocol';
import type { Logger } from '../log.js';
import type { MachineEntry } from '../machine.js';
import type { Paths } from '../paths.js';
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

export type Via = { ssh: string; controlSocket: string };
export type Transport = (entry: MachineEntry) => Promise<{ stream: Duplex; via: Via }>;

/** What a worker says of itself once it has taken the home's token. */
const WorkerHello = z.object({
  t: z.literal('hello'), workerMachineId: MachineId, bootId: z.string(), release: z.string(), agentHomes: Snapshot.shape.agentHomes, home: z.string(),
});
export type WorkerHello = z.infer<typeof WorkerHello>;

type Options = {
  paths: Paths;
  store: Store;
  machines: () => MachineEntry[];
  connect: Transport;
  log: Logger;
  release: string;
  onReport(r: RobotSync, machine: MachineId): void;
  onEvent(kind: string, data: unknown, machine: MachineId): Promise<void>;
  onInventory(inv: Inventory, machine: MachineId): Promise<void>;
  /** A call the worker sends on to the home, as a CLI in one of its panes makes it. */
  onCall?(method: string, params: unknown): Promise<unknown>;
  snapshot: () => Snapshot;
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
  private inventory?: Inventory;
  private acked = 0;
  private last = 0;
  private applying: Promise<void> = Promise.resolve();
  private waiting: { version: number; done(): void }[] = [];
  // the newest snapshot the worker has taken, and who waits for one
  private taken = 0;
  private takers: { version: number; done(): void }[] = [];
  private answered = true;
  private heartbeat?: NodeJS.Timeout;
  private retry?: NodeJS.Timeout;
  private retryMs = FIRST_RETRY_MS;
  private lastWhy?: string;
  private stopped = false;

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
    this.stream?.close();
  }

  call<T>(method: string, params: unknown, o?: { timeoutMs?: number; signal?: AbortSignal }): Promise<T> {
    if (!this.stream || !this.peer) return Promise.reject(this.unreachable());
    return this.stream.call<T>(method, params, o).catch((e: unknown) => {
      throw e instanceof ApiError && e.code === 'not_reachable' ? this.unreachable() : e;
    });
  }

  /** Streams `file` as blob `id`, which the worker has said it takes. */
  sendBlob(id: string, file: string): Promise<void> {
    if (!this.stream || !this.peer) return Promise.reject(this.unreachable());
    return this.stream.sendBlob(id, fs.createReadStream(file), fs.statSync(file).size).catch((e: unknown) => {
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

  /** Resolves once the worker has taken a snapshot of `version` or later, over this stream or one after it. */
  took(version: number): Promise<void> {
    if (this.taken >= version) return Promise.resolve();
    return new Promise((done) => this.takers.push({ version, done }));
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
    stream.send({ t: 'hello', token, release: this.o.release });
  }

  private take(stream: LinkStream, f: LinkFrame): void {
    if (f.t === 'hello') return this.greeted(stream, f);
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
    this.peer = hello.data;
    this.mark({ name: this.name, reachable: true, since: Date.now(), release: hello.data.release });
    this.o.log.info(`${this.name}: linked, release ${hello.data.release}`);
  }

  // the inventory, then the outbox the worker replays from the home's ack, each event applied and on disk before its ack
  private async apply(stream: LinkStream, f: Extract<LinkFrame, { t: 'inventory' | 'event' }>): Promise<void> {
    if (stream !== this.stream) return;
    try {
      if (f.t === 'inventory') {
        const inv = Inventory.parse(f);
        this.inventory = inv;
        this.acked = inv.acked;
        this.last = inv.last;
        stream.send({ t: 'ack', seq: inv.acked });
      } else {
        this.last = Math.max(this.last, f.seq);
        if (f.seq > this.acked) {
          if (f.kind === 'robot.sync') this.o.onReport(RobotSync.parse(f.data), this.machine);
          else await this.o.onEvent(f.kind, f.data, this.machine);
          if (!this.o.store.flush()) throw new Error('state.json was not written');
          // gone meanwhile: the worker replays the event on its next stream
          if (stream !== this.stream) return;
          this.acked = f.seq;
        }
        stream.send({ t: 'ack', seq: this.acked });
      }
      if (!this.synced && this.inventory && this.acked >= this.inventory.last) {
        await this.o.onInventory(this.inventory, this.machine);
        if (stream !== this.stream) return;
        this.synced = true;
        this.pushSoon();
      }
    } catch (e) {
      this.o.log.error(`${this.name}: ${f.t === 'event' ? `event ${f.seq} (${f.kind})` : 'the inventory'} not taken, closing the link: ${(e as Error).message}`);
      stream.close();
    }
  }

  private closed(err?: Error): void {
    clearInterval(this.heartbeat);
    this.stream = this.route = this.peer = this.inventory = undefined;
    this.synced = false;
    for (const w of this.waiting.splice(0)) w.done();
    this.lost(err?.message ?? 'the link closed');
  }

  private lost(why: string, again = true): void {
    if (this.stopped) return;
    const held = this.o.store.state.machines?.[this.machine];
    if (held?.reachable !== false) this.mark({ name: this.name, reachable: false, since: Date.now(), ...(held?.release !== undefined && { release: held.release }) });
    if (!again) return;
    if (why !== this.lastWhy) this.o.log.error(`${this.name} is not reachable: ${why}; trying again`);
    this.lastWhy = why;
    this.retry = setTimeout(() => void this.attempt(), this.retryMs);
    this.retryMs = Math.min(this.retryMs * 2, LAST_RETRY_MS);
  }

  private mark(link: MachineLink): void {
    this.o.store.update((d) => { (d.machines ??= {})[this.machine] = link; });
  }
}

/** The home's links: one per machine in the registry that holds a token of this fleet's. */
export class HomeLinks {
  private links = new Map<MachineId, WorkerLink>();
  private queued?: { promise: Promise<number>; fire(): void };
  private unsubscribe?: () => void;
  private oversize = false;

  constructor(private o: Options) {}

  start(): void {
    // send() says once itself that a snapshot is over the limit
    const pushSoon = () => {
      this.pushSnapshot().catch((e: Error) => { if (!(e instanceof ApiError && e.code === 'too_large')) this.o.log.error(`snapshot not pushed: ${e.message}`); });
    };
    try {
      for (const entry of this.o.machines()) {
        if (tokenFor(this.o.paths, entry.id)) this.links.set(entry.id, new WorkerLink(entry, this.o, pushSoon));
      }
    } catch (e) {
      this.o.log.error(`no worker is linked: ${(e as Error).message}`);
    }
    for (const link of this.links.values()) link.start();
    // every change while a worker is synced reaches it
    this.unsubscribe = this.o.store.subscribe(() => { if ([...this.links.values()].some((l) => l.synced)) pushSoon(); });
  }

  stop(): void {
    this.unsubscribe?.();
    for (const link of this.links.values()) link.stop();
    this.queued?.fire();
  }

  for(machine: MachineId): WorkerLink | undefined {
    return this.links.get(machine);
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
