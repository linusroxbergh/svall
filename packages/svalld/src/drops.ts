import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { ApiError, DROP_MAX, type MachineId } from '@svall/protocol';
import type { HomeLinks } from './link/home.js';
import type { HomeConnection } from './link/worker.js';
import type { Router } from './placement/router.js';
import type { Store } from './store.js';

// a drop folder older than this goes when the next drop lands on its machine
const DROP_KEEP_MS = 7 * 86_400_000;
// an upload no part has reached for this long is let go
const UPLOAD_IDLE_MS = 60_000;
const NAME_BYTES = 255;


/** The name a drop lands under: its last path component, without control or format characters, at most 255 bytes with its extension kept. */
export function dropName(raw: string): string {
  const clean = (raw.split('/').pop() ?? '').replace(/[\p{Cc}\p{Cf}]/gu, '').trim();
  if (clean === '' || clean === '.' || clean === '..') return 'file';
  if (Buffer.byteLength(clean) <= NAME_BYTES) return clean;
  const ext = path.extname(clean);
  const keep = Buffer.byteLength(ext) <= 32 ? ext : '';
  const stem = [...clean.slice(0, clean.length - keep.length)];
  while (Buffer.byteLength(stem.join('') + keep) > NAME_BYTES) stem.pop();
  return stem.join('') + keep;
}

/**
 * A new folder for one drop under this user's `<tmp>/svall-drop-<uid>`, which is made 0700 and refused when it is a link or
 * another user's; folders there older than a week go first. `/tmp`'s sticky bit keeps another user from swapping it after.
 */
export function dropFolder(o: { tmp?: string; uid?: number; now?: number } = {}): string {
  const uid = o.uid ?? process.getuid!();
  const root = path.join(o.tmp ?? '/tmp', `svall-drop-${uid}`);
  // mkdir follows no link at its last component: one there is EEXIST, and the lstat below refuses it
  try { fs.mkdirSync(root, { mode: 0o700 }); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e; }
  const st = fs.lstatSync(root);
  if (!st.isDirectory()) throw new ApiError('refused', `${root} is not a folder; nothing is dropped there`);
  if (st.uid !== uid) throw new ApiError('refused', `${root} belongs to another user; nothing is dropped there`);
  if ((st.mode & 0o777) !== 0o700) fs.chmodSync(root, 0o700);
  const old = (o.now ?? Date.now()) - DROP_KEEP_MS;
  for (const name of fs.readdirSync(root)) {
    const at = path.join(root, name);
    try { if (fs.lstatSync(at).mtimeMs < old) fs.rmSync(at, { recursive: true, force: true }); } catch { /* gone meanwhile */ }
  }
  return fs.mkdtempSync(`${root}/`);
}

/** Copies `file` into a drop folder here as `name` made safe, for its owner alone, and answers where it landed. */
export function landHere(file: string, name: string, at: Parameters<typeof dropFolder>[0] = {}): string {
  const dest = path.join(dropFolder(at), dropName(name));
  fs.copyFileSync(file, dest, fs.constants.COPYFILE_EXCL);
  fs.chmodSync(dest, 0o600);
  return dest;
}

type Upload = { file: string; fd: number; next: number; bytes: number; hash: crypto.Hash; idle: NodeJS.Timeout; unlisten(): void };
type Staged = { file: string; sha256: string };

/**
 * The drops the API takes in parts, each staged in `dir` until robot.drop lands it on the robot's machine. One whose socket
 * closes, or that no part reaches for a minute, is let go.
 */
export class Drops {
  private uploads = new Map<string, Upload>();

  constructor(private o: {
    dir: string; store: Store; router: Pick<Router, 'runsHere' | 'placedAt'>; links?: Pick<HomeLinks, 'call' | 'for'>; folder?: Parameters<typeof dropFolder>[0];
  }) {
    fs.rmSync(o.dir, { recursive: true, force: true });
  }

  part(upload: string, index: number, data: Buffer, signal?: AbortSignal): void {
    let u = this.uploads.get(upload);
    if (!u) {
      if (index !== 0) throw new ApiError('not_found', `no drop ${upload} is under way`);
      fs.mkdirSync(this.o.dir, { recursive: true, mode: 0o700 });
      const file = path.join(this.o.dir, upload);
      const gone = () => this.drop(upload);
      signal?.addEventListener('abort', gone, { once: true });
      u = {
        file, fd: fs.openSync(file, 'wx', 0o600), next: 0, bytes: 0, hash: crypto.createHash('sha256'),
        idle: setTimeout(gone, UPLOAD_IDLE_MS).unref(), unlisten: () => signal?.removeEventListener('abort', gone),
      };
      this.uploads.set(upload, u);
    }
    if (index !== u.next) {
      this.drop(upload);
      throw new ApiError('invalid_params', `part ${index} of drop ${upload} arrived where part ${u.next} was due`);
    }
    if (u.bytes + data.length > DROP_MAX) {
      this.drop(upload);
      throw new ApiError('too_large', `a drop carries at most ${DROP_MAX / 2 ** 20} MB`);
    }
    fs.writeSync(u.fd, data);
    u.hash.update(data);
    u.next++;
    u.bytes += data.length;
    u.idle.refresh();
  }

  /** Lands upload `upload` as `name` on the machine robot `id` runs on, and answers its path there. */
  async land(id: string, upload: string, name: string, signal?: AbortSignal): Promise<{ path: string }> {
    const staged = this.take(upload);
    try {
      const { robots, machines } = this.o.store.state;
      if (!Object.hasOwn(robots, id)) throw new ApiError('not_found', `no robot ${id}`);
      if (this.o.router.runsHere(robots[id])) return { path: landHere(staged.file, name, this.o.folder) };
      const at = this.o.router.placedAt(id) as MachineId;
      // a worker reaches no machine but its home, and keeps a drop to its own robots
      if (!this.o.links) throw new ApiError('not_reachable', `${machines?.[at]?.name ?? at} is not reachable`);
      const blob = `drop_${crypto.randomUUID()}`;
      await this.o.links.call(at, 'drop.blob', { id: blob, sha256: staged.sha256, name }, { signal });
      await this.o.links.for(at)!.sendBlob(blob, staged.file);
      return z.object({ path: z.string() }).parse(await this.o.links.call(at, 'drop.land', { id: blob }, { signal }));
    } finally {
      fs.rmSync(staged.file, { force: true });
    }
  }

  private take(upload: string): Staged {
    const u = this.uploads.get(upload);
    if (!u) throw new ApiError('not_found', `no drop ${upload} is under way`);
    this.uploads.delete(upload);
    clearTimeout(u.idle);
    u.unlisten();
    fs.closeSync(u.fd);
    return { file: u.file, sha256: u.hash.digest('hex') };
  }

  private drop(upload: string): void {
    const u = this.uploads.get(upload);
    if (!u) return;
    this.uploads.delete(upload);
    clearTimeout(u.idle);
    u.unlisten();
    fs.closeSync(u.fd);
    fs.rmSync(u.file, { force: true });
  }
}

const Offer = z.object({ id: z.string(), sha256: z.string(), name: z.string() });
const Land = z.object({ id: z.string() });

/** A worker's side: a drop the home sends lands in a drop folder here, kept only once it arrives as it left. */
export function dropCalls(o: { connection: Pick<HomeConnection, 'receiveBlob'>; folder?: Parameters<typeof dropFolder>[0] }): Record<string, (raw: unknown) => Promise<unknown>> {
  const blobs = new Map<string, { dir: string; file: string; sha256: string; got: Promise<{ sha256: string }> }>();
  const parse = <S extends z.ZodType>(schema: S, raw: unknown): z.infer<S> => {
    const p = schema.safeParse(raw);
    if (!p.success) throw new ApiError('invalid_params', z.prettifyError(p.error));
    return p.data;
  };
  const forget = (id: string): void => {
    const b = blobs.get(id);
    blobs.delete(id);
    if (b) fs.rmSync(b.dir, { recursive: true, force: true });
  };
  return {
    'drop.blob': async (raw) => {
      const { id, sha256, name } = parse(Offer, raw);
      const dir = dropFolder(o.folder);
      const file = path.join(dir, dropName(name));
      fs.closeSync(fs.openSync(file, 'wx', 0o600));
      const got = o.connection.receiveBlob(id, file);
      // a link that closes before the landing leaves nothing behind
      got.catch(() => forget(id));
      blobs.set(id, { dir, file, sha256, got });
      return { ready: true };
    },
    'drop.land': async (raw) => {
      const { id } = parse(Land, raw);
      const b = blobs.get(id);
      if (!b) throw new ApiError('not_found', `no drop ${id} came here`);
      blobs.delete(id);
      try {
        if ((await b.got).sha256 !== b.sha256) throw new ApiError('invalid', `${path.basename(b.file)} did not arrive as it left`);
      } catch (e) {
        fs.rmSync(b.dir, { recursive: true, force: true });
        throw e;
      }
      return { path: b.file };
    },
  };
}
