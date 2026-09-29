import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const HOOK_SCRIPT = 'agent-hook.mjs';
// an install may still name the script claude-hook.mjs; that entry is ours to repair and remove too
const HOOK_NAMES = [HOOK_SCRIPT, 'claude-hook.mjs'];

/** Whether a hook command runs `script`, or the older name beside it: it holds the full path, bare or shell-quoted. */
export const isOurs = (command: unknown, script: string): boolean =>
  typeof command === 'string' && HOOK_NAMES.map((n) => path.join(path.dirname(script), n))
    .some((p) => command.includes(p) || command.includes(p.replace(/'/g, `'\\''`)));

export function svallHome(): string {
  return process.env.SVALL_HOME ?? path.join(os.homedir(), '.svall');
}

export function resolvePaths(home: string = svallHome()) {
  return {
    home,
    state: path.join(home, 'state.json'),
    config: path.join(home, 'config.json'),
    env: path.join(home, '.env'),
    token: path.join(home, 'token'),
    port: path.join(home, 'port'),
    log: path.join(home, 'svalld.log'),
    hooksSock: path.join(home, 'hooks.sock'),
    mobileKey: path.join(home, 'mobile-key'),
    tmuxSock: path.join(home, 'tmux.sock'),
    tmuxConf: path.join(home, 'tmux.conf'),
    hookScript: path.join(home, 'hooks', HOOK_SCRIPT),
    statusScript: path.join(home, 'hooks', 'claude-status.mjs'),
    push: path.join(home, 'push.json'),
    vapid: path.join(home, 'vapid.json'),
    docs: path.join(home, 'docs'),
    agentProfiles: path.join(home, 'agent-profiles'),
  };
}
export type Paths = ReturnType<typeof resolvePaths>;

/** The files that hold a fleet's keys, which Files never opens. */
export const fleetKeys = (p: Paths): string[] => [p.token, p.mobileKey, p.env, p.vapid, p.push];

export function expandHome(p: string): string {
  if (p === '~') return os.homedir();
  return p.startsWith('~/') ? path.join(os.homedir(), p.slice(2)) : p;
}

export type ClaudePaths = { dir: string; json: string };

/** Where Claude Code keeps its files: CLAUDE_CONFIG_DIR and the .claude.json inside it, else ~/.claude and ~/.claude.json. */
export function claudePaths(env: NodeJS.ProcessEnv = process.env, home: string = os.homedir()): ClaudePaths {
  if (env.CLAUDE_CONFIG_DIR) { const dir = path.resolve(env.CLAUDE_CONFIG_DIR); return { dir, json: path.join(dir, '.claude.json') }; }
  return { dir: path.join(home, '.claude'), json: path.join(home, '.claude.json') };
}

// what an install owns outside any fleet home
export function userPaths() {
  const claudeSettings = path.join(claudePaths().dir, 'settings.json');
  return {
    claudeSettings,
    // an install made before CLAUDE_CONFIG_DIR was set holds its hooks in ~/.claude, which uninstall takes back too
    claudeSettingsFiles: [...new Set([claudeSettings, expandHome('~/.claude/settings.json')])],
    launchAgents: expandHome('~/Library/LaunchAgents'),
    shimDir: expandHome('~/.local/bin'),
  };
}

const ROOT = path.resolve(fileURLToPath(new URL('../../..', import.meta.url)));

/** The checkout this file was loaded from, which is the checkout the daemon and the CLI run from. */
export const repoRoot = (): string => ROOT;
