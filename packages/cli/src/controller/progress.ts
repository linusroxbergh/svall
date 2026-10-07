import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { TransactionId, TransferFile } from '@svall/protocol';
import { writeDurable } from '@svall/svalld/handover/durable';

/** Where the controller keeps one transaction's files under `base`: its progress journal, and the filter files beside it. */
export function transactionDir(transactionId: string, base: string): string {
  // one path segment, and never `.` or `..`
  const name = encodeURIComponent(transactionId).replace(/^\.{1,2}$/, (dots) => '%2E'.repeat(dots.length));
  return path.join(base, 'handover', name);
}

/** How far one root or exact file has come in this transfer. Counts are the latest rsync run's. */
export const EntryProgress = z.object({
  id: z.string().min(1),
  kind: z.enum(['root', 'session']),
  state: z.enum(['pending', 'transferring', 'verifying', 'verified', 'failed', 'blocked', 'cancelled']),
  pass: z.number().int().nonnegative(),
  // entries rsync has gone through, of those it has listed
  done: z.number().int().nonnegative(),
  total: z.number().int().nonnegative(),
  bytes: z.number().int().nonnegative(),
  totalBytes: z.number().int().nonnegative(),
  items: z.number().int().nonnegative(),
  exitCode: z.number().int().nullable().optional(),
  signal: z.string().nullable().optional(),
  error: z.string().optional(),
  // the copy the last verification proved and the digest of what it read, so a resume re-verifies before it skips a copy
  verifiedKey: z.string().optional(),
  verifiedScan: z.string().optional(),
  updatedAt: z.number(),
});
export type EntryProgress = z.infer<typeof EntryProgress>;

const Journal = z.object({ version: z.literal(1), transactionId: TransactionId, entries: z.record(z.string(), EntryProgress) });

const THROTTLE_MS = 1000;

/**
 * The controller's record of a transfer. It drives display, lets a resume re-verify before skipping a copy, and gives a
 * claim asked again what each root verified as; a journal that cannot be read resumes as one that is not there.
 */
export class ProgressJournal {
  readonly file: string;
  private entries: Record<string, EntryProgress> = {};
  private written = Number.NEGATIVE_INFINITY;
  private dirty = false;

  constructor(readonly transactionId: string, readonly dir: string, private now: () => number = Date.now) {
    this.file = path.join(dir, 'progress.json');
    try {
      const held = Journal.parse(JSON.parse(fs.readFileSync(this.file, 'utf8')));
      if (held.transactionId === transactionId) this.entries = held.entries;
    } catch { /* nothing to resume from */ }
  }

  get(id: string): EntryProgress | undefined {
    return this.entries[id];
  }

  /** Records an entry: a new state is written at once, progress within one at most once a second. */
  put(p: Omit<EntryProgress, 'updatedAt'>): EntryProgress {
    const changed = this.entries[p.id]?.state !== p.state;
    const next = { ...p, updatedAt: this.now() };
    this.entries[p.id] = next;
    this.dirty = true;
    if (changed || next.updatedAt - this.written >= THROTTLE_MS) this.flush();
    return next;
  }

  flush(): void {
    if (!this.dirty) return;
    fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    writeDurable(this.file, { version: 1, transactionId: this.transactionId, entries: this.entries }, { mode: 0o600 });
    this.written = this.now();
    this.dirty = false;
  }

  /** Keeps the files a root's verification read, before its record says it verified them. */
  keepVerified(id: string, files: readonly TransferFile[]): void {
    this.keep('verified', `${encodeURIComponent(id)}.json`, JSON.stringify(files));
  }

  /** The files an entry's last verification read, while its record still says it verified them and they can be read. */
  verified(id: string): TransferFile[] | undefined {
    if (!this.entries[id]?.verifiedScan) return undefined;
    try {
      return z.array(TransferFile).parse(JSON.parse(fs.readFileSync(path.join(this.dir, 'verified', `${encodeURIComponent(id)}.json`), 'utf8')));
    } catch {
      return undefined;
    }
  }

  /** Writes a root's rsync filter into the transaction's storage, and returns where. */
  writeFilter(id: string, rules: string): string {
    return this.keep('filters', `${encodeURIComponent(id)}.rules`, rules);
  }

  /** Writes the paths one entry copies, NUL-separated as rsync's `--from0` reads them, and returns where. */
  writeList(id: string, paths: readonly string[]): string {
    return this.keep('lists', `${encodeURIComponent(id)}.from0`, paths.map((p) => `${p}\0`).join(''));
  }

  private keep(folder: string, name: string, text: string): string {
    const dir = path.join(this.dir, folder);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const file = path.join(dir, name);
    writeDurable(file, Buffer.from(text), { mode: 0o600 });
    return file;
  }
}
