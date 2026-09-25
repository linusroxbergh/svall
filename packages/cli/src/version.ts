import { execFileSync } from 'node:child_process';
import { isRelease, releaseVersion, repoRoot } from '@archipelago/archid/release';

// archi runs from its clone, so the commit checked out there is its version; an installed release names its own
export function checkoutVersion(): string {
  if (isRelease()) return releaseVersion();
  try {
    return execFileSync('git', ['-C', repoRoot(), 'log', '-1', '--format=%h %cs'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return 'unknown';
  }
}
