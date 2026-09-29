import { execFileSync } from 'node:child_process';
import { repoRoot } from '@svall/svalld/paths';

// svall runs from its clone, so the commit checked out there is its version
export function checkoutVersion(): string {
  try {
    return execFileSync('git', ['-C', repoRoot(), 'log', '-1', '--format=%h %cs'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return 'unknown';
  }
}
