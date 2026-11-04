import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { ApiError, DROP_MAX } from '@svall/protocol';
import type { HomeLinks } from './link/home.js';
import type { HomeConnection } from './link/worker.js';
import { homeWord } from './machine.js';
import { parse, type Router } from './placement/router.js';
import type { Store } from './store.js';

// a drop folder older than this goes when the next drop lands on its machine
const DROP_KEEP_MS = 7 * 86_400_000;
// an upload no part has reached for this long is let go
const UPLOAD_IDLE_MS = 60_000;
// a drop.land waits for what is still in the ssh pipe to arrive
const LAND_MS = 2 * 60_000;
// an offer the home neither lands nor forgets goes after this, past the longest a client waits for robot.drop
const OFFER_MS = 15 * 60_000;
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

// where a drop lands, on the machine `machine` names
type Landing = { machine: () => string; folder?: Parameters<typeof dropFolder>[0] };

// a new folder and the file's path in it; a write that fills a worker's disk would close its link, so one that would is refused here
function landing(name: string, bytes: number, o: Landing): { dir: string; file: string } {
  const dir = dropFolder(o.folder);
  const { bavail, bsize } = fs.statfsSync(dir);
  const safe = dropName(name);
  if (bavail * bsize >= bytes) return { dir, file: path.join(dir, safe) };
  fs.rmSync(dir, { recursive: true, force: true });
  throw new ApiError('too_large', `${o.machine()} has no room in /tmp for ${safe}`);
}

/** Copies `file` into a drop folder here as `name` made safe, for its owner alone, and answers where it landed. */
export async function landHere(file: string, name: string, o: Landing): Promise<string> {
  const { dir, file: dest } = landing(name, fs.statSync(file).size, o);
  try {
    await fs.promises.copyFile(file, dest, fs.constants.COPYFILE_EXCL);
    await fs.promises.chmod(dest, 0o600);
  } catch (e) {
    fs.rmSync(dir, { recursive: true, force: true });
    throw e;
  }
  return dest;
}

type Upload = { file: string; fd: number; next: number; bytes: number; hash: crypto.Hash; idle: NodeJS.Timeout; unlisten(): void };

/**
 * The drops the API takes in parts, each staged in `dir` until robot.drop lands it on the robot's machine. One whose socket
 * closes, or that no part reaches for a minute, is let go.
 */
export class Drops {
  private uploads = new Map<string, Upload>();

  constructor(private o: {
    dir: string; store: Store; router: Pick<Router, 'runsHere' | 'placedAt'>; links?: Pick<HomeLinks, 'for'>;
  } & Landing) {
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
    const staged = this.release(upload);
    if (!staged) throw new ApiError('not_found', `no drop ${upload} is under way`);
    try {
      const { robots, machines } = this.o.store.state;
      if (!Object.hasOwn(robots, id)) throw new ApiError('not_found', `no robot ${id}`);
      const m = robots[id].moving;
      if (m) throw new ApiError('moving', `moving to ${machines?.[m.to]?.name ?? homeWord()}`);
      if (this.o.router.runsHere(robots[id])) return { path: await landHere(staged.file, name, this.o) };
      const at = this.o.router.placedAt(id);
      // a worker reaches no machine but its home, and keeps a drop to its own robots
      const link = at && this.o.links?.for(at);
      if (!link) throw new ApiError('not_reachable', `${at ? machines?.[at]?.name ?? at : id} is not reachable`);
      const blob = `drop_${crypto.randomUUID()}`;
      await link.call('drop.blob', { id: blob, sha256: staged.hash.digest('hex'), bytes: staged.bytes, name }, { signal });
      await link.sendBlob(blob, staged.file);
      // no page is left to type the path of a drop whose socket closed on the way, so what came is removed
      if (signal?.aborted) {
        await link.call('drop.forget', { id: blob });
        throw new ApiError('aborted', 'the page that sent this drop is gone');
      }
      return Landed.parse(await link.call('drop.land', { id: blob }, { timeoutMs: LAND_MS }));
    } finally {
      fs.rmSync(staged.file, { force: true });
    }
  }

  private release(upload: string): Upload | undefined {
    const u = this.uploads.get(upload);
    if (!u) return undefined;
    this.uploads.delete(upload);
    clearTimeout(u.idle);
    u.unlisten();
    fs.closeSync(u.fd);
    return u;
  }

  private drop(upload: string): void {
    const u = this.release(upload);
    if (u) fs.rmSync(u.file, { force: true });
  }
}

const Offer = z.object({ id: z.string(), sha256: z.string(), bytes: z.number().int().nonnegative(), name: z.string() });
const OfferId = z.object({ id: z.string() });
const Landed = z.object({ path: z.string() });

/**
 * A worker's side: a drop the home sends lands in a drop folder here, kept only once it arrives as it left and the home
 * says to. One the home forgets, or that it leaves for 15 minutes or across a lost link, is removed.
 */
export function dropCalls(o: { connection: Pick<HomeConnection, 'receiveBlob'> } & Landing): { calls: Record<string, (raw: unknown) => Promise<unknown>>; linkLost(): void } {
  const blobs = new Map<string, { dir: string; file: string; sha256: string; got: Promise<{ sha256: string }>; expiry: NodeJS.Timeout }>();
  const forget = (id: string): void => {
    const b = blobs.get(id);
    if (!b) return;
    blobs.delete(id);
    clearTimeout(b.expiry);
    fs.rmSync(b.dir, { recursive: true, force: true });
  };
  return {
    linkLost: () => { for (const id of [...blobs.keys()]) forget(id); },
    calls: {
      'drop.blob': async (raw) => {
        const { id, sha256, bytes, name } = parse(Offer, raw);
        const { dir, file } = landing(name, bytes, o);
        fs.closeSync(fs.openSync(file, 'wx', 0o600));
        const got = o.connection.receiveBlob(id, file);
        got.catch(() => forget(id));
        blobs.set(id, { dir, file, sha256, got, expiry: setTimeout(() => forget(id), OFFER_MS).unref() });
        return { ready: true };
      },
      'drop.forget': async (raw) => {
        forget(parse(OfferId, raw).id);
        return {};
      },
      'drop.land': async (raw) => {
        const { id } = parse(OfferId, raw);
        const b = blobs.get(id);
        if (!b) throw new ApiError('not_found', `no drop ${id} came here`);
        blobs.delete(id);
        clearTimeout(b.expiry);
        try {
          if ((await b.got).sha256 !== b.sha256) throw new ApiError('invalid', `${path.basename(b.file)} did not arrive as it left`);
        } catch (e) {
          fs.rmSync(b.dir, { recursive: true, force: true });
          throw e;
        }
        return { path: b.file };
      },
    },
  };
}
