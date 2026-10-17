import fs from 'node:fs';
import path from 'node:path';
import type { RootProbe } from '@svall/protocol';

export type ProbeFs = {
  existsSync(p: string): boolean;
  accessSync(p: string, mode: number): void;
  lstatSync(p: string): { dev: number; ino: number };
  statSync(p: string): { dev: number };
  readdirSync(p: string): string[];
  statfsSync(p: string): { bavail: number; bsize: number };
};

const ABSENT: RootProbe = { exists: false, writable: false, caseInsensitive: false, freeBytes: 0 };

/**
 * Relative paths that only differ by case or by Unicode normalization, each group of them sorted: two of them cannot
 * both land on a case-folding filesystem such as a Mac's, which also holds a composed and a decomposed name as one.
 */
export function caseCollisions(relatives: string[]): string[][] {
  const byFold = new Map<string, Set<string>>();
  for (const r of relatives) {
    const fold = r.normalize('NFD').toLowerCase();
    const held = byFold.get(fold) ?? new Set();
    held.add(r);
    byFold.set(fold, held);
  }
  const groups = [...byFold.values()].filter((s) => s.size > 1).map((s) => [...s].sort());
  return groups.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
}

const swapCase = (name: string): string => name.replace(/[A-Za-z]/g, (c) => (c === c.toLowerCase() ? c.toUpperCase() : c.toLowerCase()));

/**
 * Whether the filesystem holding `dir` folds case, read without writing: a name looked up with its case swapped finds
 * the same file. A folder's own name is looked up in its parent's filesystem, so a mount point is read by a name inside it.
 */
function foldsCase(dir: string, dep: ProbeFs): boolean {
  const same = (a: string, b: string): boolean => {
    try {
      const [x, y] = [dep.lstatSync(a), dep.lstatSync(b)];
      return x.dev === y.dev && x.ino === y.ino;
    } catch { return false; }
  };
  try {
    const [parent, name] = [path.posix.dirname(dir), path.posix.basename(dir)];
    if (swapCase(name) !== name && dep.statSync(parent).dev === dep.lstatSync(dir).dev) return same(dir, path.posix.join(parent, swapCase(name)));
    const inside = dep.readdirSync(dir).find((n) => swapCase(n) !== n);
    return inside !== undefined && same(path.posix.join(dir, inside), path.posix.join(dir, swapCase(inside)));
  } catch { return false; }
}

/** What each folder a destination writes into is good for: somewhere to write, how much room, and whether it folds case. */
export function probeFolders(folders: readonly string[], dep: ProbeFs = fs): Record<string, RootProbe> {
  const probes: Record<string, RootProbe> = {};
  for (const dir of folders) {
    if (!dep.existsSync(dir)) { probes[dir] = { ...ABSENT }; continue; }
    let writable = true;
    try { dep.accessSync(dir, fs.constants.W_OK); } catch { writable = false; }
    let freeBytes = 0;
    try { const s = dep.statfsSync(dir); freeBytes = s.bavail * s.bsize; } catch { /* no reading of the free space */ }
    probes[dir] = { exists: true, writable, caseInsensitive: foldsCase(dir, dep), freeBytes };
  }
  return probes;
}
