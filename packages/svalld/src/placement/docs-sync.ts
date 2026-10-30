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
import { packTar, ustarFits } from './bundle.js';
import { unpack } from './move-steps.js';
import { homeRootOf } from './repo-key.js';
import { withLine } from './replay.js';

// the most a worker takes of the fleet's docs, gzipped
const DOCS_MAX = 20 * 1024 * 1024;
// how long the home's docs rest after a change before they go out
const DOCS_QUIET_MS = 2_000;
// a docs.write rides one line of the link, its bytes in base64
const NOTE_MAX = 1024 * 1024;
// what a docs tar can carry, which leaves out any other name; its 100-byte names leave room for a write's temp name
const packable = (rel: string): boolean => ustarFits(Buffer.from(`./${rel}`));

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

// what is at `file`, or with `follow` what a link there leads to; none where a file stands in its path
const statOf = (file: string, follow = false): fs.Stats | undefined => {
  try { return follow ? fs.statSync(file) : fs.lstatSync(file); } catch (e) {
    const { code } = e as NodeJS.ErrnoException;
    if (code === 'ENOENT' || code === 'ENOTDIR') return undefined;
    throw e;
  }
};

// the file in `file`'s path below `dir`, which leaves no folder for it; a link to a folder is one, as filesIn has it
function fileAbove(dir: string, file: string): string | undefined {
  for (let p = path.dirname(file); p.startsWith(`${path.resolve(dir)}${path.sep}`); p = path.dirname(p)) {
    const st = statOf(p, true);
    if (st && !st.isDirectory()) return p;
  }
  return undefined;
}

// whether `file` is a folder holding only folders and a crashed write's temps, that lies in `dir` wherever links lead
function emptyFolder(dir: string, file: string): boolean {
  const only = (f: string): boolean => fs.readdirSync(f, { withFileTypes: true }).every((d) => DURABLE_TEMP.test(d.name) || (d.isDirectory() && only(path.join(f, d.name))));
  return statOf(file)?.isDirectory() === true && fs.realpathSync(file).startsWith(`${fs.realpathSync(dir)}${path.sep}`) && only(file);
}

// removes such a folder from the bottom up; a file made there meanwhile stops it
function clearFolder(file: string): void {
  for (const d of fs.readdirSync(file, { withFileTypes: true })) {
    if (d.isDirectory()) clearFolder(path.join(file, d.name));
    else if (DURABLE_TEMP.test(d.name)) fs.rmSync(path.join(file, d.name));
  }
  fs.rmdirSync(file);
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
      const st = statOf(file);
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
    const { code } = e as NodeJS.ErrnoException;
    if (code === 'ENOENT' || code === 'ENOTDIR') return [];
    throw e;
  }
};

// at most `bytes` of `s` in UTF-8, cut between characters
const cut = (s: string, bytes: number): string => {
  let out = '';
  for (const ch of s) {
    if (Buffer.byteLength(out + ch) > bytes) break;
    out += ch;
  }
  return out;
};

/** A worker's change the home did not take, relative to the docs: a write kept as `kept`, beside its file or, where this Mac
 *  has a folder at its path or a file in it, beside that one, `under`; or a delete refused. */
export type Conflict = { file: string; kept?: string; under?: string };
// `made` is the sha the change was made on, none for no file
type Named = { file: string; bytes?: Buffer; sha256?: string; id: string; made?: string; prev?: string | null };

// a copy is named by its path from the docs unless it is beside the doc
function lineOf(c: Conflict, worker: string): string {
  if (!c.kept) return `${worker} deleted ${c.file}, which changed here since; it stays`;
  const kept = path.dirname(c.kept) === path.dirname(c.file) ? path.basename(c.kept) : c.kept;
  if (!c.under) return `${c.file} changed on both ${worker} and this Mac; ${worker}'s version is kept as ${kept}`;
  return `${worker} wrote ${c.file}, but ${c.under} is a ${c.under === c.file ? 'folder' : 'file'} on this Mac; ${worker}'s version is kept as ${kept}`;
}

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
  const line = lineOf(c, name);
  const ids = concerns(c.file, store.state, machine, homedir);
  if (ids.length) store.update((d) => { for (const id of ids) setNote(d.robots[id], withLine(d.robots[id].note, line)); });
}

/** The home's side: each worker's notes written into the fleet's docs, and the docs sent to each worker as a tar. */
export class HomeDocs {
  // what each path holds by a worker's last event there, so a write it made is not sent back to it
  private applied = new Map<string, { sha256?: string; machine: MachineId }>();
  private oversize = false;
  // the docs here whose names a tar cannot carry, said once until they change
  private unpacked = '';

  constructor(readonly dir: string, private log: Logger, private nameOf: (machine: MachineId) => string, private holds: (robotId: string) => boolean, private quietMs = DOCS_QUIET_MS) {}

  /** Takes a worker's change made on this Mac's copy or already held, else answers the conflict, as for a write where this Mac
   *  has a folder or a file in its path. A malformed event, or one in the folder of a robot closed here, is logged and dropped;
   *  a failed write throws and stays in the outbox. */
  apply(kind: 'docs.write' | 'docs.delete', data: unknown, machine: MachineId): Conflict | undefined {
    const named = this.named(kind, data, machine);
    if (!named) return undefined;
    const { file, bytes, sha256, made } = named;
    // a file in its path leaves a delete nothing to remove
    const above = fileAbove(this.dir, file);
    if (above) return bytes ? this.conflict(named, machine, above) : undefined;
    // a folder of docs, or a link to a folder, holds its place against a write, and no folder is a doc a delete could remove
    const st = statOf(file, true);
    const empty = emptyFolder(this.dir, file);
    if (st?.isDirectory()) {
      if (!bytes) return undefined;
      if (!empty) return this.conflict(named, machine, file);
    }
    const here = st?.isFile() ? shaOf(file) : undefined;
    if (here !== sha256 && here !== made) return this.conflict(named, machine);
    if (!bytes) fs.rmSync(file, { force: true });
    else if (here !== sha256) {
      if (empty) clearFolder(file);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      writeDurable(file, bytes);
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

  // a write goes beside the file, or beside what holds its place `under`, into the copy kept of this machine's change before
  // it if one holds that, so changes made apart keep one copy; a delete leaves the file
  private conflict(n: Named, machine: MachineId, under?: string): Conflict {
    const name = this.nameOf(machine);
    const file = path.relative(this.dir, n.file);
    if (!n.bytes) {
      this.log.info(`docs: ${lineOf({ file }, name)}`);
      return { file };
    }
    const tag = `.${name.replace(/[^A-Za-z0-9._-]/g, '-').slice(0, 32)}.`;
    const tail = `${n.id}.conflict.md`;
    const room = 100 - Buffer.byteLength(tag + tail);
    // named for its path from its folder, within the 100 bytes a tar holds of a name; a name cut short or not beside the doc
    // ends in a hash of the doc's path, so no other doc's copies share it
    const stemIn = (dir: string) => {
      const whole = path.relative(dir, n.file).replace(/\.md$/, '').replaceAll(path.sep, '-');
      if (dir === path.dirname(n.file) && Buffer.byteLength(whole) <= room) return `${whole}${tag}`;
      return `${cut(whole, room - 7)}.${sha256Hex(Buffer.from(file)).slice(0, 6)}${tag}`;
    };
    // in a folder further up while a tar cannot hold the whole path
    let dir = path.dirname(under ?? n.file);
    while (dir.startsWith(`${this.dir}${path.sep}`) && !ustarFits(Buffer.from(`./${path.relative(this.dir, dir)}/${stemIn(dir)}${tail}`))) dir = path.dirname(dir);
    // the copy of this machine's change before it may be in any folder up the doc's path, as what held its place may be gone
    const ups: string[] = [];
    for (let d = path.dirname(n.file); d === this.dir || d.startsWith(`${this.dir}${path.sep}`); d = path.dirname(d)) ups.push(d);
    const mine = ups.flatMap((d) => keptIn(d, stemIn(d))).map((f) => ({ f, sha256: shaOf(f) })).find((k) => k.sha256 && (k.sha256 === n.sha256 || k.sha256 === n.prev));
    const kept = mine?.f ?? path.join(dir, `${stemIn(dir)}${tail}`);
    if (mine?.sha256 !== n.sha256) {
      fs.mkdirSync(path.dirname(kept), { recursive: true });
      writeDurable(kept, n.bytes);
    }
    const c = { file, kept: path.relative(this.dir, kept), ...(under && { under: path.relative(this.dir, under) }) };
    this.log.info(`docs: ${lineOf(c, name)}`);
    return c;
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
    const unpacked = filesIn(this.dir).filter((rel) => !packable(rel)).join(', ');
    if (unpacked && unpacked !== this.unpacked) this.log.error(`docs: ${unpacked} reach no worker, a tar cannot carry their names`);
    this.unpacked = unpacked;
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
  // a doc of the home's not taken while one of this machine's holds its place, by the sha256 it came at, so it is said once
  private untaken = new Map<string, string>();
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
    const over = !data ? undefined : data.length > NOTE_MAX ? `is over ${NOTE_MAX / 2 ** 20} MB` : !packable(rel) ? 'has a name the home\'s docs cannot carry' : undefined;
    if (data && sha256 && over) {
      if (this.refused.get(rel) !== sha256) this.o.log.error(`docs: ${path.join(this.o.dir, rel)} ${over} and stays on this machine`);
      this.refused.set(rel, sha256);
      return;
    }
    this.refused.delete(rel);
    const last = this.pending.get(rel);
    if (sha256 === (last ? last.sha256 : this.synced[rel])) return;
    // the removal of a doc the home has above or below this path goes first, so the home has room for this one
    if (data) for (const k of new Set([...Object.keys(this.synced), ...this.pending.keys()])) if (rel.startsWith(`${k}/`) || k.startsWith(`${rel}/`)) this.journal(k);
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
    const stays = (rel: string) => (this.pending.get(rel)?.seq ?? 0) > seq || this.refused.has(rel);
    // removals first, so that a path the home made a file or a folder has room
    for (const rel of new Set([...filesIn(this.o.dir), ...Object.keys(this.synced)])) {
      if (theirs.has(rel) || stays(rel)) continue;
      const file = path.join(this.o.dir, rel);
      if (statOf(file)?.isDirectory() === false) fs.rmSync(file);
      delete this.synced[rel];
    }
    for (const rel of theirs) {
      if (stays(rel)) continue;
      const file = path.join(this.o.dir, rel);
      const data = fs.readFileSync(path.join(from, rel));
      const sha256 = sha256Hex(data);
      const last = this.pending.get(rel);
      // caught up, the file holds the last change journaled or else what the last tar brought
      if ((last ? last.sha256 : this.synced[rel]) !== sha256) {
        // a doc that stays here holds its place: until the home has taken it, or for good if it is one this machine cannot
        // send; a link here is replaced
        const empty = emptyFolder(this.o.dir, file);
        if (fileAbove(this.o.dir, file) || (statOf(file)?.isDirectory() && !empty)) {
          if (this.untaken.get(rel) !== sha256) this.o.log.info(`docs: the home's ${rel} is not taken while a doc of this machine's holds its place`);
          this.untaken.set(rel, sha256);
          delete this.synced[rel];
          continue;
        }
        if (empty) clearFolder(file);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        writeDurable(file, data);
      }
      this.untaken.delete(rel);
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
