import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import { z } from 'zod';
import { ApiError, type LinkFrame, type MachineId, type WorkerFile } from '@svall/protocol';
import { codexPaths } from '../codex/install.js';
import type { Logger } from '../log.js';
import { opencodePaths } from '../opencode/install.js';
import { claudePaths, type Paths } from '../paths.js';
import type { Store } from '../store.js';
import type { Outbox } from '../worker/outbox.js';
import { mergeSnapshot, ownedReport, Snapshot, type Inventory, type RobotSync } from '../worker/snapshot.js';
import { LinkStream } from './stream.js';

const HomeHello = z.object({ t: z.literal('hello'), token: z.string() });

type Handlers = Record<string, (params: unknown) => Promise<unknown>>;

// `live` once the home has said where to replay from and the outbox past it is sent
type Link = { stream: LinkStream; live: boolean };

const sameToken = (a: string, b: string): boolean => {
  const [x, y] = [Buffer.from(a), Buffer.from(b)];
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};

/** The worker's end of the link: listens on link.sock and holds the one stream that opened with worker.json's token. */
export class HomeConnection {
  private server?: net.Server;
  private streams = new Set<LinkStream>();
  private link?: Link;

  constructor(private o: {
    paths: Paths; worker: WorkerFile; me: MachineId; store: Store; outbox: Outbox; log: Logger; release: string; bootId: string; handlers: Handlers;
  }) {}

  async start(): Promise<void> {
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

  call<T>(method: string, params: unknown): Promise<T> {
    if (!this.link?.live) return Promise.reject(this.unreachable());
    return this.link.stream.call<T>(method, params).catch((e: unknown) => {
      throw e instanceof ApiError && e.code === 'not_reachable' ? this.unreachable() : e;
    });
  }

  report(r: RobotSync): void {
    const seq = this.o.outbox.append('robot.sync', r);
    if (this.link?.live) this.link.stream.send({ t: 'event', seq, kind: 'robot.sync', data: r });
  }

  private unreachable(): ApiError {
    return new ApiError('not_reachable', `${this.o.worker.homeName} is not reachable`);
  }

  private accept(socket: net.Socket): void {
    const stream: LinkStream = new LinkStream(socket, {
      onFrame: (f) => { if (this.link?.stream === stream) this.take(this.link, f); else this.greet(stream, f); },
      onClose: () => {
        this.streams.delete(stream);
        if (this.link?.stream === stream) this.link = undefined;
      },
    });
    this.streams.add(stream);
  }

  // a stream's first frame is the home's hello; one that opens with it replaces the stream before
  private greet(stream: LinkStream, f: LinkFrame): void {
    const hello = HomeHello.safeParse(f);
    if (!hello.success || !sameToken(hello.data.token, this.o.worker.token)) {
      this.o.log.error(`link: closed a stream that did not open with ${this.o.worker.homeName}'s token`);
      stream.close();
      return;
    }
    const older = this.link;
    this.link = { stream, live: false };
    older?.stream.close();
    stream.send({
      t: 'hello', workerMachineId: this.o.me, bootId: this.o.bootId, release: this.o.release, home: os.homedir(),
      agentHomes: { claude: claudePaths().dir, codex: codexPaths().dir, opencode: opencodePaths().dir },
    });
    const inventory: Inventory = {
      robots: Object.values(this.o.store.state.robots).filter((r) => r.machine === this.o.me).map(ownedReport),
      last: this.o.outbox.last(),
      acked: this.o.outbox.acked(),
    };
    stream.send({ t: 'inventory', ...inventory });
  }

  private take(link: Link, f: LinkFrame): void {
    const { stream } = link;
    switch (f.t) {
      case 'ack':
        this.o.outbox.ack(f.seq);
        // the first ack says where the home's copy ends, and the outbox past it goes out in sequence
        if (!link.live) {
          for (const e of this.o.outbox.after(f.seq)) stream.send({ t: 'event', seq: e.seq, kind: e.kind, data: e.data });
          link.live = true;
        }
        return;
      case 'snapshot':
        try {
          mergeSnapshot(this.o.store, Snapshot.parse(f.data), this.o.me);
          this.o.store.flush();
        } catch (e) {
          this.o.log.error(`link: snapshot ${f.version} not taken, closing: ${(e as Error).message}`);
          stream.close();
          return;
        }
        stream.send({ t: 'snapshot.ack', version: f.version });
        return;
      case 'ping':
        stream.send({ t: 'pong', release: this.o.release, bootId: this.o.bootId });
        return;
      case 'call':
        void this.answer(stream, f);
        return;
      default:
        this.o.log.error(`link: ${f.t} from the home is not taken`);
    }
  }

  private async answer(stream: LinkStream, f: Extract<LinkFrame, { t: 'call' }>): Promise<void> {
    const handler = Object.hasOwn(this.o.handlers, f.method) ? this.o.handlers[f.method] : undefined;
    try {
      if (!handler) throw new ApiError('unknown_method', `unknown method ${f.method}`);
      stream.send({ t: 'reply', id: f.id, result: await handler(f.params) });
    } catch (e) {
      const error = e instanceof ApiError
        ? { code: e.code, message: e.message, ...(e.data && { data: e.data }) }
        : { code: 'internal', message: (e as Error).message };
      stream.send({ t: 'reply', id: f.id, error });
    }
  }
}
