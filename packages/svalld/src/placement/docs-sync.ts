import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { z } from 'zod';
import { ApiError, Sha256, type MachineId } from '@svall/protocol';
import { DURABLE_TEMP, writeDurable } from '../handover/durable.js';
import { sha256Hex } from '../handover/hash.js';
import type { WorkerLink } from '../link/home.js';
import type { HomeConnection } from '../link/worker.js';
import type { Logger } from '../log.js';
import { packTar } from './bundle.js';
import { unpack } from './move.js';

// the most a worker takes of the fleet's docs, gzipped
const DOCS_MAX = 20 * 1024 * 1024;
// how long the home's docs rest after a change before they go out
const DOCS_QUIET_MS = 2_000;
// a docs.write rides one line of the link, its bytes in base64
const NOTE_MAX = 1024 * 1024;

const DocsWrite = z.object({ path: z.string(), data: z.string(), sha256: Sha256 });
const DocsDelete = z.object({ path: z.string() });
const DocsBlob = z.object({ id: z.string(), sha256: Sha256, seq: z.number().int().nonnegative() });
const Synced = z.record(z.string(), Sha256);

type Handlers = Record<string, (raw: unknown) => Promise<unknown>>;

/** The plain files under `dir` by their paths relative to it, a durable write's temp left out; none when it is not there. */
export function filesIn(dir: string): string[] {
  let found: fs.Dirent[];
  try { found = fs.readdirSync(dir, { recursive: true, withFileTypes: true }); } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw e;
  }
  return found.filter((d) => d.isFile() && !DURABLE_TEMP.test(d.name)).map((d) => path.relative(dir, path.join(d.parentPath, d.name))).sort();
}

/**
 * Calls `onChange` with each file under `dir` that changed once it has rested `debounceMs`: with its bytes, or with none
 * once it is gone. A folder that appears stands for each file in it.
 */
export function watchDocs(dir: string, onChange: (rel: string, data?: Buffer) => void, debounceMs = 500, log?: Pick<Logger, 'error'>): () => void {
  fs.mkdirSync(dir, { recursive: true });
  const timers = new Map<string, NodeJS.Timeout>();
  const settle = (rel: string): void => {
    timers.delete(rel);
    try {
      const file = path.join(dir, rel);
      const st = fs.lstatSync(file, { throwIfNoEntry: false });
      if (!st) onChange(rel);
      else if (st.isDirectory()) for (const f of filesIn(file)) onChange(path.join(rel, f), fs.readFileSync(path.join(file, f)));
      else if (st.isFile()) onChange(rel, fs.readFileSync(file));
    } catch (e) {
      log?.error(`docs: ${path.join(dir, rel)}: ${(e as Error).message}`);
    }
  };
  const watcher = fs.watch(dir, { recursive: true }, (_event, name) => {
    if (!name || DURABLE_TEMP.test(name)) return;
    clearTimeout(timers.get(name));
    timers.set(name, setTimeout(() => settle(name), debounceMs));
  });
  watcher.on('error', (e) => log?.error(`docs: ${dir} is no longer watched: ${e.message}`));
  return () => {
    watcher.close();
    for (const t of timers.values()) clearTimeout(t);
    timers.clear();
  };
}

/** The plain files under `dir` as a gzipped ustar. */
export async function docsTar(dir: string): Promise<Buffer> {
  fs.mkdirSync(dir, { recursive: true });
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'svall-docs-'));
  try {
    const file = path.join(tmp, 'docs.tar');
    await packTar(dir, filesIn(dir), file);
    return zlib.gzipSync(fs.readFileSync(file));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

// the file a worker's event names, refused unless it lies inside `dir`
function inside(dir: string, rel: string): string {
  const file = path.resolve(dir, rel);
  if (!file.startsWith(`${path.resolve(dir)}${path.sep}`)) throw new Error(`${rel} is not inside ${dir}`);
  return file;
}

const shaOf = (file: string): string | undefined => {
  try { return sha256Hex(fs.readFileSync(file)); } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw e;
  }
};

/** The home's side: each worker's notes written into the fleet's docs, and the docs sent to each worker as a tar. */
export class HomeDocs {
  // what each path holds by a worker's last event there, so a write it made is not sent back to it
  private applied = new Map<string, { sha256?: string; machine: MachineId }>();
  private oversize = false;

  constructor(readonly dir: string, private log: Logger, private quietMs = DOCS_QUIET_MS) {}

  /** Writes or removes the file a worker's event names unless it is so already; one that cannot be is logged and dropped, so one bad note never holds the link. */
  apply(kind: 'docs.write' | 'docs.delete', data: unknown, machine: MachineId): void {
    try {
      if (kind === 'docs.write') {
        const w = DocsWrite.parse(data);
        const bytes = Buffer.from(w.data, 'base64');
        if (sha256Hex(bytes) !== w.sha256) throw new Error(`${w.path} did not arrive as it left`);
        const file = inside(this.dir, w.path);
        if (shaOf(file) !== w.sha256) {
          fs.mkdirSync(path.dirname(file), { recursive: true });
          writeDurable(file, bytes);
        }
        this.applied.set(path.relative(this.dir, file), { sha256: w.sha256, machine });
      } else {
        const file = inside(this.dir, DocsDelete.parse(data).path);
        fs.rmSync(file, { force: true });
        this.applied.set(path.relative(this.dir, file), { machine });
      }
    } catch (e) {
      this.log.error(`docs: ${kind} from ${machine} not taken: ${(e as Error).message}`);
    }
  }

  /** Calls `changed` once the docs have rested after a change, with the machine whose event made it, if one did. */
  watch(changed: (except?: MachineId) => void): () => void {
    return watchDocs(this.dir, (rel, data) => {
      const a = this.applied.get(rel);
      changed(a && a.sha256 === (data && sha256Hex(data)) ? a.machine : undefined);
    }, this.quietMs, this.log);
  }

  /** Sends the docs to `link`, packed once its events up to `seq` are applied here; one tar over the limit is said once and not sent. */
  async push(link: Pick<WorkerLink, 'call' | 'sendBlob'>, seq: number): Promise<void> {
    const tar = await docsTar(this.dir);
    if (tar.length > DOCS_MAX) {
      if (!this.oversize) this.log.error(`docs: ${this.dir} packs to ${(tar.length / 2 ** 20).toFixed(1)} MB, over the ${DOCS_MAX / 2 ** 20} MB a worker takes; no worker gets it`);
      this.oversize = true;
      return;
    }
    this.oversize = false;
    const id = `docs_${crypto.randomUUID()}`;
    await link.call('docs.blob', { id, sha256: sha256Hex(tar), seq });
    await link.sendBlob(id, tar);
  }
}

/**
 * The worker's side: the home's docs as each tar brings them, and each change made here journaled for the home, once per
 * content. A change the home has yet to take outlasts a tar it packed before taking it.
 */
export class WorkerDocs {
  readonly handlers: Handlers;
  // each doc's sha256 as this machine and the home last both held it
  private synced: Record<string, string> = {};
  // the outbox seq of the last change journaled for each doc
  private seqs = new Map<string, number>();
  // a doc too large to journal, by the sha256 it was refused at, so it is said once
  private refused = new Map<string, string>();
  private queue: Promise<void> = Promise.resolve();
  private unwatch?: () => void;

  constructor(private o: { dir: string; file: string; stage: string; connection: Pick<HomeConnection, 'journal' | 'receiveBlob'>; log: Logger; quietMs?: number }) {
    this.handlers = { 'docs.blob': (raw) => this.offer(raw) };
  }

  /** Journals what changed while this daemon was away, then each change once it rests. */
  start(): void {
    this.synced = this.load();
    this.catchUp();
    this.unwatch = watchDocs(this.o.dir, (rel, data) => this.changed(rel, data), this.o.quietMs, this.o.log);
  }

  stop(): void {
    this.unwatch?.();
  }

  // a path gone stands for every doc under it
  private changed(rel: string, data?: Buffer): void {
    if (data) return this.journal(rel, data);
    for (const k of Object.keys(this.synced)) {
      if ((k === rel || k.startsWith(`${rel}/`)) && !fs.existsSync(path.join(this.o.dir, k))) this.journal(k);
    }
  }

  private journal(rel: string, data?: Buffer): void {
    const sha256 = data && sha256Hex(data);
    if (data && sha256 && data.length > NOTE_MAX) {
      if (this.refused.get(rel) !== sha256) this.o.log.error(`docs: ${path.join(this.o.dir, rel)} is over ${NOTE_MAX / 2 ** 20} MB and stays on this machine`);
      this.refused.set(rel, sha256);
      return;
    }
    this.refused.delete(rel);
    if (sha256 === this.synced[rel]) return;
    const seq = data ? this.o.connection.journal('docs.write', { path: rel, data: data.toString('base64'), sha256 }) : this.o.connection.journal('docs.delete', { path: rel });
    this.seqs.set(rel, seq);
    if (sha256) this.synced[rel] = sha256;
    else delete this.synced[rel];
    this.save();
  }

  // each doc whose content here is not what both sides last held
  private catchUp(): void {
    const here = new Set(filesIn(this.o.dir));
    for (const rel of new Set([...here, ...Object.keys(this.synced)])) this.journal(rel, here.has(rel) ? fs.readFileSync(path.join(this.o.dir, rel)) : undefined);
  }

  // the blob's id is taken before the home sends a byte of it; tars are settled one at a time, in order
  private async offer(raw: unknown): Promise<{ ready: true }> {
    const p = DocsBlob.safeParse(raw);
    if (!p.success) throw new ApiError('invalid_params', z.prettifyError(p.error));
    const { id, sha256, seq } = p.data;
    fs.mkdirSync(this.o.stage, { recursive: true });
    const dir = fs.mkdtempSync(path.join(this.o.stage, 'docs-in-'));
    const got = this.o.connection.receiveBlob(id, path.join(dir, 'docs.tgz'));
    got.catch(() => {});
    this.queue = this.queue.then(async () => {
      if ((await got).sha256 !== sha256) throw new Error('they did not arrive as they left');
      await unpack(path.join(dir, 'docs.tgz'), path.join(dir, 'docs'));
      this.settle(path.join(dir, 'docs'), seq);
    }).catch((e: Error) => this.o.log.error(`docs: the home's docs were not taken: ${e.message}`))
      .finally(() => fs.rmSync(dir, { recursive: true, force: true }));
    return { ready: true };
  }

  // the home's docs over these, but for a change here the home had not taken when it packed them
  private settle(from: string, seq: number): void {
    this.catchUp();
    const theirs = new Set(filesIn(from));
    for (const rel of new Set([...theirs, ...filesIn(this.o.dir)])) {
      if ((this.seqs.get(rel) ?? 0) > seq || this.refused.has(rel)) continue;
      const file = path.join(this.o.dir, rel);
      if (!theirs.has(rel)) {
        fs.rmSync(file, { force: true });
        delete this.synced[rel];
        continue;
      }
      const data = fs.readFileSync(path.join(from, rel));
      const sha256 = sha256Hex(data);
      if (this.synced[rel] === sha256) continue;
      fs.mkdirSync(path.dirname(file), { recursive: true });
      writeDurable(file, data);
      this.synced[rel] = sha256;
    }
    for (const [rel, s] of this.seqs) if (s <= seq) this.seqs.delete(rel);
    this.save();
  }

  // what was synced, or for docs with no record of it, what they hold now
  private load(): Record<string, string> {
    try { return Synced.parse(JSON.parse(fs.readFileSync(this.o.file, 'utf8'))); } catch {
      return Object.fromEntries(filesIn(this.o.dir).map((rel) => [rel, sha256Hex(fs.readFileSync(path.join(this.o.dir, rel)))]));
    }
  }

  private save(): void {
    fs.mkdirSync(path.dirname(this.o.file), { recursive: true });
    writeDurable(this.o.file, this.synced);
  }
}
