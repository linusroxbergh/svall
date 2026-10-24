import fs from 'node:fs';
import path from 'node:path';
import {
  TRANSFER_SCHEMA_VERSION, TransferManifestV1,
  type Blocker, type HandoverEntity, type ManifestSummary, type TransferFile, type TransferRoot, type TransferSession, type Warning,
} from '@svall/protocol';
import { writeDurable } from './durable.js';
import { gitIndexDigest } from './git-graph.js';
import { byCodeUnit, canonicalDigest, canonicalJson, hashStream } from './hash.js';
import { CONTROL, rootMatcher, settle, unusedRepositories, type Inventory, type InventorySession } from './inventory.js';
import { holds } from './portable-path.js';
import { sessionAdapter } from './sessions/registry.js';
import { SessionError, type FoundSession, type SessionAdapter } from './sessions/types.js';

type Stat = Pick<fs.Stats, 'isFile' | 'isDirectory' | 'isSymbolicLink' | 'mode' | 'size' | 'mtimeMs'> & Partial<Pick<fs.Stats, 'ctimeMs' | 'ino'>>;

/** The reads a scan makes, so a test can make a file vanish, refuse or turn up in any order. */
export type ScanFs = {
  stat(p: string): Promise<Stat>;
  lstat(p: string): Promise<Stat>;
  readdir(p: string): Promise<Buffer[]>;
  readlink(p: string): Promise<string>;
  read(p: string): AsyncIterable<Buffer>;
};

export const realScanFs: ScanFs = {
  stat: (p) => fs.promises.stat(p),
  lstat: (p) => fs.promises.lstat(p),
  readdir: (p) => fs.promises.readdir(p, { encoding: 'buffer' }),
  readlink: (p) => fs.promises.readlink(p),
  read: (p) => fs.createReadStream(p),
};

type FileEntry = Extract<TransferFile, { type: 'file' }>;
type Hashed = Pick<FileEntry, 'size' | 'sha256' | 'gitIndex' | 'ref' | 'refs'>;
/** What a read took of each file, by its path and the stat that says it has not changed since: one a later read can take as it is. */
export type Hashes = Map<string, Hashed>;

// a write moves a file's ctime, which nothing sets back, and a file put in its place has another inode
// a write in the same tick of a coarse clock as a read leaves the stat as it was, so a stat this close to one names no hash
const RACY_MS = 2_000;
const stamp = (file: string, st: Stat): string | undefined =>
  (st.ctimeMs === undefined || st.ino === undefined ? undefined : `${file}\0${st.size}\0${st.mtimeMs}\0${st.ctimeMs}\0${st.ino}`);

/** A preflight's manifest names no transaction; a freeze's names the one it froze for. */
export type ManifestHeader = { transactionId?: string; generation: number };
/**
 * `listed`: the carried files and their bytes as the walk found them, read or not. `unused`: what blocks unless the
 * choices carry the Git repositories no character works in.
 */
export type BuiltManifest = { manifest: TransferManifestV1; digest: string; blockers: Blocker[]; warnings: Warning[]; unused: Blocker[]; listed: Listed; hashes: Hashes };
type Listed = { files: number; bytes: number };

const ENV_FILE = /^\.env(\..+)?$/;
// the logins other tools keep in plain text under an account's home
const CREDENTIAL_FILE = /(?:^|\/)(?:\.netrc|\.git-credentials|\.config\/gh\/hosts\.yml|\.aws\/credentials|\.docker\/config\.json)$/;
const BLOCK = 4096;
// the most a file named like a Git index is read whole to name it by its staged entries
const INDEX_MAX = 256 * 1024 * 1024;
// the most a file named like a Git ref or packed-refs is read whole to name it by the refs it holds
const REFS_MAX = 1024 * 1024;
const LOOSE_REF = /^(?:[0-9a-f]{40}|[0-9a-f]{64}|ref: refs\/\S+)$/;
const PACKED_REF = /^([0-9a-f]{40}|[0-9a-f]{64}) (refs\/\S+)$/;
// files hashed at once: a many-file tree is bound by round trips to the disk, and each read holds one chunk
const HASHING = 8;
const gone = (e: unknown): boolean => (e as NodeJS.ErrnoException).code === 'ENOENT';
const reason = (e: unknown): string => (e as NodeJS.ErrnoException).code ?? String(e);

type Scan = { files: TransferFile[]; problems: string[]; envFiles: string[]; credentialFiles: string[]; repos: string[]; listed: Listed; hashes: Hashes };

async function* tap(chunks: AsyncIterable<Buffer>, into: Buffer[] | undefined): AsyncIterable<Buffer> {
  for await (const chunk of chunks) { into?.push(chunk); yield chunk; }
}

/** What a file read whole says as Git refs: the value a loose ref holds, or each ref a packed-refs file packs. */
function gitRefs(name: string, buf: Buffer): Pick<Extract<TransferFile, { type: 'file' }>, 'ref' | 'refs'> {
  const text = buf.toString('utf8');
  if (name !== 'packed-refs') return LOOSE_REF.test(text.replace(/\n$/, '')) ? { ref: text.replace(/\n$/, '') } : {};
  const refs: Record<string, string> = {};
  for (const line of text.replace(/\n$/, '').split('\n')) {
    // a header, and the commit a tag above peels to
    if (line.startsWith('#') || /^\^[0-9a-f]{40,64}$/.test(line)) continue;
    const m = PACKED_REF.exec(line);
    if (!m) return {};
    refs[m[2]] = m[1];
  }
  return { refs };
}

async function addFile(scan: Scan, relative: string, file: string, st: Stat, sfs: ScanFs, known?: ReadonlyMap<string, Hashed>): Promise<void> {
  const key = stamp(file, st);
  const held = key === undefined ? undefined : known?.get(key);
  if (held) {
    scan.files.push({ type: 'file', path: relative, mode: st.mode & 0o7777, mtimeMs: Math.trunc(st.mtimeMs), ...held });
    scan.hashes.set(key!, held);
    return;
  }
  try {
    const name = path.basename(file);
    const refFile = name === 'packed-refs' || /(^|\/)refs\//.test(relative);
    const whole = (name === 'index' && st.size <= INDEX_MAX) || (refFile && st.size <= REFS_MAX) ? [] : undefined;
    const started = Date.now();
    const { sha256, size } = await hashStream(tap(sfs.read(file), whole));
    const gitIndex = name === 'index' && whole && gitIndexDigest(Buffer.concat(whole));
    const refs = refFile && whole ? gitRefs(name, Buffer.concat(whole)) : {};
    const read = { size, sha256, ...(gitIndex && { gitIndex }), ...refs };
    scan.files.push({ type: 'file', path: relative, mode: st.mode & 0o7777, mtimeMs: Math.trunc(st.mtimeMs), ...read });
    if (key !== undefined && (st.ctimeMs ?? started) < started - RACY_MS) scan.hashes.set(key, read);
  } catch (e) {
    // a file removed since the listing is simply not there; the verify pass catches the change
    if (!gone(e)) scan.problems.push(`${relative || file}: ${reason(e)}`);
  }
}

/** Runs at most `width` tasks at once: `add` waits for a free place, `drain` for every task. A task never rejects. */
function pool(width: number): { add(task: () => Promise<void>): Promise<void>; drain(): Promise<void> } {
  const running = new Set<Promise<void>>();
  return {
    async add(task) {
      while (running.size >= width) await Promise.race(running);
      const p: Promise<void> = task().finally(() => running.delete(p));
      running.add(p);
    },
    drain: async () => { await Promise.all(running); },
  };
}

type Hashing = ReturnType<typeof pool>;

async function walk(
  scan: Scan, base: string, relative: string, excluded: (relative: string, dir: boolean) => boolean, sfs: ScanFs, hashing: Hashing | undefined, known?: ReadonlyMap<string, Hashed>,
): Promise<void> {
  let names: Buffer[];
  try { names = await sfs.readdir(path.join(base, relative)); } catch (e) {
    if (!gone(e)) scan.problems.push(`${relative || '.'}: ${reason(e)}`);
    return;
  }
  for (const raw of names) {
    const name = raw.toString('utf8');
    const rel = relative ? `${relative}/${name}` : name;
    if (!Buffer.from(name, 'utf8').equals(raw)) { scan.problems.push(`${rel}: not valid UTF-8`); continue; }
    if (CONTROL.test(name)) { scan.problems.push(`${JSON.stringify(rel)}: a control character`); continue; }
    const file = path.join(base, rel);
    let st: Stat;
    try { st = await sfs.lstat(file); } catch (e) {
      if (!gone(e)) scan.problems.push(`${rel}: ${reason(e)}`);
      continue;
    }
    // a folder below the top that holds a `.git` is a repository's checkout
    if (name === '.git' && relative) scan.repos.push(relative);
    if (st.isDirectory()) {
      if (!excluded(rel, true)) await walk(scan, base, rel, excluded, sfs, hashing, known);
    } else if (!excluded(rel, false) && st.isSymbolicLink()) {
      try {
        const target = await sfs.readlink(file);
        if (CONTROL.test(target)) scan.problems.push(`${JSON.stringify(rel)}: a link whose text holds a control character`);
        else { scan.files.push({ type: 'symlink', path: rel, target }); scan.listed.files++; }
      } catch (e) {
        if (!gone(e)) scan.problems.push(`${rel}: ${reason(e)}`);
      }
    } else if (!excluded(rel, false) && st.isFile()) {
      scan.listed.files++;
      scan.listed.bytes += st.size;
      // a Git index is read whole, so only one is held at a time
      if (hashing && name === 'index') await addFile(scan, rel, file, st, sfs, known);
      else if (hashing) await hashing.add(() => addFile(scan, rel, file, st, sfs, known));
      if (ENV_FILE.test(name)) scan.envFiles.push(rel);
      if (CREDENTIAL_FILE.test(file)) scan.credentialFiles.push(rel);
    }
    // a socket, fifo or device holds nothing to carry
  }
}

const listed = (items: string[], limit: number): string => {
  const sorted = [...items].sort(byCodeUnit);
  return `${sorted.slice(0, limit).join('; ')}${items.length > limit ? `; and ${items.length - limit} more` : ''}`;
};

/**
 * Reads every root and session the inventory names into one manifest, hashing each file as a stream, or taking what
 * `known` holds for a root's file unchanged since, and names the result by the digest of its canonical JSON. Without
 * `read` it walks the names alone and reads no file: the manifest lists links only, and `listed` and the blockers are
 * what a read would find from names.
 */
export async function buildManifest(
  inventory: Inventory, header: ManifestHeader, sfs: ScanFs = realScanFs, read = true, known?: ReadonlyMap<string, Hashed>,
): Promise<BuiltManifest> {
  const { roots, blockers, warnings, unused, listed: counted, hashes } = await scanRoots(inventory, sfs, read, known);
  const sessions: TransferSession[] = [];
  for (const session of inventory.sessions) {
    const carried = await scanSession(session, sfs, read);
    blockers.push(...carried.blockers);
    counted.files += carried.listed.files;
    counted.bytes += carried.listed.bytes;
    if (carried.session) sessions.push(carried.session);
  }

  const manifest = TransferManifestV1.parse({
    version: TRANSFER_SCHEMA_VERSION,
    transactionId: header.transactionId,
    generation: header.generation,
    fromMachineId: inventory.fromMachineId,
    toMachineId: inventory.toMachineId,
    home: inventory.home,
    destinationHome: inventory.destinationHome,
    fleet: inventory.fleet,
    snapshot: inventory.snapshot,
    excludes: inventory.excludes,
    roots,
    sessions,
    git: inventory.git,
  });
  return { manifest, digest: manifestDigest(manifest), blockers: settle(blockers), warnings: settle(warnings), unused: settle(unused), listed: counted, hashes };
}

async function scanRoots(
  inventory: Inventory, sfs: ScanFs, hash: boolean, known?: ReadonlyMap<string, Hashed>,
): Promise<{ roots: TransferRoot[]; blockers: Blocker[]; warnings: Warning[]; unused: Blocker[]; listed: Listed; hashes: Hashes }> {
  const hashes: Hashes = new Map();
  const blockers = [...inventory.blockers];
  const warnings: Warning[] = [...inventory.warnings];
  const unused: Blocker[] = [];
  const roots: TransferRoot[] = [];
  const counted: Listed = { files: 0, bytes: 0 };
  for (const root of inventory.roots) {
    const entity: HandoverEntity = { kind: 'root', id: root.id };
    const scanned = await scanPath(root.path, rootMatcher(root.kind, inventory.excludes), sfs, !root.foldedInto, hash, known);
    if (!scanned) {
      // a working directory or a context file that is gone has nothing to carry; a repository has to be rebuilt
      if (root.kind === 'repo' || root.kind === 'worktree' || root.kind === 'gitdir') blockers.push({ code: 'worktree_unresolved', message: `${root.path} no longer exists`, entity });
      continue;
    }
    const { entry, files, problems, envFiles, credentialFiles } = scanned;
    counted.files += scanned.listed.files;
    counted.bytes += scanned.listed.bytes;
    for (const [key, held] of scanned.hashes) hashes.set(key, held);
    if (problems.length) {
      blockers.push({ code: 'path_unsupported', message: `${root.path}: ${problems.length} ${problems.length === 1 ? 'path' : 'paths'} cannot be carried: ${listed(problems, 5)}`, entity });
    }
    if (root.kind === 'env') {
      warnings.push({ code: 'env_file', message: "the fleet's .env, which holds its scribe credentials, is copied to the destination", entity });
    } else if (envFiles.length) {
      warnings.push({ code: 'env_file', message: `${root.path} holds ${listed(envFiles, 3)}, copied to the destination with the rest of the tree; they may hold secrets`, entity });
    }
    if (credentialFiles.length) {
      warnings.push({
        code: 'credential_file', entity,
        message: entry === 'file' ? `${root.path} is a login another tool keeps in plain text, and is copied to the destination`
          : `${root.path} holds ${listed(credentialFiles, 3)}, logins other tools keep in plain text, copied to the destination with the rest of the tree`,
      });
    }
    if (root.kind === 'cwd') unused.push(...unusedRepositories(inventory, root, scanned.repos));
    roots.push({ ...root, entry, files: files.sort((a, b) => byCodeUnit(a.path, b.path)) });
  }
  return { roots, blockers, warnings, unused, listed: counted, hashes };
}

/**
 * One agent session as its adapter finds it from the recorded transcript: every file hashed under the
 * source's agent home, and where the transcript lands: at the same place under the destination's agent home.
 * Without `read` its files are only found to be there.
 */
async function scanSession(session: InventorySession, sfs: ScanFs, read: boolean): Promise<{ session?: TransferSession; blockers: Blocker[]; listed: Listed }> {
  const entity: HandoverEntity = { kind: 'character', id: session.characterId };
  const counted: Listed = { files: 0, bytes: 0 };
  let adapter: SessionAdapter;
  let found: FoundSession;
  // a kind no adapter carries is a blocker like any session that cannot be found
  try {
    adapter = sessionAdapter(session.agent);
    found = await adapter.discover(session.sourcePath, session.sessionId, sfs);
  } catch (e) {
    if (e instanceof SessionError) return { blockers: [{ code: e.code, message: e.message, entity }], listed: counted };
    throw e;
  }
  const files: TransferFile[] = [];
  const unreadable: string[] = [];
  for (const rel of found.files) {
    const file = path.posix.join(found.home, rel);
    try {
      const st = await sfs.lstat(file);
      counted.files++;
      counted.bytes += st.size;
      if (!read) continue;
      const { sha256, size } = await hashStream(sfs.read(file));
      files.push({ type: 'file', path: rel, mode: st.mode & 0o7777, size, mtimeMs: Math.trunc(st.mtimeMs), sha256 });
    } catch (e) {
      if (rel === found.transcript && gone(e)) return { blockers: [{ code: 'transcript_missing', message: `${session.sourcePath} is not there`, entity }], listed: counted };
      // a sidecar removed since the listing is simply not there; the verify pass catches the change
      if (!gone(e)) unreadable.push(`${rel}: ${reason(e)}`);
    }
  }
  const blockers: Blocker[] = [];
  if (!session.destinationHome) blockers.push({ code: 'agent_cli_missing', message: `the destination reported no ${session.agent} home to place ${session.sessionId} in`, entity });
  if (unreadable.length) blockers.push({ code: 'path_unsupported', message: `${session.sourcePath}: ${listed(unreadable, 5)}`, entity });
  const placed = session.destinationHome ? { destinationPath: path.posix.join(session.destinationHome, found.transcript) } : {};
  return { session: { ...session, ...placed, sourceHome: found.home, adapter: adapter.adapter, files }, blockers, listed: counted };
}

/**
 * Scans `top` as a manifest records it, or only notes what it is when `contents` is false; undefined when
 * it is gone. Without `hash` it walks the names and reads no file. `top` itself is followed, as rsync follows
 * a source named with a trailing slash; nothing under it is.
 */
export async function scanPath(
  top: string, excluded: (relative: string, dir: boolean) => boolean, sfs: ScanFs = realScanFs, contents = true, hash = true, known?: ReadonlyMap<string, Hashed>,
): Promise<(Scan & { entry: TransferRoot['entry'] }) | undefined> {
  let st: Stat;
  const counted: Listed = { files: 0, bytes: 0 };
  try { st = await sfs.stat(top); } catch (e) {
    if (gone(e)) return undefined;
    return { entry: 'dir', files: [], problems: [reason(e)], envFiles: [], credentialFiles: [], repos: [], listed: counted, hashes: new Map() };
  }
  const scan: Scan & { entry: TransferRoot['entry'] } = {
    entry: st.isDirectory() ? 'dir' : 'file', files: [], problems: [], envFiles: [], credentialFiles: [], repos: [], listed: counted, hashes: new Map(),
  };
  if (!contents) return scan;
  if (st.isDirectory()) {
    const hashing = hash ? pool(HASHING) : undefined;
    await walk(scan, top, '', excluded, sfs, hashing, known);
    await hashing?.drain();
    scan.files.sort((a, b) => byCodeUnit(a.path, b.path));
  } else if (st.isFile()) {
    counted.files++;
    counted.bytes += st.size;
    if (hash) await addFile(scan, '', top, st, sfs, known);
    if (CREDENTIAL_FILE.test(top)) scan.credentialFiles.push(top);
  }
  else scan.problems.push('neither a file nor a folder');
  return scan;
}

/** The name of a manifest: the sha256 of its canonical JSON, whatever order it was built or read in. */
export const manifestDigest = (manifest: TransferManifestV1): string => canonicalDigest(TransferManifestV1.parse(manifest));

/** What preflight reports: the carried roots, their files and bytes, and the sessions. */
export function summarize(manifest: TransferManifestV1): ManifestSummary {
  const files = [...manifest.roots.filter((r) => !r.foldedInto).flatMap((r) => r.files), ...manifest.sessions.flatMap((s) => s.files)];
  return {
    digest: manifestDigest(manifest),
    roots: manifest.roots.filter((r) => !r.foldedInto).length,
    files: files.length,
    bytes: files.reduce((n, f) => n + (f.type === 'file' ? f.size : 0), 0),
    sessions: manifest.sessions.length,
  };
}

/** The folder the destination writes a path into: the home for what lies in it, else the folder that already holds it there. */
export const landingFolder = (p: string, home: string): string => (holds(home, p) ? home : path.posix.dirname(p));

/**
 * Bytes a first transfer needs in each folder the destination writes into, every file rounded up to a whole
 * block: a root counts against its landing folder, a session against its agent home's.
 */
export function spaceNeed(manifest: TransferManifestV1): Record<string, number> {
  const need: Record<string, number> = {};
  const add = (at: string, files: TransferFile[]): void => {
    const folder = landingFolder(at, manifest.home);
    need[folder] = (need[folder] ?? 0) + files.reduce((n, f) => n + (f.type === 'file' ? Math.ceil(f.size / BLOCK) * BLOCK : 0), 0);
  };
  for (const r of manifest.roots) if (!r.foldedInto) add(r.path, r.files);
  for (const s of manifest.sessions) add(s.destinationHome ?? manifest.home, s.files);
  return need;
}

/**
 * Keeps a manifest at mode 0600 as its canonical JSON, so the file hashes to its digest. A manifest is
 * immutable: writing the one already there changes nothing, and any other is refused.
 */
export function writeManifest(file: string, manifest: TransferManifestV1): string {
  const digest = manifestDigest(manifest);
  let held: string | undefined;
  try { held = readManifest(file).digest; } catch (e) { if (!gone(e)) throw e; }
  if (held === digest) return digest;
  if (held !== undefined) throw new Error(`${file} already holds manifest ${held}`);
  writeDurable(file, Buffer.from(canonicalJson(TransferManifestV1.parse(manifest))), { mode: 0o600 });
  return digest;
}

export function readManifest(file: string): { manifest: TransferManifestV1; digest: string } {
  const manifest = TransferManifestV1.parse(JSON.parse(fs.readFileSync(file, 'utf8')));
  return { manifest, digest: manifestDigest(manifest) };
}
