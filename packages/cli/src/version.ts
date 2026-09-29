import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { isRelease, releaseVersion, repoRoot } from '@archipelago/archid/release';
import type { RunFrom } from '@archipelago/archid/setup';
import { DEFAULT_PREFIX } from '../../../scripts/install-release.mjs';

// archi runs from its clone, so the commit checked out there is its version; an installed release names its own
export function checkoutVersion(): string {
  if (isRelease()) return releaseVersion();
  try {
    return execFileSync('git', ['-C', repoRoot(), 'log', '-1', '--format=%h %cs'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return 'unknown';
  }
}

/** What this archi runs from, and setup points the daemons and the shims at: the release `current` names, or its checkout. */
export const currentRunFrom = (): RunFrom => (isRelease() ? { release: path.join(DEFAULT_PREFIX, 'current') } : { repoRoot: repoRoot() });
