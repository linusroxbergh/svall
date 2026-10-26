import crypto from 'node:crypto';
import fs from 'node:fs';
import type { Duplex, Readable } from 'node:stream';
import { z } from 'zod';
import { ApiError, LinkFrame } from '@svall/protocol';
import { errorFrame } from '../errors.js';

export const MAX_LINE = 2 * 1024 * 1024;
export const BLOB_PART = 1024 * 1024;
/** A result whose JSON is over PART_REPLY bytes is replied in link.part slices of PART_SLICE bytes, each sent as base64. */
export const PART_REPLY = 1024 * 1024;
export const PART_SLICE = 768 * 1024;
// how long a reply sent in parts waits for its link.part calls
const PARTS_TTL = 60_000;
const CALL_TIMEOUT = 30_000;

const Parts = z.object({ __parts: z.object({ id: z.string(), count: z.number().int().positive() }) });
const PartAsk = z.object({ id: z.string(), index: z.number().int().nonnegative() });

type Pending = { resolve(v: any): void; reject(e: Error): void; done(): void };
type Receiver = { out: fs.WriteStream; hash: crypto.Hash; next: number; count: number; resolve(v: { sha256: string }): void; reject(e: Error): void };

const gone = (err?: Error) => new ApiError('not_reachable', err ? `the link closed: ${err.message}` : 'the link is closed');

/** JSON lines over a duplex: calls matched to replies by id, and blobs sent in base64 parts. Other frames go to onFrame. */
export class LinkStream {
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private receivers = new Map<string, Receiver>();
  // the replies sent in parts, by id, until their last part is asked or PARTS_TTL passes
  private held = new Map<string, { bytes: Buffer; timer: NodeJS.Timeout }>();
  private nextHeld = 1;
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

  /** Calls `method` on the far end; a result replied in parts arrives whole. */
  async call<T>(method: string, params: unknown, o: { timeoutMs?: number; signal?: AbortSignal } = {}): Promise<T> {
    const result = await this.ask(method, params, o);
    const parts = Parts.safeParse(result);
    return (parts.success ? await this.gather(parts.data.__parts, o) : result) as T;
  }

  private ask(method: string, params: unknown, o: { timeoutMs?: number; signal?: AbortSignal }): Promise<unknown> {
    if (this.closed) return Promise.reject(gone());
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
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

  private async gather({ id, count }: { id: string; count: number }, o: { timeoutMs?: number; signal?: AbortSignal }): Promise<unknown> {
    const slices: Buffer[] = [];
    for (let index = 0; index < count; index++) {
      const { data } = await this.ask('link.part', { id, index }, o) as { data: string };
      slices.push(Buffer.from(data, 'base64'));
    }
    return JSON.parse(Buffer.concat(slices).toString('utf8'));
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

  /** The bytes written to the stream that the duplex has not passed on yet. */
  backlog(): number {
    return this.duplex.writableLength;
  }

  /** What a reply carries for `result`: itself, or where to ask for its parts when its JSON is over PART_REPLY. */
  fitReply(result: unknown): unknown {
    const json = JSON.stringify(result);
    if (json === undefined || Buffer.byteLength(json) <= PART_REPLY) return result;
    const id = String(this.nextHeld++);
    const bytes = Buffer.from(json);
    this.held.set(id, { bytes, timer: setTimeout(() => this.held.delete(id), PARTS_TTL).unref() });
    return { __parts: { id, count: Math.ceil(bytes.length / PART_SLICE) } };
  }

  /** The base64 of one part of a reply `fitReply` holds, which it lets go after the last. */
  replyPart(params: unknown): { data: string } {
    const { id, index } = PartAsk.parse(params);
    const held = this.held.get(id);
    const at = index * PART_SLICE;
    if (!held || at >= held.bytes.length) throw new ApiError('not_found', `part ${index} of reply ${id} is not held`);
    if (at + PART_SLICE >= held.bytes.length) {
      clearTimeout(held.timer);
      this.held.delete(id);
    }
    return { data: held.bytes.subarray(at, at + PART_SLICE).toString('base64') };
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
    for (const h of this.held.values()) clearTimeout(h.timer);
    this.held.clear();
    this.o.onClose(err);
  }
}

/** Replies to a call with what `run` answers, in parts when large, or with the error it throws; a method nothing runs is
 *  unknown, and link.part answers with a part of a reply. */
export async function answerCall(stream: LinkStream, f: Extract<LinkFrame, { t: 'call' }>, run?: (params: unknown) => Promise<unknown>): Promise<void> {
  try {
    if (f.method === 'link.part') return stream.send({ t: 'reply', id: f.id, result: stream.replyPart(f.params) });
    if (!run) throw new ApiError('unknown_method', `unknown method ${f.method}`);
    stream.send({ t: 'reply', id: f.id, result: stream.fitReply(await run(f.params)) });
  } catch (e) {
    stream.send({ t: 'reply', id: f.id, error: errorFrame(e) });
  }
}
