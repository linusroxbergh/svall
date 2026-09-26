import fs from 'node:fs';
import path from 'node:path';
import type { RootProbe } from '@archipelago/protocol';

export type ProbeFs = {
  existsSync(p: string): boolean;
  writeFileSync(p: string, data: string, options: { mode: number }): void;
  statSync(p: string): unknown;
  rmSync(p: string, options: { force: boolean }): void;
  statfsSync(p: string): { bavail: number; bsize: number };
};

const ABSENT: RootProbe = { exists: false, writable: false, caseInsensitive: false, freeBytes: 0 };

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

/** What each folder a destination writes into is good for: somewhere to write, how much room, and whether it folds case. */
export function probeFolders(folders: readonly string[], dep: ProbeFs = fs): Record<string, RootProbe> {
  const probes: Record<string, RootProbe> = {};
  for (const dir of folders) {
    if (!dep.existsSync(dir)) { probes[dir] = { ...ABSENT }; continue; }
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
    probes[dir] = { exists: true, writable, caseInsensitive, freeBytes };
  }
  return probes;
}
