import os from 'node:os';
import path from 'node:path';
import { HOOK_GUARD, helperOr } from '../paths.js';
import { shq } from '../text.js';

export type CodexPaths = { dir: string; config: string; hooks: string };

/** Where Codex keeps its files: CODEX_HOME, else ~/.codex. */
export function codexPaths(env: NodeJS.ProcessEnv = process.env, home: string = os.homedir()): CodexPaths {
  const dir = env.CODEX_HOME ? path.resolve(env.CODEX_HOME) : path.join(home, '.codex');
  return { dir, config: path.join(dir, 'config.toml'), hooks: path.join(dir, 'hooks.json') };
}

// codex trusts a hook by the hash of its definition: a checkout names no node an upgrade would move, and the app names
// its own node, whose path an update keeps
export const codexHookCommand = (script: string, node?: string): string =>
  `${HOOK_GUARD} { ${helperOr(script, 'codex "$PPID"', `${node ? `n=${shq(node)}; [ -x "$n" ] || n=node; "$n"` : 'node'} ${shq(script)}`)}; }`;
