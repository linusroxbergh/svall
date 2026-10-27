import { execFileSync } from 'node:child_process';
import path from 'node:path';

export const hasGit = (() => {
  try { execFileSync('git', ['--version'], { stdio: 'ignore' }); return true; } catch { return false; }
})();

/** git with the fixture's identity and without the machine's own configuration. */
export function git(base: string, cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'user.name=Probe', '-c', 'user.email=probe@example.com', '-c', 'commit.gpgsign=false',
    '-c', 'init.defaultBranch=main', '-c', 'protocol.file.allow=always', ...args], {
    cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, GIT_CONFIG_GLOBAL: path.join(base, 'gitconfig'), GIT_CONFIG_NOSYSTEM: '1' },
  }).replace(/\n$/, '');
}
