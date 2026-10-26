import crypto from 'node:crypto';
import fs from 'node:fs';
import type { Duplex, Readable } from 'node:stream';
import { ApiError, LinkFrame } from '@svall/protocol';
import { errorFrame } from '../errors.js';

export const MAX_LINE = 2 * 1024 * 1024;
export const BLOB_PART = 1024 * 1024;
const CALL_TIMEOUT = 30_000;

type Pending = { resolve(v: any): void; reject(e: Error): void; done(): void };
type Receiver = { out: fs.WriteStream; hash: crypto.Hash; next: number; count: number; resolve(v: { sha256: string }): void; reject(e: Error): void };

const gone = (err?: Error) => new ApiError('not_reachable', err ? `the link closed: ${err.message}` : 'the link is closed');

/** JSON lines over a duplex: calls matched to replies by id, and blobs sent in base64 parts. Other frames go to onFrame. */
export class LinkStream {
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private receivers = new Map<string, Receiver>();
  private closed = false;
  private readonly maxLine: number;

  constructor(private duplex: Duplex, private o: { onFrame(f: LinkFrame): void; onClose(err?: Error): void; maxLine?: number }) {
    this.maxLine = o.maxLine ?? MAX_LINE;
    duplex.on('error', (e) => this.finish(e));
    duplex.on('close', () => this.finish());
    void this.read();
  }

  send(f: LinkFrame): void {
    this.write(f);
  }

  call<T>(method: string, params: unknown, o: { timeoutMs?: number; signal?: AbortSignal } = {}): Promise<T> {
    if (this.closed) return Promise.reject(gone());
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => settle(() => reject(new ApiError('timeout', `${method} got no reply in ${o.timeoutMs ?? CALL_TIMEOUT} ms`))), o.timeoutMs ?? CALL_TIMEOUT);
      const onAbort = () => settle(() => reject(new ApiError('aborted', `${method} was aborted`)));
      const done = () => {
        clearTimeout(timer);
        o.signal?.removeEventListener('abort', onAbort);
        this.pending.delete(id);
      };
      const settle = (fn: () => void) => { done(); fn(); };
      if (o.signal?.aborted) return onAbort();
      o.signal?.addEventListener('abort', onAbort);
      this.pending.set(id, { resolve: (v) => settle(() => resolve(v)), reject: (e) => settle(() => reject(e)), done });
      this.write({ t: 'call', id, method, params });
    });
  }

  async sendBlob(id: string, data: Readable | Buffer, bytes: number): Promise<void> {
    const count = Math.max(1, Math.ceil(bytes / BLOB_PART));
    let index = 0;
    const part = async (chunk: Buffer) => {
      if (this.closed) throw gone();
      if (!this.write({ t: 'blob', id, index: index++, count, data: chunk.toString('base64') })) await this.drain();
    };
    if (Buffer.isBuffer(data)) {
      for (let at = 0; at < data.length || index === 0; at += BLOB_PART) await part(data.subarray(at, at + BLOB_PART));
      return;
    }
    let held = Buffer.alloc(0);
    for await (const piece of data) {
      held = Buffer.concat([held, piece as Buffer]);
      while (held.length >= BLOB_PART) {
        await part(held.subarray(0, BLOB_PART));
        held = held.subarray(BLOB_PART);
      }
    }
    if (held.length > 0 || index === 0) await part(held);
  }

  /** Writes the parts that arrive for `id` to `into` and resolves with the sha256 of the whole once the last one lands. */
  receiveBlob(id: string, into: string): Promise<{ sha256: string }> {
    if (this.closed) return Promise.reject(gone());
    if (this.receivers.has(id)) return Promise.reject(new Error(`blob ${id} is already being received`));
    return new Promise((resolve, reject) => {
      const out = fs.createWriteStream(into);
      out.on('error', (e) => { this.finish(e); this.duplex.destroy(); });
      this.receivers.set(id, { out, hash: crypto.createHash('sha256'), next: 0, count: 0, resolve, reject });
    });
  }

  close(): void {
    this.finish();
    this.duplex.destroy();
  }

  private write(f: LinkFrame): boolean {
    if (this.closed) return false;
    return this.duplex.write(`${JSON.stringify(f)}\n`);
  }

  private drain(): Promise<void> {
    return new Promise((resolve, reject) => {
      const done = () => { this.duplex.off('drain', done); this.duplex.off('close', done); this.closed ? reject(gone()) : resolve(); };
      this.duplex.once('drain', done);
      this.duplex.once('close', done);
    });
  }

  private async read(): Promise<void> {
    let buf: Buffer = Buffer.alloc(0);
    try {
      for await (const chunk of this.duplex) {
        buf = buf.length === 0 ? (chunk as Buffer) : Buffer.concat([buf, chunk as Buffer]);
        for (let nl = buf.indexOf(10); nl >= 0; nl = buf.indexOf(10)) {
          this.tooLong(nl);
          await this.handle(buf.subarray(0, nl).toString('utf8'));
          buf = buf.subarray(nl + 1);
        }
        this.tooLong(buf.length);
      }
      this.finish();
    } catch (e) {
      this.finish(e as Error);
      this.duplex.destroy();
    }
  }

  private tooLong(size: number): void {
    if (size > this.maxLine) throw new Error(`a line of at least ${size} bytes is over the limit of ${this.maxLine}`);
  }

  private async handle(line: string): Promise<void> {
    if (this.closed || line === '') return;
    const f = LinkFrame.parse(JSON.parse(line));
    if (f.t === 'reply') {
      const p = this.pending.get(f.id);
      if (!p) return;
      if (f.error) p.reject(new ApiError(f.error.code, f.error.message, f.error.data));
      else p.resolve(f.result);
    } else if (f.t === 'blob' && this.receivers.has(f.id)) {
      await this.takePart(f);
    } else {
      this.o.onFrame(f);
    }
  }

  private async takePart(f: Extract<LinkFrame, { t: 'blob' }>): Promise<void> {
    const r = this.receivers.get(f.id)!;
    if (f.index !== r.next) throw new Error(`blob ${f.id} part ${f.index} arrived where part ${r.next} was due`);
    if (r.next > 0 && f.count !== r.count) throw new Error(`blob ${f.id} changed its part count from ${r.count} to ${f.count}`);
    r.count = f.count;
    r.next++;
    const raw = Buffer.from(f.data, 'base64');
    r.hash.update(raw);
    if (!r.out.write(raw)) await new Promise<void>((resolve) => { r.out.once('drain', () => resolve()); r.out.once('close', () => resolve()); });
    if (this.closed) return;
    if (r.next < f.count) return;
    r.out.end((e?: Error | null) => {
      if (e || this.closed) return;
      this.receivers.delete(f.id);
      r.resolve({ sha256: r.hash.digest('hex') });
    });
  }

  private finish(err?: Error): void {
    if (this.closed) return;
    this.closed = true;
    const why = gone(err);
    for (const p of [...this.pending.values()]) p.reject(why);
    for (const r of this.receivers.values()) { r.out.destroy(); r.reject(why); }
    this.receivers.clear();
    this.o.onClose(err);
  }
}

/** Replies to a call with what `run` answers, or with the error it throws; a method nothing runs is unknown. */
export async function answerCall(stream: LinkStream, f: Extract<LinkFrame, { t: 'call' }>, run?: (params: unknown) => Promise<unknown>): Promise<void> {
  try {
    if (!run) throw new ApiError('unknown_method', `unknown method ${f.method}`);
    stream.send({ t: 'reply', id: f.id, result: await run(f.params) });
  } catch (e) {
    stream.send({ t: 'reply', id: f.id, error: errorFrame(e) });
  }
}
