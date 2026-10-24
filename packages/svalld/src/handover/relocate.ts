import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { Blocker, TransferManifestV1 } from '@svall/protocol';
import { docsDir, repoRootOf, repoSlug } from '../docs.js';
import { clean, fieldValues, holds, PATH_FIELDS, type PortableForm } from './portable-path.js';

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

// a portable field's value where it lies after the move, or undefined for one that names no path there
function moved(form: PortableForm, value: unknown, parent: Record<string | number, unknown>, r: Relocation): string | undefined {
  if (typeof value !== 'string') return undefined;
  if (form === 'context' && parent.kind !== 'file' && parent.kind !== 'folder') return undefined;
  if (form !== 'file-url') return relocate(value, r);
  if (!value.startsWith('file:')) return undefined;
  let url: URL;
  let p: string;
  // a file: URL naming another host is no path on either machine
  try { url = new URL(value); p = fileURLToPath(url); } catch { return undefined; }
  const there = relocate(p, r);
  if (there === p) return undefined;
  url.pathname = pathToFileURL(there).pathname;
  return url.href;
}

/**
 * The manifest as its destination reads it: `home` the destination's, and every root, Git place and portable path of
 * the state and fleet.json where it lies there. Links are carried as their text, and sessions place their transcripts.
 */
export function destinationView(m: TransferManifestV1): TransferManifestV1 {
  const r: Relocation = { from: m.home, to: m.destinationHome };
  if (r.from === r.to) return m;
  // a root or Git place not spelled plainly stays as sent, for the checks to refuse as they would between equal homes
  const at = (p: string): string => (path.posix.normalize(p) === p && !p.endsWith('/') ? relocate(p, r) : p);
  const docs = { FleetState: structuredClone(m.snapshot), FleetConfig: structuredClone(m.fleet) };
  for (const [field, spec] of Object.entries(PATH_FIELDS)) {
    if (spec.classification !== 'portable' || spec.form === 'transcript') continue;
    const doc = docs[field.slice(0, field.indexOf('.')) as keyof typeof docs];
    for (const { value, parent, key } of fieldValues(doc, field)) {
      const there = moved(spec.form, value, parent, r);
      if (there !== undefined) parent[key] = there;
    }
  }
  return {
    ...m,
    home: m.destinationHome,
    snapshot: docs.FleetState,
    fleet: docs.FleetConfig,
    roots: m.roots.map((root) => ({ ...root, path: at(root.path) })),
    ...(m.git && {
      git: m.git.map((g) => ({
        ...g,
        commonDir: at(g.commonDir),
        ...(g.main && { main: { ...g.main, path: at(g.main.path), gitDir: at(g.main.gitDir) } }),
        worktrees: g.worktrees.map((w) => ({ ...w, path: at(w.path), gitDir: at(w.gitDir) })),
        unused: g.unused.map((u) => ({ ...u, path: at(u.path) })),
        ...(g.commands && { commands: g.commands.map((c) => ({ ...c, at: at(c.at) })) }),
      })),
    }),
  };
}

/**
 * The repository docs folders a move between homes renames, relative to the docs root: each is named for its main root's
 * path, so the folder a character's repository or folder names on the source is named for where that lands.
 */
export function docsRenames(sent: Pick<TransferManifestV1, 'home' | 'destinationHome' | 'snapshot'>): { from: string; to: string }[] {
  const r: Relocation = { from: sent.home, to: sent.destinationHome };
  const renames = new Map<string, string>();
  for (const c of Object.values(sent.snapshot.characters)) {
    const root = repoRootOf(c, sent.home);
    const there = root && relocate(root, r);
    if (root && there !== root) renames.set(docsDir('', 'repo', repoSlug(root)), docsDir('', 'repo', repoSlug(there!)));
  }
  return [...renames].map(([from, to]) => ({ from, to }));
}

/** A docs folder the move renames whose new name the carried docs hold as well. */
export function docsBlockers(sent: Pick<TransferManifestV1, 'home' | 'destinationHome' | 'snapshot' | 'roots'>): Blocker[] {
  const docs = sent.roots.find((r) => r.kind === 'docs');
  if (!docs) return [];
  const held = (dir: string): boolean => docs.files.some((f) => holds(dir, f.path));
  return docsRenames(sent).filter(({ from, to }) => held(from) && held(to)).map(({ from, to }) => ({
    code: 'path_unsupported', entity: { kind: 'root', id: docs.id },
    message: `${docs.path} holds ${to} as well as ${from}, which the handover renames to it where the fleet lands; move one of them out of ${docs.path}`,
  }));
}
