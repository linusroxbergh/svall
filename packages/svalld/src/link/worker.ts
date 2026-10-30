import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import { z } from 'zod';
import { ApiError, Mutation, PROTOCOL_VERSION, STATE_SCHEMA_VERSION, type LinkFrame, type MachineId, type WorkerFile } from '@svall/protocol';
import { codexPaths } from '../codex/install.js';
import type { Logger } from '../log.js';
import { opencodePaths } from '../opencode/install.js';
import { claudePaths, type Paths } from '../paths.js';
import type { Store } from '../store.js';
import type { Entry, Outbox } from '../worker/outbox.js';
import { mergeSnapshot, ownedReport, Snapshot, type Inventory, type RobotSync } from '../worker/snapshot.js';
import { HEARTBEAT_MS } from './home.js';
import { answerCall, LinkStream, PART_REPLY } from './stream.js';

// three beats with nothing from the home is a home gone without closing its stream, as a Mac asleep on a half-open connection
export const SILENT_MS = 3 * HEARTBEAT_MS;

const HomeHello = z.object({ t: z.literal('hello'), token: z.string(), schema: z.number().optional(), protocol: z.number().optional() });

type Handlers = Record<string, (params: unknown) => Promise<unknown>>;
type Held = { at: Record<string, unknown>; key: string; text: string };

// `live` once the home has said where to replay from and the outbox past it is sent; `mismatch` while the home speaks a
// state schema or link protocol this worker cannot read, when nothing but pings passes
type Link = { stream: LinkStream; live: boolean; mismatch: boolean };

const sameToken = (a: string, b: string): boolean => {
  const [x, y] = [Buffer.from(a), Buffer.from(b)];
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};

// the longest string inside `v`, with the object or array that holds it and its key there
function longest(v: unknown, best?: Held): Held | undefined {
  if (v === null || typeof v !== 'object') return best;
  for (const [key, x] of Object.entries(v)) {
    if (typeof x !== 'string') best = longest(x, best);
    else if (!best || x.length > best.text.length) best = { at: v as Record<string, unknown>, key, text: x };
  }
  return best;
}

/** The worker's end of the link: listens on link.sock and holds the one stream that opened with worker.json's token. */
export class HomeConnection {
  private server?: net.Server;
  private streams = new Set<LinkStream>();
  private link?: Link;
  // the kinds whose last notification did not fit, logged once until one of the kind fits again
  private cutting = new Set<string>();

  constructor(private o: {
    paths: Paths; worker: WorkerFile; me: MachineId; store: Store; outbox: Outbox; log: Logger; release: string; bootId: string; handlers: Handlers;
    /** The state schema and link protocol this worker speaks, this build's unless named. */
    versions?: { schema: number; protocol: number };
    /** The outbox entries the home has acknowledged, before they are trimmed. */
    onAcked?(dropped: Entry[]): void;
    /** As `connected()` turns: true at the home's first ack on a stream, false as that stream closes or is greeted again. */
    onLink?(live: boolean): void;
  }) {}

  async start(): Promise<void> {
    this.away();
    // the home lock keeps every other daemon off this home, so a socket left here is a dead one's
    fs.rmSync(this.o.paths.linkSock, { force: true });
    const server = net.createServer((socket) => this.accept(socket));
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(this.o.paths.linkSock, () => { server.off('error', reject); resolve(); });
    });
    fs.chmodSync(this.o.paths.linkSock, 0o600);
    server.on('error', (e) => this.o.log.error(`link.sock: ${e.message}`));
    this.server = server;
  }

  async stop(): Promise<void> {
    const server = this.server;
    this.server = undefined;
    for (const s of this.streams) s.close();
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
    fs.rmSync(this.o.paths.linkSock, { force: true });
  }

  connected(): boolean {
    return this.link?.live ?? false;
  }

  /** The version of the home's snapshot this worker last took, 0 before its first. */
  snapshotVersion(): number {
    return this.o.store.state.machines?.[this.o.worker.homeMachineId]?.snapshot?.version ?? 0;
  }

  call<T>(method: string, params: unknown, o?: { timeoutMs?: number; signal?: AbortSignal }): Promise<T> {
    const link = this.link;
    if (!link?.live) return Promise.reject(this.unreachable());
    // a not_reachable the home answers is its own, about another machine
    return link.stream.call<T>(method, params, o).catch((e: unknown) => {
      throw e instanceof ApiError && e.code === 'not_reachable' && this.link !== link ? this.unreachable() : e;
    });
  }

  /** Streams `file` as blob `id`, which the home has said it takes. */
  sendBlob(id: string, file: string): Promise<void> {
    const link = this.link;
    if (!link?.live) return Promise.reject(this.unreachable());
    return link.stream.sendBlob(id, fs.createReadStream(file), fs.statSync(file).size);
  }

  /** Writes blob `id` to `into` as the home sends it; to be asked before the home is told to send. */
  receiveBlob(id: string, into: string): Promise<{ sha256: string }> {
    const link = this.link;
    if (!link?.live) return Promise.reject(this.unreachable());
    return link.stream.receiveBlob(id, into);
  }

  // a report holds every field the worker owns of its robot, so the newest stands for those before it
  report(r: RobotSync): void {
    this.journal('robot.sync', r, r.robotId);
  }

  /** Sends the home a notification, never journaled: dropped while the home is not linked, and one whose frame is over
   *  PART_REPLY goes with its longest string cut from the front until it fits, so a text keeps its tail. */
  notify(kind: string, data: unknown): void {
    const link = this.link;
    if (!link?.live) return;
    const json = JSON.stringify({ t: 'notify', kind, data });
    const bytes = Buffer.byteLength(json);
    if (bytes <= PART_REPLY) {
      this.cutting.delete(kind);
      return link.stream.send({ t: 'notify', kind, data });
    }
    const box = { data: (JSON.parse(json) as { data: unknown }).data };
    let size = bytes;
    for (let s = longest(box); size > PART_REPLY && s?.text; s = longest(box)) {
      s.at[s.key] = s.text.slice(size - PART_REPLY);
      size = Buffer.byteLength(JSON.stringify({ t: 'notify', kind, data: box.data }));
    }
    const first = !this.cutting.has(kind);
    this.cutting.add(kind);
    const later = 'the next are not logged until one fits';
    if (size > PART_REPLY) {
      if (first) this.o.log.error(`link: a ${kind} notification of ${bytes} bytes does not fit in ${PART_REPLY} and was dropped; ${later}`);
      return;
    }
    if (first) this.o.log.error(`link: a ${kind} notification of ${bytes} bytes was cut from the front to fit in ${PART_REPLY}; ${later}`);
    link.stream.send({ t: 'notify', kind, data: box.data });
  }

  /** The bytes sent to the home that its stream has not passed on yet, 0 while it is not linked. */
  backlog(): number {
    return this.link?.live ? this.link.stream.backlog() : 0;
  }

  /** Puts an event in the outbox and sends it while the home is linked; returns its seq. */
  journal(kind: string, data: unknown, key?: string): number {
    const seq = this.o.outbox.append(kind, data, key);
    if (this.link?.live) this.link.stream.send({ t: 'event', seq, kind, data });
    return seq;
  }

  private unreachable(): ApiError {
    return new ApiError('not_reachable', `${this.o.worker.homeName} is not reachable`);
  }

  // the home's entry, which a snapshot marks reachable, unreachable until the next one
  private away(): void {
    const homeId = this.o.worker.homeMachineId;
    const held = this.o.store.state.machines?.[homeId];
    if (held?.reachable) this.o.store.update((d) => { d.machines![homeId] = { ...held, reachable: false, since: Date.now() }; });
  }

  private accept(socket: net.Socket): void {
    const stream: LinkStream = new LinkStream(socket, {
      idleMs: SILENT_MS,
      onFrame: (f) => { if (this.link?.stream === stream) this.take(this.link, f); else this.greet(stream, f); },
      onClose: (err) => {
        this.streams.delete(stream);
        const link = this.link;
        if (link?.stream !== stream) return;
        if (err) this.o.log.error(`link: ${this.o.worker.homeName}'s stream closed: ${err.message}`);
        this.link = undefined;
        this.away();
        if (link.live) this.o.onLink?.(false);
      },
    });
    this.streams.add(stream);
  }

  // a stream's first frame is the home's hello; one that opens with it replaces the stream before, and the home may greet
  // again on its stream, as after it was upgraded
  private greet(stream: LinkStream, f: LinkFrame): void {
    const hello = HomeHello.safeParse(f);
    if (!hello.success || !sameToken(hello.data.token, this.o.worker.token)) {
      this.o.log.error(`link: closed a stream that did not open with ${this.o.worker.homeName}'s token`);
      stream.close();
      return;
    }
    const { schema, protocol } = this.o.versions ?? { schema: STATE_SCHEMA_VERSION, protocol: PROTOCOL_VERSION };
    const mismatch = hello.data.schema !== schema || hello.data.protocol !== protocol;
    const older = this.link;
    this.link = { stream, live: false, mismatch };
    if (older?.live) this.o.onLink?.(false);
    if (older && older.stream !== stream) older.stream.close();
    stream.send({
      t: 'hello', workerMachineId: this.o.me, bootId: this.o.bootId, release: this.o.release, schema, protocol, home: os.homedir(),
      agentHomes: { claude: claudePaths().dir, codex: codexPaths().dir, opencode: opencodePaths().dir },
    });
    if (mismatch) {
      this.o.log.error(`link: ${this.o.worker.homeName} speaks state schema ${hello.data.schema ?? '?'} and link protocol ${hello.data.protocol ?? '?'}, where this svalld speaks ${schema} and ${protocol}; nothing passes until they match`);
      return;
    }
    const inventory: Inventory = {
      robots: Object.values(this.o.store.state.robots).filter((r) => r.machine === this.o.me).map(ownedReport),
      last: this.o.outbox.last(),
      acked: this.o.outbox.acked(),
      epoch: this.o.outbox.epoch(),
    };
    stream.send({ t: 'inventory', ...inventory });
  }

  private take(link: Link, f: LinkFrame): void {
    const { stream } = link;
    if (f.t === 'hello') return this.greet(stream, f);
    if (link.mismatch) {
      if (f.t === 'ping') stream.send({ t: 'pong', release: this.o.release, bootId: this.o.bootId });
      return;
    }
    switch (f.t) {
      case 'ack':
        this.o.outbox.ack(f.seq, (dropped) => this.o.onAcked?.(dropped));
        // the first ack says where the home's copy ends, and the outbox past it goes out in sequence
        if (!link.live) {
          for (const e of this.o.outbox.after(f.seq)) stream.send({ t: 'event', seq: e.seq, kind: e.kind, data: e.data });
          link.live = true;
          this.o.onLink?.(true);
        }
        return;
      case 'snapshot':
        void this.takeSnapshot(stream, f);
        return;
      case 'ping':
        stream.send({ t: 'pong', release: this.o.release, bootId: this.o.bootId });
        return;
      case 'call':
        void answerCall(stream, f, Object.hasOwn(this.o.handlers, f.method) ? this.o.handlers[f.method] : undefined);
        return;
      default:
        this.o.log.error(`link: ${f.t} from the home is not taken`);
    }
  }

  private async takeSnapshot(stream: LinkStream, f: Extract<LinkFrame, { t: 'snapshot' }>): Promise<void> {
    try {
      const pending = this.o.outbox.after(this.o.outbox.acked()).flatMap((e) => {
        const m = e.kind === 'mutation' ? Mutation.safeParse(e.data) : undefined;
        return m?.success ? [m.data] : [];
      });
      mergeSnapshot(this.o.store, Snapshot.parse(f.data), this.o.me, { id: this.o.worker.homeMachineId, name: this.o.worker.homeName, reachable: true }, pending);
      if (!(await this.o.store.flush())) throw new Error('state.json was not written');
    } catch (e) {
      this.o.log.error(`link: snapshot ${f.version} not taken, closing: ${(e as Error).message}`);
      stream.close();
      return;
    }
    stream.send({ t: 'snapshot.ack', version: f.version });
  }
}
