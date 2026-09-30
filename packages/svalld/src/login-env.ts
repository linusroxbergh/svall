import { execFile } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';

const MARK = '__SVALL_ENV__';
// where agents are found, and where Claude Code and Codex keep their files
const NAMES = ['PATH', 'CLAUDE_CONFIG_DIR', 'CODEX_HOME'] as const;
// printenv reads exported values, which fish joins with colons like every other shell; an unset one prints nothing
const COMMAND = `echo ${MARK}; ${NAMES.map((n) => `/usr/bin/printenv ${n}; echo ${MARK}`).join('; ')}`;

export type LoginEnv = Partial<Record<(typeof NAMES)[number], string>> & { PATH: string };

const FALLBACK_DIRS = (homedir = os.homedir()): string[] => [
  '/opt/homebrew/bin', '/usr/local/bin', path.join(homedir, '.local/bin'), path.join(homedir, '.bun/bin'),
  path.join(homedir, '.npm-global/bin'), '/usr/bin', '/bin', '/usr/sbin', '/sbin',
];

/** What the user's login shell exports that setup needs, or undefined when it fails or does not answer in time. */
export function loginEnv(o: { shell: string; timeoutMs: number }): Promise<LoginEnv | undefined> {
  return new Promise((resolve) => {
    execFile(o.shell, ['-l', '-i', '-c', COMMAND], { timeout: o.timeoutMs, killSignal: 'SIGKILL', env: { ...process.env, TERM: 'dumb' } }, (_err, stdout) => {
      const parts = String(stdout ?? '').split(MARK);
      const values = parts.length >= NAMES.length + 2 ? parts.slice(1, NAMES.length + 1).map((p) => p.trim()) : [];
      if (!values[0]) return resolve(undefined);
      const env: LoginEnv = { PATH: values[0] };
      NAMES.forEach((n, i) => { if (i && values[i]) env[n] = values[i]; });
      resolve(env);
    });
  });
}

/** Puts the login shell's environment into this process, as an app opened from Finder has only launchd's, with the usual
 *  folders standing in for a shell that does not answer; whether it answered. */
export async function takeLoginEnv(): Promise<boolean> {
  const env = await loginEnv({ shell: process.env.SHELL || '/bin/zsh', timeoutMs: 5000 });
  Object.assign(process.env, env ?? { PATH: FALLBACK_DIRS().join(':') });
  return env !== undefined;
}
