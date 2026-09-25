import fs from 'node:fs';
import path from 'node:path';
import { WorkspaceError } from './errors.js';

export const within = (p: string, root: string): boolean => p === root || p.startsWith(root.endsWith(path.sep) ? root : root + path.sep);

const inGit = (root: string, p: string): boolean => path.relative(root, p).split(path.sep).some((s) => s.toLowerCase() === '.git');

// lstat answers ENOTDIR, not ENOENT, for a path under a file
const there = (p: string): boolean => { try { return !!fs.lstatSync(p, { throwIfNoEntry: false }); } catch { return false; } };

// where `p` really is, judged by its closest ancestor that exists so a file about to be created counts by its folder.
// lstat sees a link that leads nowhere, and such a link has no real path: a write would follow it out
export function realOf(p: string): string | undefined {
  let cur = p;
  while (!there(cur)) cur = path.dirname(cur);
  try { return fs.realpathSync(cur); } catch { return undefined; }
}

/**
 * The absolute path `rel` names under `root`, refused when dots or a symlink take it outside,
 * or into a .git at any depth: a listing hides .git, so no name or link reaches it either.
 */
export function inside(root: string, rel: string): string {
  root = path.resolve(root);
  const abs = path.resolve(root, rel);
  const out = () => new WorkspaceError('invalid', `${rel || '.'} is outside the character's root`);
  if (path.isAbsolute(rel) || !within(abs, root)) throw out();
  let realRoot: string;
  try { realRoot = fs.realpathSync(root); } catch { throw new WorkspaceError('not_found', `${root} is gone`); }
  const real = realOf(abs);
  if (!real || !within(real, realRoot)) throw out();
  if (inGit(root, abs) || inGit(realRoot, real)) throw new WorkspaceError('invalid', `${rel} is in .git`);
  return abs;
}
