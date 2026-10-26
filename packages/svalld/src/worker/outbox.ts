import fs from 'node:fs';
import { z } from 'zod';
import { appendDurable, writeDurable } from '../handover/durable.js';
import type { Paths } from '../paths.js';

// an unacknowledged entry gives way to a later one of the same kind and key
const Entry = z.object({ seq: z.number().int().positive(), kind: z.string(), data: z.unknown(), key: z.string().optional() });
export type Entry = z.infer<typeof Entry>;

const readOr = (file: string, missing: string): string => {
  try { return fs.readFileSync(file, 'utf8'); } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return missing; throw e; }
};

const lines = (entries: Entry[]): Buffer => Buffer.from(entries.map((e) => `${JSON.stringify(e)}\n`).join(''));

/** What a worker did that the home has yet to acknowledge, in sequence: each entry is on disk before its seq is returned. */
export class Outbox {
  private constructor(private paths: Paths, private entries: Entry[], private lastSeq: number, private ackedSeq: number) {}

  static open(paths: Paths): Outbox {
    const acked = z.coerce.number().int().nonnegative().parse(readOr(paths.acked, '0').trim());
    const text = readOr(paths.outbox, '');
    // what follows the last newline is an append a crash cut short, which never returned its seq
    const entries = text.split('\n').slice(0, -1).map((line) => Entry.parse(JSON.parse(line))).filter((e) => e.seq > acked);
    if (text && !text.endsWith('\n')) writeDurable(paths.outbox, lines(entries));
    return new Outbox(paths, entries, entries.at(-1)?.seq ?? acked, acked);
  }

  append(kind: string, data: unknown, key?: string): number {
    const entry: Entry = { seq: this.lastSeq + 1, kind, data, ...(key !== undefined && { key }) };
    const kept = key === undefined ? this.entries : this.entries.filter((e) => e.kind !== kind || e.key !== key);
    if (kept.length < this.entries.length) writeDurable(this.paths.outbox, lines([...kept, entry]));
    else appendDurable(this.paths.outbox, entry);
    this.entries = [...kept, entry];
    this.lastSeq = entry.seq;
    return entry.seq;
  }

  after(seq: number): Entry[] {
    return this.entries.filter((e) => e.seq > seq);
  }

  /** Drops the entries up to `seq`. The seq is on disk before the file is trimmed, so a crash between leaves no seq to reuse. */
  ack(seq: number): void {
    const upTo = Math.min(seq, this.lastSeq);
    if (upTo <= this.ackedSeq) return;
    writeDurable(this.paths.acked, Buffer.from(`${upTo}\n`));
    this.ackedSeq = upTo;
    this.entries = this.after(upTo);
    writeDurable(this.paths.outbox, lines(this.entries));
  }

  last(): number {
    return this.lastSeq;
  }

  acked(): number {
    return this.ackedSeq;
  }
}
