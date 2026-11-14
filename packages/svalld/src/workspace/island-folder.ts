import os from 'node:os';
import path from 'node:path';
import type { FleetState, Robot } from '@svall/protocol';
import { Invalid } from '../errors.js';
import { clean, holds } from '../path-tools.js';

/** `p` as `~/…` when it lies under one of `homes`, so each machine reads it under its own; any other path stays as it is. */
export function homeRelative(p: string, homes: string[]): string {
  const q = clean(p);
  if (q === '~' || q.startsWith('~/')) return q;
  const home = homes.map(clean).find((h) => holds(h, q));
  if (!home) return q;
  return q === home ? '~' : `~/${path.posix.relative(home, q)}`;
}

/** This machine's home and each listed machine's. */
export const homesOf = (state: FleetState, homedir = os.homedir()): string[] =>
  [...new Set([homedir, ...Object.values(state.machines ?? {}).flatMap((m) => (m.home ? [m.home] : []))])];

/** Where a new robot starts when it takes this one's directory: the repo itself, never the worktree it sits in. */
export const startOf = (c: Robot): string => (c.repo?.isWorktree ? c.repo.mainRoot : c.cwd);

/** The folder a person typed for an island, as it is stored. */
export function islandFolder(typed: string, state: FleetState, homedir = os.homedir()): string {
  const v = typed.trim();
  if (v !== '~' && !v.startsWith('~/') && !path.posix.isAbsolute(v)) throw new Invalid('folder must be an absolute path or start with ~');
  return homeRelative(v, homesOf(state, homedir));
}

/** The folders island `islandId`'s robots start from, each spelled from its own machine's home, the most robots first. */
export function memberStarts(state: FleetState, islandId: string, homedir = os.homedir()): string[] {
  const counts = new Map<string, number>();
  for (const c of Object.values(state.robots)) {
    if (c.islandId !== islandId) continue;
    // a machine the fleet does not list is the home, which holds no record of itself
    const home = (c.machine && state.machines?.[c.machine]?.home) || homedir;
    const at = homeRelative(startOf(c), [home]);
    counts.set(at, (counts.get(at) ?? 0) + 1);
  }
  return [...counts].sort((a, b) => b[1] - a[1]).map(([p]) => p);
}
