import fs from 'node:fs';
import path from 'node:path';
import type { Blocker, GitGraph, HandoverEntity, TransferManifestV1 } from '@svall/protocol';
import type { GitRunner } from '../links/git.js';
import { GitFailure, repoPaths } from './git-graph.js';
import { holds } from './portable-path.js';
import { relocate, type Relocation } from './relocate.js';

const lines = (file: string): string[] => {
  try { return fs.readFileSync(file, 'utf8').split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#')); } catch { return []; }
};

/**
 * What a carried repository keeps by a path that a move between homes would leave naming the source. `git worktree repair`
 * rewrites each linked worktree's gitfile and the registration naming it; anything else is refused, never rewritten.
 */
export async function relocationBlockers(graphs: readonly GitGraph[], r: Relocation, git: GitRunner): Promise<Blocker[]> {
  if (r.from === r.to) return [];
  const moves = (p: string): boolean => relocate(p, r) !== p;
  const out: Blocker[] = [];
  for (const g of graphs) {
    const entity: HandoverEntity = { kind: 'git', id: g.id };
    const refuse = (message: string): void => { out.push({ code: 'path_unsupported', message, entity }); };
    const checkouts = [...(g.main ? [g.main] : []), ...g.worktrees];
    // a submodule's gitfile and core.worktree name each other by paths relative to the checkout holding it
    const places = [g.commonDir, ...checkouts.map((c) => c.path)];
    if (places.some(moves) && !places.every(moves) && checkouts.some((c) => fs.existsSync(path.join(c.path, '.gitmodules')))) {
      refuse(`${g.commonDir}: its submodules find their Git directories by paths relative to each checkout, which break when ${places.filter(moves).join(', ')} moves into ${r.to} and ${places.filter((p) => !moves(p)).join(', ')} keeps its path; keep the repository and its worktrees together inside ${r.from} or outside it`);
    }
    if (g.main && g.main.gitDir !== path.join(g.main.path, '.git')) {
      const named = /^gitdir: (.*)$/m.exec(lines(path.join(g.main.path, '.git'))[0] ?? '')?.[1];
      if (named && path.isAbsolute(named) && moves(named)) {
        refuse(`${g.main.path}/.git names its Git directory ${named} by its full path, which git worktree repair leaves as it is in a main checkout; make it relative, or keep the repository outside ${r.from}`);
      }
    }
    let found: Awaited<ReturnType<typeof repoPaths>>;
    try { found = await repoPaths(g.commonDir, checkouts, git); } catch (e) {
      if (!(e instanceof GitFailure)) throw e;
      out.push({ code: 'worktree_unresolved', message: e.message, entity });
      continue;
    }
    const { settings, gitDirs } = found;
    // every checkout reads the repository's own config, which is named once, where it is first read
    const named = new Set<string>();
    for (const s of settings) {
      const conditional = s.key.startsWith('includeif.');
      const at = conditional ? s.key.slice(s.key.indexOf(':') + 1, -'.path'.length) : s.value;
      if (!path.isAbsolute(at) || !moves(at) || named.has(`${s.key}\n${s.value}`)) continue;
      named.add(`${s.key}\n${s.value}`);
      refuse(`${s.at}: ${conditional ? `its config includes ${s.value} when the Git directory lies in ${at}` : `${s.key} names ${at}`}, a path in ${r.from} that would still name the source once the repository moves to ${r.to}; make it relative, or remove it from the repository's config`);
    }
    for (const dir of [g.commonDir, ...gitDirs]) {
      const objects = path.join(dir, 'objects');
      for (const alternate of lines(path.join(objects, 'info', 'alternates')).map((l) => path.resolve(objects, l))) {
        if (holds(g.commonDir, alternate) || !moves(alternate)) continue;
        refuse(`${dir} borrows objects from ${alternate}, outside the repository, which the handover does not carry to ${r.to}; run git repack -a -d there, then delete objects/info/alternates`);
      }
    }
  }
  return out;
}

/**
 * The places of each carried graph on the source that move, with where each lands: none may be on the destination too,
 * where `git worktree repair` would link the copy to it and point a worktree kept there at the copy.
 */
export function stalePlaces(sent: Pick<TransferManifestV1, 'home' | 'destinationHome' | 'git'>): { graph: string; path: string; lands: string }[] {
  const r: Relocation = { from: sent.home, to: sent.destinationHome };
  return (sent.git ?? []).flatMap((g) => [g.commonDir, ...g.worktrees.map((w) => w.path)]
    .map((p) => ({ graph: g.id, path: p, lands: relocate(p, r) })).filter((x) => x.lands !== x.path));
}

/** A blocker for each place `stalePlaces` names that `present` says `where` holds. */
export const staleBlockers = (sent: Pick<TransferManifestV1, 'home' | 'destinationHome' | 'git'>, where: string, present: (p: string) => boolean): Blocker[] =>
  stalePlaces(sent).filter((s) => present(s.path)).map((s) => ({
    code: 'path_unsupported', entity: { kind: 'git', id: s.graph },
    message: `${s.path} is on ${where} as well, and git worktree repair would tie the copy that lands at ${s.lands} to it; move ${s.path} aside on ${where} first`,
  }));
