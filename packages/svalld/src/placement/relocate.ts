import path from 'node:path';
import { clean, holds } from '../path-tools.js';

/**
 * A handover between two homes: a path under `from` lands at the same place under `to`, and any other keeps its absolute
 * path. Homes and paths are read as the inventory reads them, with no `..`, `//` or trailing slash.
 */
export type Relocation = { from: string; to: string };

export function relocate(p: string, r: Relocation): string {
  const q = clean(p);
  return holds(clean(r.from), q) ? path.posix.join(clean(r.to), path.posix.relative(r.from, q)) : q;
}

/**
 * Why `p` cannot move by `r`: it lies in `to` but not in `from`, so it keeps a path one under `from` lands on, and the
 * way back would move it under `from`. These are the only paths the swap does not invert, and the only ones two paths can share.
 */
export function relocationProblem(p: string, r: Relocation): string | undefined {
  const q = clean(p);
  return !holds(clean(r.from), q) && holds(clean(r.to), q)
    ? `${p} lies in the destination's home ${r.to} but not in the source's home ${r.from}, so it would land where a path of the source's home lands and come back elsewhere; move it into ${r.from} or out of ${r.to}`
    : undefined;
}
