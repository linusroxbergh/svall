import { execFileSync } from 'node:child_process';
import { isRelease, releaseVersion, repoRoot } from '@svall/svalld/release';
import { bundledVersion } from '@svall/svalld/runtime';

// the app's bundle carries the version it was built as, and an installed release names its own; a checkout's is the commit checked out there
export function checkoutVersion(): string {
  if (bundledVersion) return bundledVersion;
  if (isRelease()) return releaseVersion();
  try {
    return execFileSync('git', ['-C', repoRoot(), 'log', '-1', '--format=%h %cs'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return 'unknown';
  }
}
