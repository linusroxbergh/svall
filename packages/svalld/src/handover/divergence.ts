import path from 'node:path';
import type { Blocker, TransferFile, TransferRoot } from '@svall/protocol';
import { byCodeUnit } from '../hash.js';
import { excludedPath, noiseReader, rootMatcher } from './inventory.js';
import { realScanFs, scanPath, type ScanFs } from './manifest.js';

/** How many paths of each kind a report names; its counts are always whole. */
const PREVIEW = 10;

export type PathList = { count: number; preview: string[] };
/** How a replica differs from what handover last left in it. `unchecked` names what could not be read. */
export type Divergence = { added: PathList; removed: PathList; changed: PathList; unchecked: PathList };

type Role = 'volatile' | 'index' | 'ref' | 'bytes';

// content and mode decide, as rsync would restore both, though not the group and other bits each machine's umask sets;
// an mtime alone changes nothing, and a Git index is what it stages
const same = (a: TransferFile, b: TransferFile, role: Role): boolean => (a.type === 'file'
  ? b.type === 'file' && (a.mode & ~0o077) === (b.mode & ~0o077) && (a.sha256 === b.sha256 || (role === 'index' && a.gitIndex !== undefined && a.gitIndex === b.gitIndex))
  : b.type === 'symlink' && a.target === b.target);

// what a fetch, a prefetch or a repack changes in a Git directory: nothing a branch, HEAD, the index or a stash holds
const VOLATILE = /^(FETCH_HEAD$|objects\/|refs\/remotes\/|logs\/refs\/remotes\/|refs\/prefetch\/|logs\/refs\/prefetch\/)/;
// where a Git directory keeps its refs, which packing them moves from one file to the other
const REF = /^(packed-refs$|refs\/)/;

/**
 * How each path is compared, and the innermost Git directory it lies in. A Git directory is a `.git` folder, the root
 * when it is one, or, inside a Git directory, a `worktrees/<id>` or `modules/<name>` folder holding HEAD; a HEAD anywhere
 * else, such as a remote's `refs/remotes/origin/HEAD`, is only a file. Under the innermost Git directory, state that
 * carries no work is left out, the index is read by what it stages and refs by what they resolve to. OS and editor
 * noise is left out anywhere.
 */
function roles(paths: Iterable<string>, gitDir: boolean): (p: string) => { role: Role; dir?: string } {
  const dirs: string[] = gitDir ? [''] : [];
  const innermost = (p: string): string | undefined => {
    let inner: string | undefined;
    for (const d of dirs) if ((d === '' || p.startsWith(`${d}/`)) && (inner === undefined || d.length > inner.length)) inner = d;
    return inner;
  };
  const holders = [...new Set([...paths].filter((p) => p === 'HEAD' || p.endsWith('/HEAD')).map((p) => p.slice(0, -5).replace(/\/$/, '')))];
  for (const d of holders.sort((a, b) => a.length - b.length)) {
    if (d === '' || dirs.includes(d)) continue;
    const outer = innermost(d);
    const rest = outer === undefined ? undefined : outer === '' ? d : d.slice(outer.length + 1);
    if (d === '.git' || d.endsWith('/.git') || (rest !== undefined && /^(worktrees\/[^/]+|modules\/.+)$/.test(rest))) dirs.push(d);
  }
  const noisy = noiseReader();
  const read = (p: string): { role: Role; dir?: string } => {
    if (noisy(p)) return { role: 'volatile' };
    const inner = innermost(p);
    if (inner === undefined) return { role: 'bytes' };
    const rest = inner === '' ? p : p.slice(inner.length + 1);
    return { role: VOLATILE.test(rest) ? 'volatile' : rest === 'index' ? 'index' : REF.test(rest) ? 'ref' : 'bytes', dir: inner };
  };
  const known = new Map<string, { role: Role; dir?: string }>();
  return (p) => {
    let r = known.get(p);
    if (!r) known.set(p, r = read(p));
    return r;
  };
}

const under = (dir: string, p: string): string => (dir === '' ? p : `${dir}/${p}`);

/**
 * Each Git directory's refs by what they resolve to, a loose ref ahead of a packed one, and a packed ref that only a
 * fetch moves left out as its loose file is; null for a directory one of whose ref files does not say what it holds. A
 * directory with no ref file here is not listed.
 */
function resolveRefs(files: Iterable<TransferFile>, role: ReturnType<typeof roles>): Map<string, Map<string, string> | null> {
  const dirs = new Map<string, { loose: Map<string, string>; packed: Map<string, string> } | null>();
  for (const f of files) {
    const r = role(f.path);
    if (r.role !== 'ref') continue;
    const dir = r.dir!;
    let refs = dirs.get(dir);
    if (refs === null) continue;
    if (!refs) dirs.set(dir, refs = { loose: new Map(), packed: new Map() });
    const name = dir === '' ? f.path : f.path.slice(dir.length + 1);
    if (f.type !== 'file' || (name === 'packed-refs' ? !f.refs : f.ref === undefined)) dirs.set(dir, null);
    else if (name === 'packed-refs') {
      for (const [ref, value] of Object.entries(f.refs!)) if (!VOLATILE.test(ref)) refs.packed.set(ref, value);
    }
    else refs.loose.set(name, f.ref!);
  }
  return new Map([...dirs].map(([dir, refs]) => [dir, refs && new Map([...refs.packed, ...refs.loose])]));
}

const list = (paths: string[], limit: number): PathList => ({ count: paths.length, preview: paths.sort(byCodeUnit).slice(0, limit) });

/**
 * Compares what a replica holds with each version handover may have left in it. A path matches when it
 * equals some version's entry, or is absent where some version lacks it. `gitDir` says the root itself is
 * a Git directory.
 */
export function compareReplica(accepted: readonly (readonly TransferFile[])[], found: readonly TransferFile[], unchecked: readonly string[] = [], limit = PREVIEW, gitDir = false): Divergence {
  const versions = accepted.map((files) => new Map(files.map((f) => [f.path, f])));
  const here = new Set(found.map((f) => f.path));
  const role = roles([...here, ...versions.flatMap((v) => [...v.keys()])], gitDir);
  // a Git directory every side says the value of each ref in is read ref by ref; any other, file by file
  const mine = resolveRefs(found, role);
  const theirs = accepted.map((files) => resolveRefs(files, role));
  const byRef = new Map<string, { here: Map<string, string>; versions: Map<string, string>[] }>();
  for (const dir of new Set([mine, ...theirs].flatMap((m) => [...m.keys()]))) {
    const sides = [mine, ...theirs].map((m) => (m.has(dir) ? m.get(dir)! : new Map<string, string>()));
    if (sides.every(Boolean)) byRef.set(dir, { here: sides[0]!, versions: sides.slice(1) as Map<string, string>[] });
  }
  const skipped = (p: string): boolean => { const r = role(p); return r.role === 'volatile' || (r.role === 'ref' && byRef.has(r.dir!)); };
  const added: string[] = [];
  const changed: string[] = [];
  for (const f of found) {
    if (skipped(f.path)) continue;
    const known = versions.map((v) => v.get(f.path));
    if (known.every((k) => !k)) added.push(f.path);
    else if (!known.some((k) => k && same(k, f, role(f.path).role))) changed.push(f.path);
  }
  const removed = [...new Set(versions.flatMap((v) => [...v.keys()]))]
    .filter((p) => !here.has(p) && versions.every((v) => v.has(p)) && !skipped(p));
  for (const [dir, refs] of byRef) {
    for (const [name, value] of refs.here) {
      if (refs.versions.every((v) => !v.has(name))) added.push(under(dir, name));
      else if (!refs.versions.some((v) => v.get(name) === value)) changed.push(under(dir, name));
    }
    for (const name of new Set(refs.versions.flatMap((v) => [...v.keys()]))) {
      if (!refs.here.has(name) && refs.versions.every((v) => v.has(name))) removed.push(under(dir, name));
    }
  }
  return { added: list(added, limit), removed: list(removed, limit), changed: list(changed, limit), unchecked: list([...unchecked], limit) };
}

export const diverged = (d: Divergence): boolean => [d.added, d.removed, d.changed, d.unchecked].some((l) => l.count > 0);

/**
 * Reads a replica the way its source was read and compares it with each version handover may have left,
 * over the paths the excludes leave on both sides: host-local caches drop out, a gitignored file does not.
 * A Git directory carried on its own is read whole. A file `ignore` names is not read as there.
 */
export async function proveReplica(
  at: string, accepted: readonly (readonly TransferFile[])[], excludes: readonly string[], sfs: ScanFs = realScanFs, kind?: TransferRoot['kind'],
  ignore?: (relative: string) => boolean, limit = PREVIEW,
): Promise<{ divergence: Divergence; files: TransferFile[] }> {
  const excluded = rootMatcher(kind, excludes);
  const scan = await scanPath(at, excluded, sfs);
  const files = (scan?.files ?? []).filter((f) => !ignore?.(f.path));
  // the scan never reaches a path the excludes name or one under an excluded folder; the root itself is always read
  const kept = accepted.map((version) => version.filter((f) => (f.path === '' || !excludedPath(f.path, excluded)) && !ignore?.(f.path)));
  return { divergence: compareReplica(kept, files, scan?.problems ?? [], limit, kind === 'gitdir'), files };
}

/** What differs in the root at `at`, kind by kind, with the paths the report names; the root itself shows by its own name. */
export function describeDivergence(at: string, d: Divergence): string {
  return (['added', 'removed', 'changed', 'unchecked'] as const).filter((k) => d[k].count > 0).map((k) => {
    const shown = d[k].preview.map((p) => p || path.basename(at));
    return `${d[k].count} ${k} (${shown.join(', ')}${d[k].count > shown.length ? ', …' : ''})`;
  }).join('; ');
}

/** The blocker a divergent root raises: what changed, and the ways on that lose nothing. */
export function divergenceBlocker(root: { id: string }, at: string, d: Divergence): Blocker {
  return {
    code: 'destination_diverged',
    message: `${at} changed while this machine did not own the fleet: ${describeDivergence(at, d)}. Recover the changes by hand, or archive it to continue`,
    entity: { kind: 'root', id: root.id },
  };
}
