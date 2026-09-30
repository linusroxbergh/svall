import { execFile } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';

const MARK = '__SVALL_ENV__';
// where agents are found, and where Claude Code and Codex keep their files
const NAMES = ['PATH', 'CLAUDE_CONFIG_DIR', 'CODEX_HOME'] as const;
// printenv reads exported values, which fish joins with colons like every other shell; an unset one prints nothing
const COMMAND = `echo ${MARK}; ${NAMES.map((n) => `/usr/bin/printenv ${n}; echo ${MARK}`).join('; ')}`;

export type LoginEnv = Partial<Record<(typeof NAMES)[number], string>> & { PATH: string };

export const FALLBACK_DIRS = (homedir = os.homedir()): string[] => [
  '/opt/homebrew/bin', '/usr/local/bin', path.join(homedir, '.local/bin'), path.join(homedir, '.bun/bin'),
  path.join(homedir, '.npm-global/bin'), '/usr/bin', '/bin', '/usr/sbin', '/sbin',
];

/** What the user's login shell exports that setup needs; an app opened from Finder has only launchd's environment. */
export function loginEnv(o: { shell: string; timeoutMs: number; fallback: string[] }): Promise<LoginEnv> {
  return new Promise((resolve) => {
    execFile(o.shell, ['-l', '-i', '-c', COMMAND], { timeout: o.timeoutMs, killSignal: 'SIGKILL', env: { ...process.env, TERM: 'dumb' } }, (_err, stdout) => {
      const parts = String(stdout ?? '').split(MARK);
      const values = parts.length >= NAMES.length + 2 ? parts.slice(1, NAMES.length + 1).map((p) => p.trim()) : [];
      const env: LoginEnv = { PATH: values[0] || o.fallback.join(':') };
      NAMES.forEach((n, i) => { if (i && values[i]) env[n] = values[i]; });
      resolve(env);
    });
  });
}
