import fs from 'node:fs';
import path from 'node:path';

const trim = (p: string): string => (p.length > 1 && p.endsWith('/') ? p.slice(0, -1) : p);

/** Whether `p` is `root` or lies under it, on a component boundary. */
export const holds = (root: string, p: string): boolean => p === root || p.startsWith(root === '/' ? '/' : `${root}/`);

/** The real path of `p`, spelled as the disk stores it, or of the deepest part of it that exists with the rest joined back on. */
export function realPath(p: string, realpath: (p: string) => string = (q) => fs.realpathSync.native(q)): string {
  const tail: string[] = [];
  let head = p;
  for (;;) {
    try { return path.posix.join(realpath(head), ...tail); } catch { /* keep walking up */ }
    const parent = path.posix.dirname(head);
    if (parent === head) return p;
    tail.unshift(path.posix.basename(head));
    head = parent;
  }
}

export const clean = (p: string): string => trim(path.posix.normalize(p));
