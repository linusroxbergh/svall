import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { Blocker, TransferManifestV1 } from '@svall/protocol';
import { docsDir, repoRootOf, repoSlug } from '../docs.js';
import { relocate, relocationProblem, type Relocation } from '../placement/relocate.js';
import { fieldValues, holds, PATH_FIELDS, type PortableForm } from './portable-path.js';

export { relocate, relocationProblem, type Relocation };

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
 * path, so the folder a robot's repository or folder names on the source is named for where that lands.
 */
export function docsRenames(sent: TransferManifestV1): { from: string; to: string }[] {
  const there = destinationView(sent).snapshot.robots;
  const renames = new Map<string, string>();
  for (const [id, c] of Object.entries(sent.snapshot.robots)) {
    const [from, to] = [repoRootOf(c, sent.home), repoRootOf(there[id], sent.destinationHome)];
    if (!from || !to || repoSlug(from) === repoSlug(to)) continue;
    renames.set(docsDir('', 'repo', repoSlug(from)), docsDir('', 'repo', repoSlug(to)));
  }
  return [...renames].map(([from, to]) => ({ from, to }));
}

/**
 * A docs folder the move cannot rename: its new name is one the carried docs hold, another folder takes too or another
 * rename leaves, or the folders lie behind a link.
 */
export function docsBlockers(sent: TransferManifestV1): Blocker[] {
  const docs = sent.roots.find((r) => r.kind === 'docs');
  if (!docs) return [];
  const entity = { kind: 'root' as const, id: docs.id };
  const held = (dir: string): boolean => docs.files.some((f) => holds(dir, f.path));
  const renames = docsRenames(sent);
  if (renames.length && docs.files.some((f) => f.path === 'repos' && f.type === 'symlink')) {
    return [{ code: 'path_unsupported', entity, message: `${docs.path}/repos is a link, so the handover cannot rename the folders in it for where the fleet lands; make it a folder` }];
  }
  return renames.filter((x) => held(x.from) && (held(x.to) || renames.some((y) => y !== x && (y.from === x.to || (y.to === x.to && held(y.from))))))
    .map(({ from, to }) => ({
      code: 'path_unsupported', entity,
      message: `${docs.path} holds ${from}, which the handover renames to ${to} where the fleet lands, a name ${held(to) ? 'it holds as well' : 'another of its folders takes or leaves'}; move one of them out of ${docs.path}`,
    }));
}
