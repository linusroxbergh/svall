import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { Blocker, TransferFile, TransferRoot } from '@svall/protocol';
import { compareReplica, diverged, proveReplica, type Divergence } from '@svall/svalld/handover/divergence';
import { boundary } from '@svall/svalld/handover/failpoints';
import { CONTROL } from '@svall/svalld/handover/inventory';
import { realScanFs, scanPath, type ScanFs } from '@svall/svalld/handover/manifest';
import { kept, relativeProblem, type ReplicaCheck } from '@svall/svalld/handover/replicas';
import { redact, type RunResult } from './process.js';
import { ProgressJournal, transactionDir, type EntryProgress } from './progress.js';
import {
  exitKind, expands, filterRules, linkModeOnly, MIN_RSYNC, parseLine, remoteShell, remoteSpec, rsyncArgv, rsyncVersion, runRsync,
  type RsyncJob, type RsyncLine, type RsyncResult, type RunRsync,
} from './rsync.js';

/** After this many passes that a changing source kept from verifying, the handover stops. */
const MAX_PASSES = 3;

const PREVIEW = 5;
const STDERR_LINES = 5;
const FAR_PROBE_TIMEOUT = 30_000;
// how often a watcher hears an entry's counts while its state holds
const SHOWN_MS = 1000;
const ENV_FILE = /^\.env(\..+)?$/;
// shorter values are too common in ordinary text to take out of it
const SECRET_MIN = 8;

/** Which end of the ssh link each role is on; the Mac controller is always one of them. */
export type Roles = { source: 'local'; destination: 'remote' } | { source: 'remote'; destination: 'local' };

/** The ssh master a transfer rides: rsync uses its socket, and it answers for the far machine and for itself. */
export type Master = {
  socket: string;
  run(argv: string[], o?: { timeoutMs?: number }): Promise<RunResult>;
  check(): Promise<boolean>;
};

/** The destination daemon's answer to this transaction's claim on a root, the excludes it proved the root under, and the folders it keeps as they are. */
export type RootClaim = { excludes: readonly string[]; check: ReplicaCheck; keep?: readonly string[] };

/** A root of the manifest. It is written only where its claim says, and only after an ok one. */
export type RootEntry = {
  kind: 'root';
  id: string;
  // the manifest's kind of root: a Git directory carried on its own keeps Git's entries whatever the excludes say
  rootKind: TransferRoot['kind'];
  entry: 'dir' | 'file';
  path: string;
  claim: RootClaim;
  files: readonly TransferFile[];
};

/** One agent session: its files, by their paths under the agent home, copied under the same paths into its stage and never with --delete. */
export type SessionEntry = {
  kind: 'session';
  id: string;
  sourceHome: string;
  stage: string;
  files: readonly TransferFile[];
};

export type TransferEntry = RootEntry | SessionEntry;

export type Failure = { reason: 'disconnected' | 'rsync' | 'refused'; code: number | null; error: string };

export type EntryOutcome =
  // `files` is what landed, which Complete seals; `passes` 0 is an earlier run's copy that still verified
  | { id: string; status: 'verified'; passes: number; files: TransferFile[] }
  | { id: string; status: 'blocked'; blocker: Blocker }
  | ({ id: string; status: 'failed' } & Failure)
  | { id: string; status: 'cancelled' }
  | { id: string; status: 'pending' };

/** `failure` is why a transfer stopped before its first entry. */
export type TransferResult = { status: 'verified' | 'blocked' | 'failed' | 'cancelled'; entries: EntryOutcome[]; blockers: Blocker[]; failure?: Failure };

export type TransferDeps = { run: RunRsync; scanFs?: ScanFs; readFile: (p: string) => string; now: () => number };

export type TransferOptions = {
  transactionId: string;
  roles: Roles;
  master: Master;
  // the local rsync, from `resolveRsync`
  rsync: string;
  entries: readonly TransferEntry[];
  // where the controller keeps this fleet's handover state
  stateDir: string;
  signal?: AbortSignal;
  // tokens that must never reach a record
  secrets?: readonly string[];
  onProgress?: (p: EntryProgress) => void;
  deps?: Partial<TransferDeps>;
};

type Plan = {
  // names this exact copy: source, target, excludes and manifest
  key: string;
  job: Omit<RsyncJob, 'dryRun'>;
  push: boolean;
  // what this Mac holds of the entry: the source it sends, or the copy it receives
  local: string;
  // where the entry is written
  copy: string;
  expected: TransferFile[];
  excludes: readonly string[];
  rootKind?: TransferRoot['kind'];
  // what the destination keeps as it is: never written, deleted or read as part of the copy
  keep: (relative: string) => boolean;
  // a session's files, read one by one; a root is read whole
  listed?: string[];
};

// the source, or the copy it is written into
type Side = 'source' | 'copy';
type Scan = { files: TransferFile[]; moved: boolean; readable: boolean; names: string[] };
type Stop = { kind: 'stop'; outcome: EntryOutcome };
type Unstable = { kind: 'unstable'; side: Side; names: string[] };

const pathProblem = (p: string): string | undefined =>
  (!p.startsWith('/') || CONTROL.test(p) || p.split('/').some((s) => s === '.' || s === '..') ? `${JSON.stringify(p)} is not a plain absolute path` : undefined);

const refused = (entry: TransferEntry, error: string): EntryOutcome => ({ id: entry.id, status: 'failed', reason: 'refused', code: null, error });

const lastLines = (text: string): string => text.trim().split('\n').slice(-STDERR_LINES).join('\n');

/** One name for a scan's content: paths, content and modes, whatever the clock says. */
const scanDigest = (files: readonly TransferFile[]): string => crypto.createHash('sha256').update(JSON.stringify(
  [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
    .map((f) => (f.type === 'file' ? [f.path, f.sha256, f.mode] : [f.path, '->', f.target])),
)).digest('hex');

/**
 * Whether the far machine has an rsync the engine can drive: a blocker when it has none or an old one,
 * a failure when the link does not answer.
 */
export async function farRsync(master: Pick<Master, 'run'>): Promise<{ blocker: Blocker } | { failure: Failure } | undefined> {
  let r: RunResult;
  try {
    r = await master.run(['rsync', '--version'], { timeoutMs: FAR_PROBE_TIMEOUT });
  } catch (err) {
    return { failure: { reason: 'disconnected', code: null, error: `ssh could not run: ${(err as Error).message}` } };
  }
  const said = lastLines(r.stderr);
  const unsupported = (message: string) => ({ blocker: { code: 'rsync_unsupported' as const, message } });
  // 255 is ssh's own failure; 126 and 127 are a far shell that found nothing to run
  if (r.code === null || r.code === 255) return { failure: { reason: 'disconnected', code: r.code, error: `the far machine did not answer rsync --version${said ? `: ${said}` : ''}` } };
  if (r.code === 126 || r.code === 127) return unsupported(`the far machine has no rsync it can run; install rsync ${MIN_RSYNC.join('.')} or newer there`);
  if (r.code !== 0) return unsupported(`rsync --version on the far machine exited ${r.code}${said ? `: ${said}` : ''}`);
  const read = rsyncVersion(r.stdout);
  return 'reason' in read ? unsupported(`the far machine's rsync ${read.reason}`) : undefined;
}

/**
 * Mirrors each entry from its source to its destination over the ssh master, then proves the copy. A
 * pass is stable when this Mac's side reads the same as it did after the pass before (the manifest,
 * for the first) and a checksum dry run finds nothing left to change; a source that keeps changing gets
 * another pass, up to three. A lost link, a failed rsync or a cancel stops the transfer and leaves
 * everything written so far for a resume.
 */
export async function transfer(o: TransferOptions): Promise<TransferResult> {
  const seen = new Set<string>();
  for (const e of o.entries) {
    if (seen.has(e.id)) throw new Error(`two transfer entries share the id ${e.id}`);
    seen.add(e.id);
  }
  const pending = (): EntryOutcome[] => o.entries.map((e) => ({ id: e.id, status: 'pending' }));
  const far = await farRsync(o.master);
  if (far && 'blocker' in far) return { status: 'blocked', entries: pending(), blockers: [far.blocker] };
  if (far) return { status: 'failed', entries: pending(), blockers: [], failure: { ...far.failure, error: redact(far.failure.error, [...(o.secrets ?? [])]) } };

  const d: TransferDeps = { run: runRsync, readFile: (p) => fs.readFileSync(p, 'utf8'), now: Date.now, ...o.deps };
  const journal = new ProgressJournal(o.transactionId, transactionDir(o.transactionId, o.stateDir), d.now);
  const rsh = remoteShell(o.master.socket);
  const entries: EntryOutcome[] = [];
  let stopped = false;
  for (const entry of o.entries) {
    if (stopped) { entries.push({ id: entry.id, status: 'pending' }); continue; }
    const outcome = await boundary('controller.rsync', () => new Mirror(entry, o, d, journal, rsh).run());
    entries.push(outcome);
    stopped = outcome.status === 'cancelled' || (outcome.status === 'failed' && outcome.reason !== 'refused');
  }
  journal.flush();
  const blockers = entries.flatMap((e) => (e.status === 'blocked' ? [e.blocker] : []));
  const status = entries.some((e) => e.status === 'cancelled') ? 'cancelled'
    : entries.some((e) => e.status === 'failed') ? 'failed'
      : blockers.length ? 'blocked' : 'verified';
  return { status, entries, blockers };
}

/** One entry's passes, and the progress record they keep. */
class Mirror {
  private progress: Omit<EntryProgress, 'updatedAt'>;
  private plan?: Plan;
  private shown?: { state: EntryProgress['state']; at: number };

  constructor(
    private entry: TransferEntry,
    private o: TransferOptions,
    private d: TransferDeps,
    private journal: ProgressJournal,
    private rsh: string,
  ) {
    const held = journal.get(entry.id);
    this.progress = {
      id: entry.id, kind: entry.kind, state: 'pending', pass: 0, done: 0, total: 0, bytes: 0, items: 0,
      totalBytes: entry.files.reduce((n, f) => n + (f.type === 'file' ? f.size : 0), 0),
      ...(held?.verifiedKey && held.verifiedScan ? { verifiedKey: held.verifiedKey, verifiedScan: held.verifiedScan } : {}),
    };
  }

  async run(): Promise<EntryOutcome> {
    if (this.o.signal?.aborted) return { id: this.entry.id, status: 'cancelled' };
    let plan: Plan | EntryOutcome;
    try {
      plan = this.planFor();
    } catch (err) {
      plan = refused(this.entry, (err as Error).message);
    }
    if ('status' in plan) return this.finish(plan);
    this.plan = plan;

    // each pass is read against the one before it; the first against the manifest, or what an earlier run verified
    let previous: readonly TransferFile[] = plan.expected;
    if (this.progress.verifiedKey === plan.key) {
      this.put({ state: 'verifying' });
      const now = await this.scan([]);
      if (now.readable && scanDigest(now.files) === this.progress.verifiedScan) {
        const compared = await boundary('controller.verify', () => this.compare());
        if (compared.kind === 'ok') return this.verified(0, now.files);
        if (compared.kind === 'stop') return compared.outcome;
      }
      previous = now.files;
    }
    let last: Unstable = { kind: 'unstable', side: 'source', names: [] };
    for (let pass = 1; pass <= MAX_PASSES; pass++) {
      const copied = await this.copy(pass);
      if (copied.kind === 'stop') return copied.outcome;
      this.put({ state: 'verifying' });
      const scanned = await this.scan(previous);
      previous = scanned.files;
      // every pass rewrites a pulled copy to match its source, so a copy that reads differently is the source moving too
      if (copied.kind === 'vanished' || scanned.moved) {
        last = { kind: 'unstable', side: 'source', names: scanned.names };
        continue;
      }
      const compared = await boundary('controller.verify', () => this.compare());
      if (compared.kind === 'ok') return this.verified(pass, scanned.files);
      if (compared.kind === 'stop') return compared.outcome;
      // the two sides differ: if this Mac's side held still while they were compared, the far side is the one moving
      const after = await this.scan(scanned.files);
      previous = after.files;
      const here: Side = plan.push ? 'source' : 'copy';
      const there: Side = plan.push ? 'copy' : 'source';
      last = { kind: 'unstable', side: after.moved ? here : there, names: [...compared.names, ...after.names] };
    }
    return this.finish({ id: this.entry.id, status: 'blocked', blocker: this.externalWriter(last) });
  }

  /** The rsync arguments for this entry in this direction, or why it may not be written. */
  private planFor(): Plan | EntryOutcome {
    const { entry, o } = this;
    const push = o.roles.source === 'local';
    let source: string;
    let target: string;
    let expected: TransferFile[];
    let excludes: readonly string[] = [];
    let keep: readonly string[] = [];
    let rootKind: TransferRoot['kind'] | undefined;
    let listed: string[] | undefined;
    let job: Omit<RsyncJob, 'dryRun' | 'source' | 'target' | 'rsh'>;
    if (entry.kind === 'root') {
      const { check } = entry.claim;
      if (!check.ok) return { id: entry.id, status: 'blocked', blocker: check.blocker };
      // the claim's path is the one the destination checked by real path: the only place this root is written
      const problem = pathProblem(entry.path) ?? pathProblem(check.path);
      if (problem) return refused(entry, problem);
      const dir = entry.entry === 'dir';
      const end = (p: string) => (dir ? `${p}/` : p);
      [source, target] = [end(entry.path), end(check.path)];
      excludes = entry.claim.excludes;
      keep = entry.claim.keep ?? [];
      rootKind = entry.rootKind;
      expected = entry.files.filter((f) => !kept(keep)(f.path));
      job = dir
        ? { delete: true, mkpath: false, filterFile: this.journal.writeFilter(entry.id, filterRules(excludes, rootKind, keep)) }
        : { delete: false, mkpath: false };
    } else {
      // a name that climbs out of its home is refused before any path is built from it
      const problem = pathProblem(entry.sourceHome) ?? pathProblem(entry.stage)
        ?? entry.files.map((f) => { const bad = relativeProblem(f.path); return bad && `${JSON.stringify(f.path)} ${bad}`; }).find(Boolean);
      if (problem) return refused(entry, problem);
      // an escaped wildcard matches only a folder that is there, and a stage may not be yet
      if (push && expands(entry.stage)) return refused(entry, `${JSON.stringify(entry.stage)} holds a wildcard character rsync would expand on the far side`);
      [source, target] = [`${entry.sourceHome}/`, `${entry.stage}/`];
      listed = entry.files.map((f) => f.path);
      expected = [...entry.files];
      job = { delete: false, mkpath: true, filesFrom: this.journal.writeList(entry.id, listed) };
    }
    const bare = (p: string) => (p.endsWith('/') ? p.slice(0, -1) : p);
    return {
      key: crypto.createHash('sha256').update(JSON.stringify([o.roles.source, entry.kind, rootKind, source, target, excludes, keep, expected])).digest('hex'),
      job: { ...job, rsh: this.rsh, source: push ? source : remoteSpec(source), target: push ? remoteSpec(target) : target },
      push,
      local: bare(push ? source : target),
      copy: bare(target),
      expected,
      excludes,
      rootKind,
      keep: kept(keep),
      ...(listed && { listed }),
    };
  }

  private async copy(pass: number): Promise<{ kind: 'ok' | 'vanished' } | Stop> {
    const plan = this.plan as Plan;
    this.put({
      state: 'transferring', pass, done: 0, total: 0, bytes: 0, items: 0,
      exitCode: undefined, signal: undefined, error: undefined, verifiedKey: undefined, verifiedScan: undefined,
    });
    // rsync's quick check misses an edit of the same size within the same second; a later pass compares content
    const r = await this.rsync({ ...plan.job, dryRun: false, checksum: pass > 1 }, (l) => {
      if (l.kind === 'item') this.put({ items: this.progress.items + 1 });
      else if (l.kind === 'progress') this.put({ bytes: l.bytes, ...(l.total !== undefined && { done: l.done, total: l.total }) });
    });
    this.put({ exitCode: r.code, signal: r.signal });
    return this.settle(r);
  }

  /** Reads this Mac's side under the claim's excludes, and how it differs from `previous`. */
  private async scan(previous: readonly TransferFile[]): Promise<Scan> {
    const plan = this.plan as Plan;
    const { divergence, files } = plan.listed
      ? await proveListed(plan.local, plan.listed, previous, this.d.scanFs)
      : await proveReplica(plan.local, [previous], plan.excludes, this.d.scanFs, plan.rootKind, plan.keep);
    return { files, moved: diverged(divergence), readable: divergence.unchecked.count === 0, names: named(divergence) };
  }

  /** Asks rsync, as a checksum dry run, what a copy would still change. */
  private async compare(): Promise<{ kind: 'ok' } | { kind: 'unstable'; names: string[] } | Stop> {
    const plan = this.plan as Plan;
    const names: string[] = [];
    const r = await this.rsync({ ...plan.job, dryRun: true }, (l) => { if (l.kind === 'item' && !linkModeOnly(l.change)) names.push(l.name); });
    const step = await this.settle(r);
    if (step.kind === 'stop') return step;
    return step.kind === 'vanished' || names.length ? { kind: 'unstable', names } : { kind: 'ok' };
  }

  // an rsync that cannot even start is a failed run like any other
  private async rsync(job: RsyncJob, onLine: (l: RsyncLine) => void): Promise<RsyncResult> {
    try {
      return await this.d.run(this.o.rsync, rsyncArgv(job), { signal: this.o.signal, onLine: (line) => onLine(parseLine(line)) });
    } catch (err) {
      return { code: null, signal: null, stderr: (err as Error).message };
    }
  }

  /**
   * A clean exit only ends a run; whether the copy is whole is the verification's to say. A closed stream
   * is the link only when the master went with it; otherwise it was the far rsync.
   */
  private async settle(r: RsyncResult): Promise<{ kind: 'ok' | 'vanished' } | Stop> {
    if (this.o.signal?.aborted) return { kind: 'stop', outcome: this.finish({ id: this.entry.id, status: 'cancelled' }) };
    const kind = exitKind(r);
    if (kind === 'ok' || kind === 'vanished') return { kind };
    const lost = kind === 'disconnected' && !(await this.o.master.check().catch(() => false));
    const said = lastLines(r.stderr);
    const how = r.code !== null ? `exited ${r.code}` : r.signal ? `was killed by ${r.signal}` : 'did not run';
    const error = `rsync ${how}${said ? `: ${said}` : ''}`;
    return { kind: 'stop', outcome: this.finish({ id: this.entry.id, status: 'failed', reason: lost ? 'disconnected' : 'rsync', code: r.code, error }) };
  }

  private verified(passes: number, files: TransferFile[]): EntryOutcome {
    const plan = this.plan as Plan;
    if (this.entry.kind === 'root') this.journal.keepVerified(this.entry.id, files);
    return this.finish({ id: this.entry.id, status: 'verified', passes, files }, { verifiedKey: plan.key, verifiedScan: scanDigest(files) });
  }

  /** Records how the entry ended, with every word of it scrubbed of secrets. */
  private finish(outcome: EntryOutcome, proof?: { verifiedKey: string; verifiedScan: string }): EntryOutcome {
    const scrubbed = this.scrub(outcome);
    const error = scrubbed.status === 'failed' ? scrubbed.error : scrubbed.status === 'blocked' ? scrubbed.blocker.message : undefined;
    this.put({ state: scrubbed.status, verifiedKey: proof?.verifiedKey, verifiedScan: proof?.verifiedScan, ...(error && { error }) });
    this.journal.flush();
    return scrubbed;
  }

  private externalWriter(last: Unstable): Blocker {
    const plan = this.plan as Plan;
    const where = last.side === 'source' ? `the source ${this.entry.kind === 'root' ? this.entry.path : this.entry.sourceHome}` : `the ${plan.push ? 'far' : 'local'} copy ${plan.copy}`;
    const shown = [...new Set(last.names)].slice(0, PREVIEW);
    // a claim asked again takes a root's copy only as a pass verified it
    const archive = this.entry.kind === 'root' ? ", archiving the destination's copy, which no pass verified" : '';
    return {
      code: 'external_writer',
      message: `${where} kept changing through ${MAX_PASSES} passes${shown.length ? ` (${shown.join(', ')})` : ''}; close whatever writes there, then resume${archive}`,
      entity: { kind: this.entry.kind === 'root' ? 'root' : 'session', id: this.entry.id },
    };
  }

  private put(patch: Partial<Omit<EntryProgress, 'updatedAt'>>): void {
    this.progress = { ...this.progress, ...patch };
    const recorded = this.journal.put(this.progress);
    // a watcher hears each new state, and the counts within one at most once a second; an item line alone says nothing it shows
    const itemOnly = Object.keys(patch).every((k) => k === 'items');
    if (this.shown?.state === recorded.state && (itemOnly || recorded.updatedAt - this.shown.at < SHOWN_MS)) return;
    this.shown = { state: recorded.state, at: recorded.updatedAt };
    this.o.onProgress?.(recorded);
  }

  private scrub(outcome: EntryOutcome): EntryOutcome {
    const secrets = [...(this.o.secrets ?? []), ...envValues(this.plan, this.d.readFile)];
    if (outcome.status === 'failed') return { ...outcome, error: redact(outcome.error, secrets) };
    if (outcome.status === 'blocked') return { ...outcome, blocker: { ...outcome.blocker, message: redact(outcome.blocker.message, secrets) } };
    return outcome;
  }
}

const named = (d: Divergence): string[] => [d.changed, d.added, d.removed, d.unchecked].flatMap((l) => l.preview);

/** Reads only the listed files under `at`, each named by its path there, against `previous`. */
async function proveListed(at: string, listed: readonly string[], previous: readonly TransferFile[], sfs: ScanFs = realScanFs): Promise<{ divergence: Divergence; files: TransferFile[] }> {
  const files: TransferFile[] = [];
  const problems: string[] = [];
  for (const p of listed) {
    const scan = await scanPath(path.posix.join(at, p), () => false, sfs);
    problems.push(...(scan?.problems ?? []).map((x) => `${p}: ${x}`));
    files.push(...(scan?.files ?? []).map((f) => ({ ...f, path: p })));
  }
  return { divergence: compareReplica([previous], files, problems), files };
}

/** The values this Mac's copies of the entry's .env files hold, to be kept out of what is recorded. */
function envValues(plan: Plan | undefined, readFile: (p: string) => string): string[] {
  if (!plan) return [];
  const values: string[] = [];
  for (const f of plan.expected) {
    const file = f.path ? path.join(plan.local, f.path) : plan.local;
    if (f.type !== 'file' || !ENV_FILE.test(path.basename(file))) continue;
    let text: string;
    try { text = readFile(file); } catch { continue; }
    for (const line of text.split('\n')) {
      const value = /^\s*(?:export\s+)?[A-Za-z_][A-Za-z0-9_]*\s*=\s*(.*?)\s*$/.exec(line)?.[1].replace(/^(['"])(.*)\1$/, '$2');
      if (value && value.length >= SECRET_MIN) values.push(value);
    }
  }
  return values;
}
