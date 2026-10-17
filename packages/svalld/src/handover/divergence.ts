import path from 'node:path';
import type { Blocker, TransferFile, TransferRoot } from '@svall/protocol';
import { byCodeUnit } from './hash.js';
import { excludedPath, rootMatcher } from './inventory.js';
import { realScanFs, scanPath, type ScanFs } from './manifest.js';

/** How many paths of each kind a report names; its counts are always whole. */
const PREVIEW = 10;

export type PathList = { count: number; preview: string[] };
/** How a replica differs from what handover last left in it. `unchecked` names what could not be read. */
export type Divergence = { added: PathList; removed: PathList; changed: PathList; unchecked: PathList };

type Role = 'volatile' | 'index' | 'bytes';

// content and mode decide, as rsync would restore both; an mtime alone changes nothing, and a Git index is what it stages
const same = (a: TransferFile, b: TransferFile, role: Role): boolean => (a.type === 'file'
  ? b.type === 'file' && a.mode === b.mode && (a.sha256 === b.sha256 || (role === 'index' && a.gitIndex !== undefined && a.gitIndex === b.gitIndex))
  : b.type === 'symlink' && a.target === b.target);

// what a fetch, a prefetch or a repack changes in a Git directory: nothing a branch, HEAD, the index or a stash holds
const VOLATILE = /^(FETCH_HEAD$|objects\/|refs\/remotes\/|logs\/refs\/remotes\/|refs\/prefetch\/|logs\/refs\/prefetch\/)/;

/**
 * How each path is compared. A Git directory is a `.git` folder, the root when it is one, or, inside a
 * Git directory, a `worktrees/<id>` or `modules/<name>` folder holding HEAD; a HEAD anywhere else, such as
 * a remote's `refs/remotes/origin/HEAD`, is only a file. Under the innermost Git directory, state that
 * carries no work is left out and the index is read by what it stages.
 */
function roles(paths: Iterable<string>, gitDir: boolean): (p: string) => Role {
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
  return (p) => {
    const inner = innermost(p);
    if (inner === undefined) return 'bytes';
    const rest = inner === '' ? p : p.slice(inner.length + 1);
    return VOLATILE.test(rest) ? 'volatile' : rest === 'index' ? 'index' : 'bytes';
  };
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
  const added: string[] = [];
  const changed: string[] = [];
  for (const f of found) {
    const r = role(f.path);
    if (r === 'volatile') continue;
    const known = versions.map((v) => v.get(f.path));
    if (known.every((k) => !k)) added.push(f.path);
    else if (!known.some((k) => k && same(k, f, r))) changed.push(f.path);
  }
  const removed = [...new Set(versions.flatMap((v) => [...v.keys()]))]
    .filter((p) => !here.has(p) && versions.every((v) => v.has(p)) && role(p) !== 'volatile');
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
  ignore?: (relative: string) => boolean,
): Promise<{ divergence: Divergence; files: TransferFile[] }> {
  const excluded = rootMatcher(kind, excludes);
  const scan = await scanPath(at, excluded, sfs);
  const files = (scan?.files ?? []).filter((f) => !ignore?.(f.path));
  // the scan never reaches a path the excludes name or one under an excluded folder; the root itself is always read
  const kept = accepted.map((version) => version.filter((f) => (f.path === '' || !excludedPath(f.path, excluded)) && !ignore?.(f.path)));
  return { divergence: compareReplica(kept, files, scan?.problems ?? [], PREVIEW, kind === 'gitdir'), files };
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
