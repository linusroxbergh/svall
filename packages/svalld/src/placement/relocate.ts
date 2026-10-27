import path from 'node:path';
import { clean, holds } from '../path-tools.js';

/**
 * A move between two homes: a path under `from` lands at the same place under `to`, and any other keeps its absolute
 * path. Paths are compared as `clean` spells them, with no `..`, `//` or trailing slash.
 */
export type Relocation = { from: string; to: string };

export function relocate(p: string, r: Relocation): string {
  const q = clean(p);
  return holds(clean(r.from), q) ? path.posix.join(clean(r.to), path.posix.relative(r.from, q)) : q;
}
