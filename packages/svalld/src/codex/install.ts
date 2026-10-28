import os from 'node:os';
import path from 'node:path';
import { HOOK_GUARD, helperOr, nodeRun } from '../paths.js';
import { shq } from '../text.js';

export type CodexPaths = { dir: string; config: string; hooks: string };

export function codexPaths(env: NodeJS.ProcessEnv = process.env, home: string = os.homedir()): CodexPaths {
  const dir = env.CODEX_HOME ? path.resolve(env.CODEX_HOME) : path.join(home, '.codex');
  return { dir, config: path.join(dir, 'config.toml'), hooks: path.join(dir, 'hooks.json') };
}

// where AppArmor says whether it restricts user namespaces, which Codex runs each command in through bwrap
export const USERNS_RESTRICTED = '/proc/sys/kernel/apparmor_restrict_unprivileged_userns';

// Codex's documented Ubuntu 24.04 fix (learn.chatgpt.com/docs/sandboxing): the profile that lets /usr/bin/bwrap make user namespaces
export const BWRAP_PROFILE = 'sudo apt install bubblewrap apparmor-profiles, sudo install -m 0644 /usr/share/apparmor/extra-profiles/bwrap-userns-restrict /etc/apparmor.d/, then sudo apparmor_parser -r /etc/apparmor.d/bwrap-userns-restrict';
// the same, as one line to type
export const BWRAP_COMMAND = 'sudo apt install bubblewrap apparmor-profiles && sudo install -m 0644 /usr/share/apparmor/extra-profiles/bwrap-userns-restrict /etc/apparmor.d/ && sudo apparmor_parser -r /etc/apparmor.d/bwrap-userns-restrict';

// codex trusts a hook by the hash of its definition: a checkout names no node an upgrade would move, and the app names
// its own node, whose path an update keeps
export const codexHookCommand = (script: string, node?: string): string =>
  `${HOOK_GUARD} { ${helperOr(script, 'codex "$PPID"', node ? nodeRun(node, script) : `node ${shq(script)}`)}; }`;
