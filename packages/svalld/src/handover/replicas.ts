import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { FleetId, Generation, Sha256, TransactionId, TransferFile, type Blocker, type HandoverIssueCode, type TransferManifestV1, type TransferRoot } from '@svall/protocol';
import type { Paths } from '../paths.js';
import { createDurable, realStages, syncDir, writeDurable, type DurableStages } from './durable.js';
import { diverged, divergenceBlocker, proveReplica, type Divergence } from './divergence.js';
import { byCodeUnit, canonicalDigest } from './hash.js';
import { CONTROL, rootMatcher, type MachineLocal } from './inventory.js';
import { scanPath, type ScanFs } from './manifest.js';
import { holds, realPath } from './portable-path.js';

const Base = { version: z.literal(1), fleetId: FleetId, path: z.string() };

/**
 * What this machine knows of one root a handover writes: `reserved` before a transaction creates it,
 * `receiving` while one writes into it, `sealed` with the content a completed handover left there.
 */
export const ReplicaRecord = z.discriminatedUnion('state', [
  z.object({ ...Base, state: z.literal('reserved'), transactionId: TransactionId }),
  // what was proven there when the transaction claimed it, what that transaction brings, and the folders it leaves as they are
  z.object({
    ...Base, state: z.literal('receiving'), transactionId: TransactionId,
    baseline: z.array(TransferFile), incoming: z.array(TransferFile), kept: z.array(z.string()).optional(),
  }),
  z.object({
    ...Base, state: z.literal('sealed'), sealedBy: TransactionId, generation: Generation, manifestDigest: Sha256,
    baseline: z.array(TransferFile),
  }),
]);
export type ReplicaRecord = z.infer<typeof ReplicaRecord>;

/** The filesystem calls a store makes, so a test can make a root or a record appear, or a step crash, anywhere. */
export type ReplicaFs = {
  realpath(p: string): string;
  lstat(p: string): fs.Stats;
  readdir(p: string): string[];
  readFile(p: string): Buffer;
  mkdir(p: string, recursive: boolean): void;
  // O_EXCL: fails with EEXIST when anything holds the name
  createFile(p: string): void;
  link(from: string, to: string): void;
  rename(from: string, to: string): void;
  unlink(p: string): void;
  rmdir(p: string): void;
};

export const realReplicaFs: ReplicaFs = {
  realpath: (p) => fs.realpathSync.native(p),
  lstat: (p) => fs.lstatSync(p),
  readdir: (p) => fs.readdirSync(p),
  readFile: (p) => fs.readFileSync(p),
  mkdir: (p, recursive) => { fs.mkdirSync(p, { recursive }); },
  createFile: (p) => fs.closeSync(fs.openSync(p, 'wx', 0o600)),
  link: (from, to) => fs.linkSync(from, to),
  rename: (from, to) => fs.renameSync(from, to),
  unlink: (p) => fs.unlinkSync(p),
  rmdir: (p) => fs.rmdirSync(p),
};

/** A carried root as one machine sees it: `path` is where it lies there. */
export type ReplicaRoot = Pick<TransferRoot, 'id' | 'kind' | 'entry'> & { path: string };

/** The roots a manifest writes, at the path each has on both machines. A folded root's files travel in its outer root. */
export const replicaRoots = (manifest: Pick<TransferManifestV1, 'roots'>): ReplicaRoot[] =>
  manifest.roots.filter((r) => !r.foldedInto).map((r) => ({ id: r.id, kind: r.kind, entry: r.entry, path: r.path }));

/**
 * Whether a transaction may write a root, by its real path on this machine. `absent`: nothing is there,
 * or the claim reserved and created it; `resume`: the transaction's own partial copy; `replica`: proven to
 * hold only what handover left. Only an ok claim lets rsync write there, `--delete` included.
 */
export type ReplicaCheck =
  | { ok: true; path: string; kind: 'absent' | 'resume' | 'replica'; keep?: string[] }
  | { ok: false; path: string; blocker: Blocker; divergence?: Divergence };

/** What an archive choice can clear: a root holding work no handover left there. */
export const SVALLVABLE: ReadonlySet<string> = new Set(['destination_diverged', 'destination_occupied']);

export class ReplicaError extends Error {
  constructor(readonly code: 'conflict' | 'not_claimed' | 'not_approved' | 'invalid' | 'missing', message: string) {
    super(message);
  }
}

export type ReplicaOptions = {
  fleetId: FleetId;
  paths: Paths;
  /** what this account keeps for itself, which no root may hold or lie in, by real path here */
  local?: MachineLocal;
  fs?: Partial<ReplicaFs>;
  scanFs?: ScanFs;
  stages?: Partial<DurableStages>;
  now?: () => number;
};

/**
 * `incoming`: what the handover brings to the root, which a root no handover left may already hold exactly.
 * `keep`: folders under the root, relative to it, that belong to this machine and that no handover writes or reads.
 */
export type Inspect = { transactionId?: string; excludes: readonly string[]; incoming?: readonly TransferFile[]; keep?: readonly string[] };
/** `imported` and `landed`: the root as this transaction's own Git import left it, or as its transfer verified it, which its copy may still hold when claimed again. */
export type Claim = { transactionId: string; excludes: readonly string[]; incoming: readonly TransferFile[]; keep?: readonly string[]; imported?: readonly TransferFile[]; landed?: readonly TransferFile[] };
export type Seal = { transactionId: string; generation: number; manifestDigest: string; files: readonly TransferFile[] };

type Held = { bytes?: Buffer; record?: ReplicaRecord; error?: string };
type Blocked = { kind: 'blocked'; blocker: Blocker; divergence?: Divergence };
type Verdict = { kind: 'reserve' | 'adopt' | 'resume' } | { kind: 'replica'; found: TransferFile[] } | Blocked;

const errno = (e: unknown): string | undefined => (e as NodeJS.ErrnoException).code;
// the name rsync gives a file it has not finished writing: `.<name>.` and six characters, beside where the file goes
const RSYNC_PARTIAL = /^(.*\/)?\.([^/]+)\.[A-Za-z0-9]{6}$/;
/** Whether `p` is rsync's unfinished copy of one of the `incoming` paths. */
const partialOf = (p: string, incoming: ReadonlySet<string>): boolean => {
  const m = RSYNC_PARTIAL.exec(p);
  return m !== null && incoming.has(`${m[1] ?? ''}${m[2]}`);
};
/** Whether a path under a root lies in one of the folders `keep` names. */
export const kept = (keep: readonly string[]) => (p: string): boolean => keep.some((k) => p === k || p.startsWith(`${k}/`));

const blocked = (code: HandoverIssueCode, message: string, root: ReplicaRoot): Blocked =>
  ({ kind: 'blocked', blocker: { code, message, entity: { kind: 'root', id: root.id } } });

/** One name for what a root holds as a handover compares it: each path with its type, size and hash, or its link's text. */
export const contentDigest = (files: readonly TransferFile[]): string => canonicalDigest([...files]
  .sort((a, b) => byCodeUnit(a.path, b.path))
  .map((f) => (f.type === 'file' ? [f.path, 'file', f.size, f.sha256] : [f.path, 'symlink', f.target])));

/** Why a manifest path cannot name a place under its root, if it cannot. */
export function relativeProblem(p: string): string | undefined {
  if (CONTROL.test(p)) return 'holds a control character';
  if (p.split('/').some((s) => s === '' || s === '.' || s === '..')) return 'is not a plain relative path';
  return undefined;
}

/** Why a manifest path cannot name a place on this machine, if it cannot. */
export const absoluteProblem = (p: string | undefined): string | undefined =>
  (p !== undefined && p.startsWith('/') && !relativeProblem(p.slice(1)) ? undefined : `${JSON.stringify(p)} is not a plain absolute path`);

/** Why a list of files cannot lie under a root of this entry, if it cannot. */
export function filesProblem(files: readonly TransferFile[], entry: TransferRoot['entry']): string | undefined {
  const seen = new Set<string>();
  for (const f of files) {
    const bad = entry === 'file' ? (f.path === '' ? undefined : 'lies under a file') : relativeProblem(f.path);
    if (bad) return `${JSON.stringify(f.path)} ${bad}`;
    if (f.type === 'symlink' && CONTROL.test(f.target)) return `${JSON.stringify(f.path)} links to a path holding a control character`;
    if (seen.has(f.path)) return `${JSON.stringify(f.path)} is listed twice`;
    seen.add(f.path);
  }
  return undefined;
}

const rootProblem = (root: ReplicaRoot, files: readonly TransferFile[]): string | undefined =>
  absoluteProblem(root.path) ?? filesProblem(files, root.entry);

/**
 * The replica records of one fleet on this machine, under its fleet home and never inside a root. Every
 * write happens in one synchronous step after a check of the bytes it read, so one daemon's calls never
 * interleave inside it.
 */
export class ReplicaStore {
  private fs: ReplicaFs;
  private stages: DurableStages;

  constructor(private opts: ReplicaOptions) {
    this.fs = { ...realReplicaFs, ...opts.fs };
    this.stages = { ...realStages, ...opts.stages };
  }

  /** Read-only, for preflight: whether a transaction could claim this root, and what stops it if not. */
  async inspect(root: ReplicaRoot, t: Inspect): Promise<ReplicaCheck> {
    const at = this.canonical(root.path);
    const v = await this.assess(root, at, this.read(at), t.transactionId, t.excludes, t.incoming, t.keep ?? []);
    if (v.kind === 'blocked') return this.refused(at, v);
    return { ok: true, path: at, kind: v.kind === 'resume' || v.kind === 'replica' ? v.kind : 'absent' };
  }

  /**
   * Takes a root for a transaction before anything is written into it. An absent root is reserved by an
   * exclusive record and only then created; an existing one must prove it holds only what handover left.
   */
  async claim(root: ReplicaRoot, t: Claim): Promise<ReplicaCheck> {
    const at = this.canonical(root.path);
    const held = this.read(at);
    const keep = [...(t.keep ?? [])];
    const v = await this.assess(root, at, held, t.transactionId, t.excludes, t.incoming, keep);
    const receiving = (baseline: TransferFile[]): ReplicaRecord => ({
      ...this.base(at), state: 'receiving', transactionId: t.transactionId, baseline, incoming: [...t.incoming], ...(keep.length && { kept: keep }),
    });
    switch (v.kind) {
      case 'blocked':
        return this.refused(at, v);
      case 'resume': {
        // its own partial copy holds only what the claim knew there, brought, imported or verified as landed, and nothing
        // written there since; what it left as it was is what it named then
        const r = held.record as Extract<ReplicaRecord, { state: 'receiving' }>;
        const known = new Set([...r.baseline, ...r.incoming].map((f) => f.path));
        const incoming = new Set(r.incoming.map((f) => f.path));
        const stays = kept(r.kept ?? []);
        const accepted = [r.baseline, r.incoming, ...(t.imported ? [t.imported] : []), ...(t.landed ? [t.landed] : [])];
        const { divergence } = await proveReplica(at, accepted, t.excludes, this.opts.scanFs, root.kind, (p) => stays(p) || (!known.has(p) && partialOf(p, incoming)));
        if (diverged(divergence)) return this.refused(at, { kind: 'blocked', blocker: divergenceBlocker(root, at, divergence), divergence });
        return { ok: true, path: at, kind: 'resume', ...(r.kept?.length && { keep: r.kept }) };
      }
      case 'replica':
        this.put(at, held.bytes, receiving(v.found));
        return { ok: true, path: at, kind: 'replica', ...(keep.length && { keep }) };
      case 'adopt':
        this.put(at, held.bytes, receiving([]));
        return { ok: true, path: at, kind: 'absent' };
      case 'reserve': {
        const reserved = this.put(at, held.bytes, { ...this.base(at), state: 'reserved', transactionId: t.transactionId });
        if (!this.create(root, at)) {
          this.put(at, reserved, undefined);
          return this.refused(at, blocked('destination_occupied', `${at} appeared while it was being reserved`, root));
        }
        this.put(at, reserved, receiving([]));
        return { ok: true, path: at, kind: 'absent' };
      }
    }
  }

  /**
   * At Complete, records what the fleet left in a root at `generation`. The destination seals only a root
   * this transaction claimed; the source seals the copy it leaves behind, whatever record was there.
   */
  seal(root: ReplicaRoot, s: Seal, side: 'source' | 'destination'): void {
    const problem = rootProblem(root, s.files);
    if (problem) throw new ReplicaError('invalid', `${root.path}: ${problem}`);
    const at = this.canonical(root.path);
    const held = this.read(at);
    const r = held.record;
    if (r?.state === 'sealed' && r.sealedBy === s.transactionId) return;
    if (side === 'destination' && !(r?.state === 'receiving' && r.transactionId === s.transactionId)) {
      throw new ReplicaError('not_claimed', `${at} was not claimed by handover ${s.transactionId}`);
    }
    this.put(at, held.bytes, {
      ...this.base(at), state: 'sealed', sealedBy: s.transactionId, generation: s.generation, manifestDigest: s.manifestDigest,
      baseline: [...s.files],
    });
  }

  /**
   * Renames a root to a timestamped sibling no other file or folder holds, forgets its record so the path
   * can be reserved, and returns where the old content now lies. Only when `approved` names the root.
   */
  archive(root: ReplicaRoot, approved: readonly string[] | undefined): { path: string; archivedTo: string } {
    const at = this.canonical(root.path);
    if (!approved?.some((name) => name === root.id || name === root.path || name === at)) {
      throw new ReplicaError('not_approved', `archiving ${at} takes a choice that names it`);
    }
    const problem = rootProblem(root, []);
    const home = this.clash(root, at);
    const local = this.localClash(at);
    if (problem || home || local) throw new ReplicaError('invalid', problem ?? local ?? `${at} overlaps the fleet home ${home}`);
    let st: fs.Stats;
    try { st = this.fs.lstat(at); } catch (e) {
      if (errno(e) === 'ENOENT') throw new ReplicaError('missing', `nothing is at ${at}`);
      throw e;
    }
    const stamp = new Date((this.opts.now ?? Date.now)()).toISOString().replace(/\.\d+Z$/, 'Z').replaceAll(':', '');
    for (let n = 1; n <= 100; n++) {
      const to = `${at}.archived-${stamp}${n > 1 ? `-${n}` : ''}`;
      if (!this.moveAside(at, to, st.isDirectory())) continue;
      const held = this.read(at);
      if (held.bytes) this.put(at, held.bytes, undefined);
      return { path: at, archivedTo: to };
    }
    throw new ReplicaError('conflict', `every archive name beside ${at} is taken`);
  }

  private async assess(
    root: ReplicaRoot, at: string, held: Held, transactionId: string | undefined, excludes: readonly string[], incoming: readonly TransferFile[] | undefined, keep: readonly string[],
  ): Promise<Verdict> {
    const problem = rootProblem(root, incoming ?? []);
    if (problem) return blocked('path_unsupported', `${root.path}: ${problem}`, root);
    const home = this.clash(root, at);
    if (home) return blocked('path_unsupported', `${at} overlaps the fleet home ${home}, whose token, keys and journal stay on this machine`, root);
    const local = this.localClash(at);
    if (local) return blocked('path_unsupported', local, root);
    if (held.error) return blocked('destination_occupied', `${at} has a replica record this machine cannot use: ${held.error}`, root);
    let st: fs.Stats | undefined;
    try { st = this.fs.lstat(at); } catch (e) {
      if (errno(e) === 'ENOTDIR') return blocked('path_collision', `a parent of ${at} is not a folder`, root);
      if (errno(e) !== 'ENOENT') throw e;
    }
    if (!st) return { kind: 'reserve' };
    const r = held.record;
    const occupied = blocked('destination_occupied', `${at} already exists and no handover left it there`, root);
    if (!r) return (await this.holding(root, at, excludes, incoming, keep)) ?? occupied;
    // a crash can fall between creating a reserved root and marking it; an empty root holds no one's work
    if (r.state === 'reserved') return this.empty(root, at, st) ? { kind: 'adopt' } : occupied;
    if (r.state === 'receiving' && r.transactionId === transactionId) return { kind: 'resume' };
    // a copy another handover was let go with may also hold what this one brings, which a copy over it loses nothing of
    const accepted = r.state === 'sealed' ? [r.baseline] : [r.baseline, r.incoming, ...(incoming ? [incoming] : [])];
    // rsync spares only what this transfer excludes, so the proof reads everything else
    const { divergence, files } = await proveReplica(at, accepted, excludes, this.opts.scanFs, root.kind, kept(keep));
    if (!diverged(divergence)) return { kind: 'replica', found: files };
    return { kind: 'blocked', blocker: divergenceBlocker(root, at, divergence), divergence };
  }

  /** A root that holds exactly what this handover brings, read under its excludes, and so nothing a copy would lose. */
  private async holding(root: ReplicaRoot, at: string, excludes: readonly string[], incoming: readonly TransferFile[] | undefined, keep: readonly string[]): Promise<Verdict | undefined> {
    if (incoming === undefined) return undefined;
    const scan = await scanPath(at, rootMatcher(root.kind, excludes), this.opts.scanFs);
    const files = (scan?.files ?? []).filter((f) => !kept(keep)(f.path));
    if (!scan || scan.problems.length || contentDigest(files) !== contentDigest(incoming)) return undefined;
    return { kind: 'replica', found: files };
  }

  /** Whether a transaction's claim on a root stands, with nothing sealed over it since. */
  receives(root: ReplicaRoot, transactionId: string): boolean {
    const r = this.read(this.canonical(root.path)).record;
    return r?.state === 'receiving' && r.transactionId === transactionId;
  }

  /** The folders a transaction's claim on a root left as they were, while that claim stands. */
  keptBy(root: ReplicaRoot, transactionId: string): string[] {
    const r = this.read(this.canonical(root.path)).record;
    return r?.state === 'receiving' && r.transactionId === transactionId ? r.kept ?? [] : [];
  }

  private refused(at: string, v: Blocked): ReplicaCheck {
    return { ok: false, path: at, blocker: v.blocker, ...(v.divergence && { divergence: v.divergence }) };
  }

  /**
   * The fleet home a root would hold or lie in, by real path. Mission control's folder, and the fleet's .env, docs
   * and agent profiles at their own paths, may lie in it, reached through no link that leads elsewhere in it.
   */
  private clash(root: ReplicaRoot, at: string): string | undefined {
    const home = this.canonical(this.opts.paths.home);
    if (holds(at, home)) return home;
    if (!holds(home, at)) return undefined;
    const lexicalHome = path.posix.resolve(this.opts.paths.home);
    const lexical = path.posix.resolve(root.path);
    const direct = holds(lexicalHome, lexical) && at === path.posix.join(home, path.posix.relative(lexicalHome, lexical));
    const { env, docs, agentProfiles } = this.opts.paths;
    const place = ({ env, docs, profiles: agentProfiles } as Partial<Record<ReplicaRoot['kind'], string>>)[root.kind];
    const allowed = root.kind === 'home' || (place !== undefined && lexical === path.posix.resolve(place));
    return direct && allowed ? undefined : home;
  }

  /** The ssh folder, agent login or Svall install a root would hold or lie in, each by its real path here. */
  private localClash(at: string): string | undefined {
    const files = (this.opts.local?.files ?? []).map((p) => this.canonical(p));
    const dirs = (this.opts.local?.dirs ?? []).map((p) => this.canonical(p));
    const held = [...files, ...dirs].find((p) => holds(at, p));
    if (held) return held === at ? `${at} stays on this machine` : `${at} holds ${held}, which stays on this machine`;
    const dir = dirs.find((d) => holds(d, at));
    return dir && `${at} lies in ${dir}, which stays on this machine`;
  }

  private canonical(p: string): string {
    return realPath(path.posix.resolve(p), (q) => this.fs.realpath(q));
  }

  private base(at: string) {
    return { version: 1 as const, fleetId: this.opts.fleetId, path: at };
  }

  private file(at: string): string {
    return this.opts.paths.replicaRecord(this.opts.fleetId, at);
  }

  private read(at: string): Held {
    let bytes: Buffer;
    try { bytes = this.fs.readFile(this.file(at)); } catch (e) {
      return errno(e) === 'ENOENT' ? {} : { error: errno(e) ?? String(e) };
    }
    let record: ReplicaRecord;
    try { record = ReplicaRecord.parse(JSON.parse(bytes.toString('utf8'))); } catch {
      return { bytes, error: 'it is not a replica record' };
    }
    if (record.fleetId !== this.opts.fleetId || record.path !== at) return { bytes, error: `it names ${record.path} of fleet ${record.fleetId}` };
    return { bytes, record };
  }

  /** Replaces the record only while it still holds `expected`, or creates it only while there is none. */
  private put(at: string, expected: Buffer | undefined, next: ReplicaRecord | undefined): Buffer | undefined {
    const file = this.file(at);
    const bytes = next && Buffer.from(JSON.stringify(ReplicaRecord.parse(next)));
    const stages = this.opts.stages;
    if (!expected) {
      try { if (bytes) createDurable(file, bytes, { stages }); } catch (e) {
        if (errno(e) === 'EEXIST') throw new ReplicaError('conflict', `another call reserved ${at} first`);
        throw e;
      }
      return bytes;
    }
    let now: Buffer | undefined;
    try { now = this.fs.readFile(file); } catch (e) { if (errno(e) !== 'ENOENT') throw e; }
    if (!now?.equals(expected)) throw new ReplicaError('conflict', `another call changed the record of ${at} meanwhile`);
    if (bytes) writeDurable(file, bytes, { stages });
    else { this.fs.unlink(file); syncDir(path.dirname(file), this.stages); }
    return bytes;
  }

  // the parents may be made by anyone; the root itself only by this call, or it is not ours
  private create(root: ReplicaRoot, at: string): boolean {
    this.fs.mkdir(path.dirname(at), true);
    try {
      if (root.entry === 'dir') this.fs.mkdir(at, false);
      else this.fs.createFile(at);
      return true;
    } catch (e) {
      if (errno(e) === 'EEXIST') return false;
      throw e;
    }
  }

  private empty(root: ReplicaRoot, at: string, st: fs.Stats): boolean {
    return root.entry === 'dir' ? st.isDirectory() && this.fs.readdir(at).length === 0 : st.isFile() && st.size === 0;
  }

  // a folder replaces an empty one made for it and a file becomes a new link, so neither can land on anything already there
  private moveAside(from: string, to: string, dir: boolean): boolean {
    try {
      if (dir) this.fs.mkdir(to, false);
      else this.fs.link(from, to);
    } catch (e) {
      if (errno(e) === 'EEXIST') return false;
      throw e;
    }
    try {
      if (dir) this.fs.rename(from, to);
      else this.fs.unlink(from);
    } catch (e) {
      if (dir) try { this.fs.rmdir(to); } catch { /* an empty folder, left for the user */ }
      throw e;
    }
    return true;
  }
}
