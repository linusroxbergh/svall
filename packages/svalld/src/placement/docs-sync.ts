import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { z } from 'zod';
import { ApiError, MutationId, Sha256, type FleetState, type MachineId, type Robot } from '@svall/protocol';
import { repoSlug } from '../docs.js';
import { setNote } from '../fleet.js';
import { DURABLE_TEMP, writeDurable } from '../durable.js';
import { sha256Hex } from '../hash.js';
import { newMutationId } from '../ids.js';
import type { WorkerLink } from '../link/home.js';
import type { HomeConnection } from '../link/worker.js';
import type { Logger } from '../log.js';
import type { Store } from '../store.js';
import { packTar } from './bundle.js';
import { unpack } from './move-steps.js';
import { homeRootOf } from './repo-key.js';
import { withLine } from './replay.js';

// the most a worker takes of the fleet's docs, gzipped
const DOCS_MAX = 20 * 1024 * 1024;
// how long the home's docs rest after a change before they go out
const DOCS_QUIET_MS = 2_000;
// a docs.write rides one line of the link, its bytes in base64
const NOTE_MAX = 1024 * 1024;

// what a change was made on: the home's sha as its last tar brought it, and while no tar has come since, the worker's
// own last change there (null for a removal); an older release journaled neither, nor an id
const Made = { id: MutationId.optional(), base: Sha256.optional(), prev: Sha256.nullable().optional() };
const DocsWrite = z.object({ path: z.string(), data: z.string(), sha256: Sha256, ...Made });
const DocsDelete = z.object({ path: z.string(), ...Made });
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
function watchDocs(dir: string, onChange: (rel: string, data?: Buffer) => void, debounceMs = 500, log?: Pick<Logger, 'error'>): () => void {
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

const keptIn = (dir: string, stem: string): string[] => {
  try { return fs.readdirSync(dir, { withFileTypes: true }).filter((d) => d.isFile() && d.name.startsWith(stem) && d.name.endsWith('.conflict.md')).map((d) => path.join(dir, d.name)); } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw e;
  }
};

const keptLine = (file: string, worker: string, kept: string) => `${file} changed on both ${worker} and this Mac; ${worker}'s version is kept as ${path.basename(kept)}`;
const stayedLine = (file: string, worker: string) => `${worker} deleted ${file}, which changed here since; it stays`;
const refusedLine = (file: string, worker: string, why: string) => `${worker} changed ${file}, which this Mac's docs cannot hold; it was skipped: ${why}`;
// what the docs folder answers the same way on every try for a path it cannot hold, as one under a file or past a name's length
const UNHELD = new Set(['ENOTDIR', 'EISDIR', 'ERR_FS_EISDIR', 'ENAMETOOLONG']);

/** A worker's change the home did not take, relative to the docs: a write kept beside its file as `kept`, a delete refused, or
 *  a change at a path the docs cannot hold, `refused` with why. */
export type Conflict = { file: string; kept?: string; refused?: string };
// `made` is the sha the change was made on, none for no file
type Named = { file: string; bytes?: Buffer; sha256?: string; id: string; made?: string; prev?: string | null };

/** The robots a doc at `rel` concerns: the one whose folder it is in, or `machine`'s on its island, in its repository by this Mac's main root, or anywhere for the fleet's. */
export function concerns(rel: string, state: FleetState, machine: MachineId, homedir: string): string[] {
  const [tree, id] = rel.split('/');
  if (tree === 'robots') return Object.hasOwn(state.robots, id) ? [id] : [];
  const of = (keep: (c: Robot) => boolean) => Object.values(state.robots).filter((c) => c.machine === machine && keep(c)).map((c) => c.id);
  if (tree === 'islands') return of((c) => c.islandId === id);
  if (tree === 'repos') return of((c) => { const root = homeRootOf(c, state.machines, homedir); return root !== undefined && repoSlug(root) === id; });
  return tree === 'fleet' ? of(() => true) : [];
}

/** Says a conflict in the note of each robot it concerns, as the user's line, so the scribe leaves it. */
export function noteConflict(store: Store, machine: MachineId, c: Conflict, homedir: string): void {
  const name = store.state.machines?.[machine]?.name ?? machine;
  const line = c.refused ? refusedLine(c.file, name, c.refused) : c.kept ? keptLine(c.file, name, c.kept) : stayedLine(c.file, name);
  const ids = concerns(c.file, store.state, machine, homedir);
  if (ids.length) store.update((d) => { for (const id of ids) setNote(d.robots[id], withLine(d.robots[id].note, line)); });
}

/** The home's side: each worker's notes written into the fleet's docs, and the docs sent to each worker as a tar. */
export class HomeDocs {
  // what each path holds by a worker's last event there, so a write it made is not sent back to it
  private applied = new Map<string, { sha256?: string; machine: MachineId }>();
  private oversize = false;

  constructor(readonly dir: string, private log: Logger, private nameOf: (machine: MachineId) => string, private holds: (robotId: string) => boolean, private quietMs = DOCS_QUIET_MS) {}

  /** Takes a worker's change made on this Mac's copy or already held, else answers the conflict. A malformed event, or one in
   *  the folder of a robot closed here, is logged and dropped; a failed write throws and stays in the outbox, but at a path
   *  the docs cannot hold, which no retry changes. */
  apply(kind: 'docs.write' | 'docs.delete', data: unknown, machine: MachineId): Conflict | undefined {
    const named = this.named(kind, data, machine);
    if (!named) return undefined;
    const { file, bytes, sha256, made } = named;
    try {
      const here = shaOf(file);
      if (here !== sha256 && here !== made) return this.conflict(named, machine);
      if (!bytes) fs.rmSync(file, { force: true });
      else if (here !== sha256) {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        writeDurable(file, bytes);
      }
    } catch (e) {
      if (!UNHELD.has((e as NodeJS.ErrnoException).code ?? '')) throw e;
      const rel = path.relative(this.dir, file);
      this.log.error(`docs: ${kind} of ${rel} from ${this.nameOf(machine)} skipped: ${(e as Error).message}`);
      return { file: rel, refused: (e as Error).message };
    }
    this.applied.set(path.relative(this.dir, file), { sha256, machine });
    return undefined;
  }

  // none, logged, for an event the docs cannot take
  private named(kind: 'docs.write' | 'docs.delete', data: unknown, machine: MachineId): Named | undefined {
    try {
      const e = kind === 'docs.write' ? DocsWrite.parse(data) : { ...DocsDelete.parse(data), data: undefined, sha256: undefined };
      const bytes = e.data === undefined ? undefined : Buffer.from(e.data, 'base64');
      if (bytes && sha256Hex(bytes) !== e.sha256) throw new Error(`${e.path} did not arrive as it left`);
      const file = inside(this.dir, e.path);
      const [tree, robot] = path.relative(this.dir, file).split(path.sep);
      if (tree === 'robots' && !this.holds(robot)) throw new Error(`${robot} is closed here`);
      if (!e.id) this.log.info(`docs: ${kind} of ${e.path} from ${this.nameOf(machine)} carries no id, as an older release journaled it`);
      // past the worker's own last change, the home holds `base` only by a change made here since
      const made = e.prev === undefined ? e.base : e.prev ?? undefined;
      return { file, bytes, sha256: e.sha256, id: e.id ?? newMutationId(), made, prev: e.prev };
    } catch (e) {
      this.log.error(`docs: ${kind} from ${machine} dropped: ${(e as Error).message}`);
      return undefined;
    }
  }

  // a write goes beside the file, into the copy kept of this machine's change before it if one holds that, so changes
  // made apart keep one copy; a delete leaves the file
  private conflict(n: Named, machine: MachineId): Conflict {
    const name = this.nameOf(machine);
    const file = path.relative(this.dir, n.file);
    if (!n.bytes) {
      this.log.info(`docs: ${stayedLine(file, name)}`);
      return { file };
    }
    const dir = path.dirname(n.file);
    const stem = `${path.basename(n.file, '.md')}.${name.replace(/[^A-Za-z0-9._-]/g, '-')}.`;
    const mine = keptIn(dir, stem).map((f) => ({ f, sha256: shaOf(f) })).find((k) => k.sha256 && (k.sha256 === n.sha256 || k.sha256 === n.prev));
    const kept = mine?.f ?? path.join(dir, `${stem}${n.id}.conflict.md`);
    if (mine?.sha256 !== n.sha256) {
      fs.mkdirSync(dir, { recursive: true });
      writeDurable(kept, n.bytes);
    }
    this.log.info(`docs: ${keptLine(file, name, kept)}`);
    return { file, kept: path.relative(this.dir, kept) };
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
  // each doc's sha256 as the home's last tar brought it
  private synced: Record<string, string> = {};
  // each doc's last change journaled here that no tar has covered since: its outbox seq, and its sha256 but for a removal
  private pending = new Map<string, { seq: number; sha256?: string }>();
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
    for (const k of new Set([...Object.keys(this.synced), ...this.pending.keys()])) {
      if ((k === rel || k.startsWith(`${rel}/`)) && !fs.existsSync(path.join(this.o.dir, k))) this.journal(k);
    }
  }

  // a doc's content, unless the home has it coming already: this machine's last change to it, or else the home's last tar
  private journal(rel: string, data?: Buffer): void {
    const sha256 = data && sha256Hex(data);
    if (data && sha256 && data.length > NOTE_MAX) {
      if (this.refused.get(rel) !== sha256) this.o.log.error(`docs: ${path.join(this.o.dir, rel)} is over ${NOTE_MAX / 2 ** 20} MB and stays on this machine`);
      this.refused.set(rel, sha256);
      return;
    }
    this.refused.delete(rel);
    const last = this.pending.get(rel);
    if (sha256 === (last ? last.sha256 : this.synced[rel])) return;
    const base = this.synced[rel];
    const made = { id: newMutationId(), path: rel, ...(base && { base }), ...(last && { prev: last.sha256 ?? null }) };
    const seq = data ? this.o.connection.journal('docs.write', { ...made, data: data.toString('base64'), sha256 }) : this.o.connection.journal('docs.delete', made);
    this.pending.set(rel, { seq, sha256 });
  }

  // each doc whose content here is not what this machine last journaled or the home last sent
  private catchUp(): void {
    const here = new Set(filesIn(this.o.dir));
    for (const rel of new Set([...here, ...Object.keys(this.synced), ...this.pending.keys()])) this.journal(rel, here.has(rel) ? fs.readFileSync(path.join(this.o.dir, rel)) : undefined);
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
    for (const rel of new Set([...theirs, ...filesIn(this.o.dir), ...Object.keys(this.synced)])) {
      const last = this.pending.get(rel);
      if ((last?.seq ?? 0) > seq || this.refused.has(rel)) continue;
      const file = path.join(this.o.dir, rel);
      if (!theirs.has(rel)) {
        fs.rmSync(file, { force: true });
        delete this.synced[rel];
        continue;
      }
      const data = fs.readFileSync(path.join(from, rel));
      const sha256 = sha256Hex(data);
      // caught up, the file holds the last change journaled or else what the last tar brought
      if ((last ? last.sha256 : this.synced[rel]) !== sha256) {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        writeDurable(file, data);
      }
      this.synced[rel] = sha256;
    }
    for (const [rel, { seq: s }] of this.pending) if (s <= seq) this.pending.delete(rel);
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
