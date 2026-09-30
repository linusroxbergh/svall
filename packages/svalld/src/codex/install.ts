import os from 'node:os';
import path from 'node:path';
import { CODEX_HOOKS } from '../hooks/receiver.js';
import { isOurs } from '../paths.js';
import { shq } from '../text.js';

export type CodexPaths = { dir: string; config: string; hooks: string };

/** Where Codex keeps its files: CODEX_HOME, else ~/.codex. */
export function codexPaths(env: NodeJS.ProcessEnv = process.env, home: string = os.homedir()): CodexPaths {
  const dir = env.CODEX_HOME ? path.resolve(env.CODEX_HOME) : path.join(home, '.codex');
  return { dir, config: path.join(dir, 'config.toml'), hooks: path.join(dir, 'hooks.json') };
}

type Entry = { type: string; command?: string; timeout?: number; additionalContextLimit?: number };
type Group = { matcher?: string; hooks?: Entry[] };

// codex trusts a hook by the hash of its definition: a checkout names no node an upgrade would move, and the app names
// its own node, whose path an update keeps
export const codexHookCommand = (script: string, node?: string): string =>
  `[ -z "$SVALL_CHAR_ID" ] || { ${node ? `n=${shq(node)}; [ -x "$n" ] || n=node; "$n"` : 'node'} ${shq(script)} codex "$PPID"; }`;

// SessionEnd and Interrupt are capped at 3 s. The two events the daemon answers carry the whole brief, which codex
// would otherwise cut to a preview past its spill threshold
const entryFor = (ev: string, command: string): Entry => ({
  type: 'command', command, timeout: ev === 'SessionEnd' || ev === 'Interrupt' ? 3 : 10,
  ...(ev === 'SessionStart' || ev === 'UserPromptSubmit' ? { additionalContextLimit: 0 } : {}),
});

// a matcher is a regex on codex and is ignored outright for several events, so a match-all group has none
export function mergeCodexHooks(current: Record<string, unknown>, command: string, script: string): Record<string, unknown> {
  const out = structuredClone(current);
  const hooks = ((out.hooks ??= {}) as Record<string, Group[]>);
  for (const ev of CODEX_HOOKS) {
    const groups = (hooks[ev] ??= []);
    const ours = groups.flatMap((g) => g.hooks ?? []).filter((h) => isOurs(h.command, script));
    for (const h of ours) Object.assign(h, entryFor(ev, command));
    if (!ours.length) groups.push({ hooks: [entryFor(ev, command)] });
  }
  return out;
}

// any of the events will do; an event added since is left to the out-of-date check
export function codexInstalled(current: Record<string, unknown>, script: string): boolean {
  const hooks = (current.hooks ?? {}) as Record<string, Group[]>;
  return CODEX_HOOKS.some((ev) => (hooks[ev] ?? []).some((g) => (g.hooks ?? []).some((h) => isOurs(h.command, script))));
}
