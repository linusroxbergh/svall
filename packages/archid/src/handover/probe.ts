import fs from 'node:fs';
import path from 'node:path';
import type { PathRootMap, RootProbe } from '@archipelago/protocol';
import type { PortablePath } from './portable-path.js';

export type ProbeFs = {
  existsSync(p: string): boolean;
  writeFileSync(p: string, data: string, options: { mode: number }): void;
  statSync(p: string): unknown;
  rmSync(p: string, options: { force: boolean }): void;
  statfsSync(p: string): { bavail: number; bsize: number };
};

const ABSENT: RootProbe = { exists: false, writable: false, caseInsensitive: false, freeBytes: 0, collisions: [] };

/** Relative paths that only differ by case: two of them cannot both land on a case-folding filesystem. */
export function caseCollisions(relatives: string[]): string[] {
  const byFold = new Map<string, Set<string>>();
  for (const r of relatives) {
    const held = byFold.get(r.toLowerCase()) ?? new Set();
    held.add(r);
    byFold.set(r.toLowerCase(), held);
  }
  return [...byFold.values()].filter((s) => s.size > 1).flatMap((s) => [...s]).sort();
}

/** What a destination's roots are good for: somewhere to write, how much room, and what would fold together. */
export function probeRoots(roots: PathRootMap, paths: PortablePath[] = [], dep: ProbeFs = fs): Record<string, RootProbe> {
  const probes: Record<string, RootProbe> = {};
  for (const [name, dir] of Object.entries(roots)) {
    if (!dep.existsSync(dir)) { probes[name] = { ...ABSENT }; continue; }
    const probe = `.archi-probe-${process.pid}-a`;
    const mark = path.posix.join(dir, probe);
    let writable = false;
    let caseInsensitive = false;
    try {
      dep.writeFileSync(mark, '', { mode: 0o600 });
      writable = true;
      try { dep.statSync(path.posix.join(dir, probe.toUpperCase())); caseInsensitive = true; } catch { /* case is kept apart */ }
    } catch { /* not ours to write */ }
    try { dep.rmSync(mark, { force: true }); } catch { /* nothing to take back */ }
    let freeBytes = 0;
    try { const s = dep.statfsSync(dir); freeBytes = s.bavail * s.bsize; } catch { /* no reading of the free space */ }
    const collisions = caseInsensitive ? caseCollisions(paths.filter((p) => p.root === name).map((p) => p.relative)) : [];
    probes[name] = { exists: true, writable, caseInsensitive, freeBytes, collisions };
  }
  return probes;
}
