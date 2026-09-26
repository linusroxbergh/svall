import path from 'node:path';
import {
  FleetConfig, FleetState,
  type AgentKind, type Blocker, type HandoverEntity, type LandedRoot, type TransferFile, type TransferManifestV1, type TransferRoot,
} from '@archipelago/protocol';
import { markDormant, markSlotDormant } from '../reconcile.js';
import { diverged, proveReplica, type Divergence } from './divergence.js';
import { mapThroughRoots } from './git-repair.js';
import { CONTROL } from './inventory.js';
import type { ScanFs } from './manifest.js';
import { exportSnapshot, holdingRoot, holds, mapPortablePath, portablePathValues, realPath, rewrite } from './portable-path.js';
import { relativeProblem } from './replicas.js';
import { placeFile } from './sessions/registry.js';

/** Whether `p` lies inside one of `dirs`, each side read by its real path. */
export function within(p: string, dirs: readonly string[]): boolean {
  const real = realPath(path.posix.resolve(p));
  return dirs.some((d) => holds(realPath(path.posix.resolve(d)), real));
}

const absoluteProblem = (p: string | undefined): string | undefined =>
  (p !== undefined && p.startsWith('/') && !relativeProblem(p.slice(1)) ? undefined : `${JSON.stringify(p)} is not a plain absolute path`);

function filesProblem(files: readonly TransferFile[], entry: TransferRoot['entry']): string | undefined {
  const seen = new Set<string>();
  for (const f of files) {
    const bad = entry === 'file' ? (f.path === '' ? undefined : 'lies under a file') : relativeProblem(f.path);
    if (bad) return `${JSON.stringify(f.path)} ${bad}`;
    if (f.type === 'symlink' && CONTROL.test(f.target)) return `${JSON.stringify(f.path)} links to a path holding a control character`;
    if (seen.has(f.path)) return `${JSON.stringify(f.path)} is listed twice`;
    seen.add(f.path);
  }
  return undefined;
}

/** The destination path root a manifest maps `sourcePath` through, by name and folder. */
function mappedRoot(m: TransferManifestV1, sourcePath: string): { name: string; dir: string } | undefined {
  const name = holdingRoot(sourcePath, m.sourceRoots)?.root;
  return name !== undefined && Object.hasOwn(m.destinationRoots, name) ? { name, dir: m.destinationRoots[name] } : undefined;
}

/**
 * Every path the manifest and the transfer name, read again here: absolute ones plain, the rest plain relative
 * paths under their root, no control character anywhere, each root where the path roots put it and, by its
 * real path, inside the destination root it is mapped through.
 */
export function manifestProblems(m: TransferManifestV1, landed: readonly LandedRoot[]): Blocker[] {
  const blockers: Blocker[] = [];
  const bad = (entity: HandoverEntity, message: string) => blockers.push({ code: 'path_unsupported', message, entity });
  const map = mapThroughRoots(m);
  const ids = new Set<string>();
  for (const r of m.roots) {
    const entity: HandoverEntity = { kind: 'root', id: r.id };
    if (ids.has(r.id)) bad(entity, `the manifest names root ${r.id} twice`);
    ids.add(r.id);
    const problem = absoluteProblem(r.sourcePath) ?? absoluteProblem(r.destinationPath) ?? filesProblem(r.files, r.entry);
    if (problem) { bad(entity, `${r.destinationPath}: ${problem}`); continue; }
    let mapped: string;
    try { mapped = map(r.sourcePath); } catch (e) { bad(entity, (e as Error).message); continue; }
    if (mapped !== r.destinationPath) { bad(entity, `${r.destinationPath} is not where the path roots put ${r.sourcePath}, which is ${mapped}`); continue; }
    const root = mappedRoot(m, r.sourcePath)!;
    if (!r.foldedInto && !within(r.destinationPath, [root.dir])) {
      bad(entity, `${r.destinationPath} leads to ${realPath(r.destinationPath)}, outside the path root ${root.name} (${root.dir})`);
    }
  }
  for (const x of landed) {
    const root = m.roots.find((r) => r.id === x.id);
    const problem = root ? filesProblem(x.files, root.entry) : 'is no root the manifest carries';
    if (problem) bad({ kind: 'root', id: x.id }, `what the transfer verified in ${root?.destinationPath ?? x.id}: ${problem}`);
  }
  for (const s of m.sessions) {
    const problem = absoluteProblem(s.destinationHome) ?? absoluteProblem(s.destinationPath) ?? filesProblem(s.files, 'dir');
    if (problem) bad({ kind: 'character', id: s.characterId }, `session ${s.sessionId}: ${problem}`);
  }
  for (const g of m.git ?? []) {
    const places = [g.commonDir, ...(g.main ? [g.main.path, g.main.gitDir] : []), ...g.worktrees.flatMap((w) => [w.path, w.gitDir])];
    const problem = places.map(absoluteProblem).find(Boolean);
    if (problem) bad({ kind: 'git', id: g.id }, problem);
  }
  return blockers;
}

/** Every place a Git repair writes, by its real path inside a root this handover carried here. */
export function gitProblems(m: TransferManifestV1, carried: readonly string[]): Blocker[] {
  const map = mapThroughRoots(m);
  const blockers: Blocker[] = [];
  for (const g of m.git ?? []) {
    const entity: HandoverEntity = { kind: 'git', id: g.id };
    for (const p of [g.commonDir, ...(g.main ? [g.main.path, g.main.gitDir] : []), ...g.worktrees.flatMap((w) => [w.path, w.gitDir])]) {
      let at: string;
      try { at = map(p); } catch (e) { blockers.push({ code: 'worktree_unresolved', message: (e as Error).message, entity }); continue; }
      if (!within(at, carried)) blockers.push({ code: 'path_unsupported', message: `${at} lies outside every root this handover carried here`, entity });
    }
  }
  return blockers;
}

/**
 * Where each session would be written: under the agent home this machine reports for its kind and, by real
 * path, nowhere else.
 */
export function sessionProblems(m: TransferManifestV1, homes: Partial<Record<AgentKind, string>>): Blocker[] {
  const blockers: Blocker[] = [];
  for (const s of m.sessions) {
    const entity: HandoverEntity = { kind: 'character', id: s.characterId };
    const home = homes[s.agent];
    if (!home || s.destinationHome !== home) {
      blockers.push({ code: 'agent_cli_missing', message: `${s.agent} keeps its sessions in ${home ?? 'no home'} on this machine, not ${s.destinationHome}`, entity });
      continue;
    }
    if (!s.sourceHome || !s.destinationPath) {
      blockers.push({ code: 'incompatible_adapter', message: `session ${s.sessionId} has no place on this machine`, entity });
      continue;
    }
    const [from, to] = [path.posix.relative(s.sourceHome, s.sourcePath), path.posix.relative(home, s.destinationPath)];
    const out = [s.destinationPath, ...s.files.map((f) => path.posix.join(home, placeFile(f.path, from, to)))].find((p) => !within(p, [home]));
    if (out) blockers.push({ code: 'path_unsupported', message: `${out} leaves ${home}`, entity });
  }
  return blockers;
}

const counted = (d: Divergence): string => (['added', 'removed', 'changed', 'unchecked'] as const)
  .filter((k) => d[k].count > 0)
  .map((k) => `${d[k].count} ${k} (${d[k].preview.join(', ')}${d[k].count > d[k].preview.length ? ', …' : ''})`)
  .join('; ');

/** Whether a root holds what the transfer verified in it, read as its source was: excludes left out, a Git index by what it stages. */
export async function landedProblem(
  root: TransferRoot, at: string, verified: readonly TransferFile[], excludes: readonly string[], sfs?: ScanFs, ignore?: (relative: string) => boolean,
): Promise<Blocker | undefined> {
  const { divergence } = await proveReplica(at, [verified], excludes, sfs, root.kind, ignore);
  if (!diverged(divergence)) return undefined;
  return { code: 'destination_diverged', message: `${at} no longer holds what the transfer verified: ${counted(divergence)}`, entity: { kind: 'root', id: root.id } };
}

export type Imported = { state: FleetState; fleet: FleetConfig; blockers: Blocker[] };

/**
 * The manifest's snapshot and fleet.json as this machine runs them, at the current schema: every registered
 * path rewritten through the named roots and held inside its root by real path, and every terminal dormant
 * with no tmux ids and the command that resumes its agent. Transcripts are placed by the sessions carrying them.
 */
export function importState(m: TransferManifestV1): Imported {
  const blockers: Blocker[] = [];
  const state = exportSnapshot(FleetState.parse(m.snapshot));
  for (const c of Object.values(state.characters)) {
    // a terminal this handover did not rest, such as one closed for idleness, keeps the resume it went dormant with, flags and all
    const [kept, keptSecond] = [c, c.second].map((t) => (t && t.restedBy !== m.transactionId && t.revive?.command ? t.revive : undefined));
    markDormant(c);
    if (kept) c.revive = kept;
    if (c.second) markSlotDormant(c.second);
    if (c.second && keptSecond) c.second.revive = keptSecond;
  }
  const fleet = FleetConfig.parse(structuredClone(m.fleet));
  const docs = { FleetState: state, FleetConfig: fleet };
  for (const v of portablePathValues(docs, m.sourceRoots.home)) {
    if (v.form === 'transcript') continue;
    const entity: HandoverEntity | undefined = v.field.startsWith('FleetState.characters.') ? { kind: 'character', id: String(v.pointer[1]) } : undefined;
    const root = mappedRoot(m, v.path);
    if (!root) {
      blockers.push({ code: 'path_root_missing', message: `no path root of this machine holds ${v.path}`, ...(entity && { entity }) });
      continue;
    }
    let mapped: string;
    try { mapped = mapPortablePath(holdingRoot(v.path, m.sourceRoots)!, m.destinationRoots); } catch (e) {
      blockers.push({ code: 'path_unsupported', message: (e as Error).message, ...(entity && { entity }) });
      continue;
    }
    if (!within(mapped, [root.dir])) {
      blockers.push({ code: 'path_unsupported', message: `${mapped} leads to ${realPath(mapped)}, outside the path root ${root.name} (${root.dir})`, ...(entity && { entity }) });
      continue;
    }
    rewrite(docs, v, mapped, m.destinationRoots.home);
  }
  return { state: FleetState.parse(state), fleet: FleetConfig.parse(fleet), blockers };
}

