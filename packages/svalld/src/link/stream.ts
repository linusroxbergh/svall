import crypto from 'node:crypto';
import fs from 'node:fs';
import type { Duplex, Readable } from 'node:stream';
import { ApiError, LinkFrame } from '@svall/protocol';

export const MAX_LINE = 2 * 1024 * 1024;
export const BLOB_PART = 1024 * 1024;
const CALL_TIMEOUT = 30_000;

type Pending = { resolve(v: any): void; reject(e: Error): void; done(): void };
type Receiver = { out: fs.WriteStream; hash: crypto.Hash; next: number; resolve(v: { sha256: string }): void; reject(e: Error): void };

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
    if (this.closed) return Promise.reject(new ApiError('not_reachable', 'the link is closed'));
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
    if (this.closed) return Promise.reject(new ApiError('not_reachable', 'the link is closed'));
    return new Promise((resolve, reject) => {
      this.receivers.set(id, { out: fs.createWriteStream(into), hash: crypto.createHash('sha256'), next: 0, resolve, reject });
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
    return new Promise((resolve) => {
      const done = () => { this.duplex.off('drain', done); this.duplex.off('close', done); resolve(); };
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
    r.next++;
    const raw = Buffer.from(f.data, 'base64');
    r.hash.update(raw);
    if (!r.out.write(raw)) await new Promise<void>((resolve) => r.out.once('drain', () => resolve()));
    if (r.next < f.count) return;
    this.receivers.delete(f.id);
    r.out.end(() => r.resolve({ sha256: r.hash.digest('hex') }));
  }

  private finish(err?: Error): void {
    if (this.closed) return;
    this.closed = true;
    const gone = new ApiError('not_reachable', err ? `the link closed: ${err.message}` : 'the link closed');
    for (const p of [...this.pending.values()]) p.reject(gone);
    for (const r of this.receivers.values()) { r.out.destroy(); r.reject(gone); }
    this.receivers.clear();
    this.o.onClose(err);
  }
}
