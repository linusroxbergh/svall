import { execFileSync } from 'node:child_process';
import { repoRoot } from '@svall/svalld/paths';
import { bundledVersion } from '@svall/svalld/runtime';

// the app's bundle carries the version it was built as; a checkout's is the commit checked out there
export function checkoutVersion(): string {
  if (bundledVersion) return bundledVersion;
  try {
    return execFileSync('git', ['-C', repoRoot(), 'log', '-1', '--format=%h %cs'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return 'unknown';
  }
}
