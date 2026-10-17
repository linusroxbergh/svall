import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { ZodType } from 'zod';

/** The write boundaries a crash can fall between. Tests replace one to stop the write there. */
export type DurableStages = {
  open(file: string, mode: number): number;
  write(fd: number, bytes: Buffer, offset: number): number;
  fsyncFile(fd: number): void;
  rename(from: string, to: string): void;
  link(from: string, to: string): void;
  fsyncDir(dir: string): void;
};

export const realStages: DurableStages = {
  open: (file, mode) => fs.openSync(file, 'wx', mode),
  write: (fd, bytes, offset) => fs.writeSync(fd, bytes, offset, bytes.length - offset),
  fsyncFile: (fd) => fs.fsyncSync(fd),
  rename: (from, to) => fs.renameSync(from, to),
  link: (from, to) => fs.linkSync(from, to),
  fsyncDir: (dir) => {
    const fd = fs.openSync(dir, 'r');
    try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  },
};

// a directory fsync is how a rename is made to survive power loss; not every filesystem offers it
const DIR_FSYNC_UNSUPPORTED = new Set(['EISDIR', 'EPERM', 'EINVAL', 'ENOTSUP']);

/** Names the temps this writer makes, so cleanup never touches anyone else's. */
export const DURABLE_TEMP = /\.durable-\d+-[0-9a-f]{8}\.tmp$/;

export type DurableOptions = { mode?: number; stages?: Partial<DurableStages> };

const encode = (data: Buffer | object): Buffer =>
  Buffer.isBuffer(data) ? data : Buffer.from(JSON.stringify(data, null, 2) + '\n');

/**
 * Replaces `file` with content that is either wholly old or wholly new after any crash: an exclusive
 * temp beside it, fsynced, then renamed over the target, then the directory entry fsynced.
 */
export function writeDurable(file: string, data: Buffer | object, opts: DurableOptions = {}): void {
  const stages = { ...realStages, ...opts.stages };
  const tmp = writeTemp(file, data, opts, stages);
  try { stages.rename(tmp, file); } catch (e) { fs.rmSync(tmp, { force: true }); throw e; }
  syncDir(path.dirname(file), stages);
}

/**
 * Creates `file` whole, and only while no file holds its name: the finished temp is linked into place,
 * which fails with EEXIST however close behind another writer is.
 */
export function createDurable(file: string, data: Buffer | object, opts: DurableOptions = {}): void {
  const stages = { ...realStages, ...opts.stages };
  const tmp = writeTemp(file, data, opts, stages);
  try { stages.link(tmp, file); } finally { fs.rmSync(tmp, { force: true }); }
  syncDir(path.dirname(file), stages);
}

function writeTemp(file: string, data: Buffer | object, opts: DurableOptions, stages: DurableStages): string {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.durable-${process.pid}-${crypto.randomBytes(4).toString('hex')}.tmp`;
  const bytes = encode(data);
  try {
    const fd = stages.open(tmp, opts.mode ?? 0o600);
    try {
      // one write(2) can fall short without throwing; a short temp renamed over the target is exactly
      // the partial file this module exists to prevent
      for (let at = 0; at < bytes.length;) {
        const n = stages.write(fd, bytes, at);
        if (n <= 0) throw new Error(`durable write stalled at ${at} of ${bytes.length} bytes for ${file}`);
        at += n;
      }
      stages.fsyncFile(fd);
    } finally {
      fs.closeSync(fd);
    }
  } catch (e) {
    // the name is this call's own, so whatever it holds is only this write's
    fs.rmSync(tmp, { force: true });
    throw e;
  }
  return tmp;
}

/** Appends `value` to `file` as one JSON line and fsyncs it before returning; a file it creates is the owner's alone. */
export function appendDurable(file: string, value: object): void {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const created = !fs.existsSync(file);
  const bytes = Buffer.from(`${JSON.stringify(value)}\n`);
  const fd = fs.openSync(file, 'a', 0o600);
  try {
    for (let at = 0; at < bytes.length;) {
      const n = fs.writeSync(fd, bytes, at, bytes.length - at);
      if (n <= 0) throw new Error(`append stalled at ${at} of ${bytes.length} bytes for ${file}`);
      at += n;
    }
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  if (created) syncDir(dir);
}

/** Makes a rename in `dir` durable, accepting the filesystems that refuse to fsync a directory. */
export function syncDir(dir: string, stages: DurableStages = realStages): void {
  try {
    stages.fsyncDir(dir);
  } catch (err) {
    if (!DIR_FSYNC_UNSUPPORTED.has((err as NodeJS.ErrnoException).code ?? '')) throw err;
  }
}

/**
 * Removes only temps proven finished with: a sibling final file at least as new, or an age past
 * `maxAgeMs`. A temp that could still belong to a write in flight is left alone.
 */
export function cleanupDurableTemps(dir: string, maxAgeMs = 86_400_000): void {
  let names: string[];
  try { names = fs.readdirSync(dir); } catch { return; }
  for (const name of names.filter((n) => DURABLE_TEMP.test(n))) {
    const tmp = path.join(dir, name);
    try {
      const written = fs.statSync(tmp).mtimeMs;
      const final = fs.statSync(tmp.replace(DURABLE_TEMP, ''), { throwIfNoEntry: false });
      if (Date.now() - written > maxAgeMs || (final && final.mtimeMs >= written)) fs.rmSync(tmp, { force: true });
    } catch { /* another process got there first */ }
  }
}

export type DurableRead<T> = { ok: true; value: T } | { ok: false; reason: 'missing' | 'malformed'; error?: string };

/** A validated JSON file that only ever appears whole. */
export class DurableJson<T> {
  constructor(private schema: ZodType<T>, readonly file: string, private opts: DurableOptions = {}) {}

  read(): DurableRead<T> {
    let text: string;
    try {
      text = fs.readFileSync(this.file, 'utf8');
    } catch (err) {
      // only an absent file is absent: a file we cannot read is a file we must not act as if empty
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { ok: false, reason: 'missing' };
      return { ok: false, reason: 'malformed', error: String(err) };
    }
    try {
      return { ok: true, value: this.schema.parse(JSON.parse(text)) };
    } catch (err) {
      return { ok: false, reason: 'malformed', error: String(err) };
    }
  }

  write(value: T): void {
    writeDurable(this.file, this.schema.parse(value) as object, this.opts);
  }
}
