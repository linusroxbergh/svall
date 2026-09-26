import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { holds } from '../portable-path.js';
import { SessionError, type PathMap, type SessionFs, type VersionRange } from './types.js';

const RELEASE = /^(\d+)\.(\d+)\.(\d+)$/;

const parts = (v: string): number[] => (RELEASE.exec(v) ?? []).slice(1).map(Number);

/** Orders two x.y.z releases. */
export function compareVersions(a: string, b: string): number {
  const [x, y] = [parts(a), parts(b)];
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return (x[i] ?? -1) - (y[i] ?? -1);
  return 0;
}

/** Whether a plain x.y.z release lies in the range, both ends included; a pre-release never does. */
export const inRange = (version: string, range: VersionRange): boolean =>
  RELEASE.test(version) && compareVersions(version, range.min) >= 0 && compareVersions(version, range.max) <= 0;

/** The release a CLI names in its `--version` line, whatever it wraps it in. */
export const versionOf = (text: string): string | undefined => /\d+\.\d+\.\d+[0-9A-Za-z.+-]*/.exec(text)?.[0];

const trim = (p: string): string => (p.length > 1 && p.endsWith('/') ? p.slice(0, -1) : p);

/** Maps a path under the longest source prefix that holds it, keeping the rest of it exactly as written. */
export function pathMap(pairs: readonly (readonly [from: string, to: string])[]): PathMap {
  const sorted = pairs.map(([from, to]) => [trim(from), trim(to)] as const).sort((a, b) => b[0].length - a[0].length);
  return (p) => {
    const hit = sorted.find(([from]) => holds(from, p));
    if (!hit) return undefined;
    const [from, to] = hit;
    if (p === from) return to;
    const rest = p.slice(from === '/' ? 1 : from.length + 1);
    return to === '/' ? `/${rest}` : `${to}/${rest}`;
  };
}

// a path is written bare, or as a file: URL
function relocate(v: string, map: PathMap): string {
  if (v.startsWith('file://')) {
    let p: string;
    try { p = fileURLToPath(v); } catch { return v; }
    const moved = map(p);
    return moved === undefined || moved === p ? v : pathToFileURL(moved).href;
  }
  return v.startsWith('/') ? map(v) ?? v : v;
}

/**
 * Where a record holds paths, as dotted field names: a key, `*` for any key of an object, `[]` for each
 * item of an array. `paths` are strings the adapter moves; `evidence` is what the record says rather than
 * where it is, kept byte for byte and never read. An evidence name starting `**.` matches that key at any depth.
 */
export type RecordSpec = { paths?: string[]; evidence?: string[] };

type Compiled = { paths: string[][]; evidence: string[][]; anywhere: Set<string> };

const segments = (field: string): string[] => field.split('.').flatMap((s) => (s.endsWith('[]') ? [s.slice(0, -2), '[]'] : [s]));

export function compile(...specs: RecordSpec[]): Compiled {
  const all = (k: keyof RecordSpec) => specs.flatMap((s) => s[k] ?? []);
  const evidence = all('evidence');
  return {
    paths: all('paths').map(segments),
    evidence: evidence.filter((e) => !e.startsWith('**.')).map(segments),
    anywhere: new Set(evidence.filter((e) => e.startsWith('**.')).map((e) => e.slice(3))),
  };
}

const at = (patterns: string[][], pos: string[]): boolean =>
  patterns.some((p) => p.length === pos.length && p.every((s, i) => (s === '*' ? pos[i] !== '[]' : s === pos[i])));

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** One record walked against its spec: known paths moved, and any other field still naming a source path reported. */
class Walk {
  changed = false;
  stale = new Set<string>();

  constructor(private spec: Compiled, private map: PathMap) {}

  private move(v: string): string {
    const out = relocate(v, this.map);
    if (out !== v) this.changed = true;
    return out;
  }

  // a path the source names that reads the same on both machines
  private stays(v: string): boolean {
    return relocate(v, this.map) === v;
  }

  value(v: unknown, pos: string[]): unknown {
    if (typeof v === 'string') {
      if (at(this.spec.paths, pos)) return this.move(v);
      if (!this.stays(v)) this.stale.add(pos.join('.'));
      return v;
    }
    if (Array.isArray(v)) return v.map((x) => this.value(x, [...pos, '[]']));
    if (!isRecord(v)) return v;
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) {
      const here = [...pos, k];
      if (this.spec.anywhere.has(k) || at(this.spec.evidence, here)) { out[k] = x; continue; }
      if (!this.stays(k)) this.stale.add(here.join('.'));
      out[k] = this.value(x, here);
    }
    return out;
  }
}

/** What a JSONL walk asks of an adapter for each record: the spec to walk it with, or why it cannot be. */
export type RecordCheck = { spec: Compiled } | { issue: string };

/**
 * Every line of a JSONL file walked with the spec its adapter picks for it. A line with nothing to move
 * keeps its bytes. A last line with no newline that does not parse is still being written, and stays as it is.
 */
export function walkJsonl(data: Buffer, map: PathMap, check: (record: Record<string, unknown>) => RecordCheck): { data: Buffer; issues: string[] } {
  const text = data.toString('utf8');
  if (!Buffer.from(text, 'utf8').equals(data)) return { data, issues: ['it is not UTF-8'] };
  const issues = new Map<string, number>();
  const note = (issue: string, line: number): void => { if (!issues.has(issue)) issues.set(issue, line); };
  const lines = text.split('\n');
  const out = lines.map((line, i) => {
    if (line === '') return line;
    let record: unknown;
    try { record = JSON.parse(line); } catch {
      if (i < lines.length - 1) note('a line is not JSON', i + 1);
      return line;
    }
    if (!isRecord(record)) { note('a line is not a JSON object', i + 1); return line; }
    const checked = check(record);
    if ('issue' in checked) { note(checked.issue, i + 1); return line; }
    const walk = new Walk(checked.spec, map);
    const next = walk.value(record, []);
    for (const field of walk.stale) note(`${String(record.type)} records name a source path at ${field}, which this adapter does not move`, i + 1);
    return walk.changed ? JSON.stringify(next) : line;
  });
  return { data: Buffer.from(out.join('\n'), 'utf8'), issues: [...issues].map(([issue, line]) => `${issue} (first at line ${line})`) };
}

/** One JSON document walked with a spec, kept byte for byte when nothing in it moves. */
export function walkJson(data: Buffer, map: PathMap, spec: Compiled): { data: Buffer; issues: string[] } {
  let doc: unknown;
  try { doc = JSON.parse(data.toString('utf8')); } catch { return { data, issues: ['it is not JSON'] }; }
  const walk = new Walk(spec, map);
  const next = walk.value(doc, []);
  const issues = [...walk.stale].map((field) => `it names a source path at ${field}, which this adapter does not move`);
  return { data: walk.changed ? Buffer.from(`${JSON.stringify(next)}\n`) : data, issues };
}

const gone = (e: unknown): boolean => (e as NodeJS.ErrnoException).code === 'ENOENT';
const unreadable = (file: string, e: unknown): SessionError => new SessionError('path_unsupported', `${file}: ${(e as NodeJS.ErrnoException).code ?? String(e)}`);

/** The transcript itself: a regular file, never followed through a link. */
export async function transcriptFile(fs: SessionFs, file: string): Promise<void> {
  let entry;
  try { entry = await fs.lstat(file); } catch (e) {
    if (gone(e)) throw new SessionError('transcript_missing', `${file} is not there`);
    throw unreadable(file, e);
  }
  if (entry.isSymbolicLink() || !entry.isFile()) throw new SessionError('incompatible_adapter', `${file} is not a regular file`);
}

/** Every regular file under `home/dir`, relative to `home`; nothing when the folder is absent. A link anywhere refuses the session. */
export async function filesUnder(fs: SessionFs, home: string, dir: string): Promise<string[]> {
  const full = path.posix.join(home, dir);
  let entry;
  try { entry = await fs.lstat(full); } catch (e) {
    if (gone(e)) return [];
    throw unreadable(full, e);
  }
  if (entry.isSymbolicLink()) throw new SessionError('incompatible_adapter', `${full} is a link`);
  if (entry.isFile()) return [dir];
  if (!entry.isDirectory()) throw new SessionError('incompatible_adapter', `${full} is neither a file nor a folder`);
  const out: string[] = [];
  let names: Buffer[];
  try { names = await fs.readdir(full); } catch (e) { throw unreadable(full, e); }
  for (const raw of names) {
    const name = raw.toString('utf8');
    if (!Buffer.from(name, 'utf8').equals(raw) || /[\x00-\x1f\x7f]/.test(name)) {
      throw new SessionError('path_unsupported', `${full} holds a file name a handover cannot carry`);
    }
    out.push(...await filesUnder(fs, home, path.posix.join(dir, name)));
  }
  return out;
}
