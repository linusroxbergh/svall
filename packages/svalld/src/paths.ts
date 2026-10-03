import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PRIVATE, profileHome } from './profile.js';
import { shq } from './text.js';

export const HOOK_SCRIPT = 'agent-hook.mjs';
export const STATUS_SCRIPT = 'claude-status.mjs';
/** The compiled stand-in for the hook and statusline scripts, which svalld copies beside them. */
const HOOK_HELPER = 'svall-hook';

/** Whether a hook command runs `script`: it holds the full path, bare or shell-quoted. */
export const isOurs = (command: unknown, script: string): boolean =>
  typeof command === 'string' && (command.includes(script) || command.includes(script.replace(/'/g, `'\\''`)));

/** The helper beside `script`, quoted for the shell. */
export const helperBeside = (script: string): string => shq(path.join(path.dirname(script), HOOK_HELPER));

/** Runs the helper beside `script` with `args` while it is there and executable, else `fallback`, the script on node. */
export const helperOr = (script: string, args: string, fallback: string): string => {
  const helper = helperBeside(script);
  return `if [ -x ${helper} ]; then ${helper} ${args}; else ${fallback} ${args}; fi`;
};

// every hook command setup installs starts here, so the hook costs nothing outside a character
export const HOOK_GUARD = '[ -z "$SVALL_CHAR_ID" ] ||';

/** The scripts setup points Claude and Codex at from this home, the hook and the statusline, and the helper that stands in for them. */
export const installedScripts = (home: string = svallHome()): string[] =>
  [HOOK_SCRIPT, STATUS_SCRIPT, HOOK_HELPER].map((file) => path.join(home, 'hooks', file));

export function svallHome(): string {
  return process.env.SVALL_HOME ?? profileHome(PRIVATE);
}

export function resolvePaths(home: string = svallHome()) {
  return {
    home,
    state: path.join(home, 'state.json'),
    // what travels with the fleet, what stays on this machine, and the one file they were split out of
    fleetConfig: path.join(home, 'fleet.json'),
    nodeConfig: path.join(home, 'node.json'),
    legacyConfig: path.join(home, 'config.json'),
    owner: path.join(home, 'owner.json'),
    handoverDir: path.join(home, 'handover'),
    journal: path.join(home, 'handover', 'journal.json'),
    // a prepared snapshot waits beside the journal until the gateway commits it; the id stays one path segment
    preparedState: (transactionId: string) => path.join(home, 'handover', `prepared-${encodeURIComponent(transactionId)}.json`),
    // the manifest a freeze answered, kept so a repeated freeze answers the same one
    manifest: (transactionId: string) => path.join(home, 'handover', `manifest-${encodeURIComponent(transactionId)}.json`),
    // where the controller copies the files of the manifest's session at `index` for prepare to place
    sessionStage: (transactionId: string, index: number) => path.join(home, 'handover', `sessions-${encodeURIComponent(transactionId)}`, String(index)),
    // each root a destination carried, as the Git import left it: what Complete seals, and what an abort leaves claimable
    replicaSeal: (transactionId: string) => path.join(home, 'handover', `seal-${encodeURIComponent(transactionId)}.json`),
    replicas: path.join(home, 'replicas'),
    // one record per fleet and root, named by the sha256 of the root's real path, never kept inside the root
    replicaRecord: (fleetId: string, canonicalPath: string) =>
      path.join(home, 'replicas', encodeURIComponent(fleetId), `${crypto.createHash('sha256').update(canonicalPath).digest('hex')}.json`),
    env: path.join(home, '.env'),
    token: path.join(home, 'token'),
    port: path.join(home, 'port'),
    log: path.join(home, 'svalld.log'),
    hooksSock: path.join(home, 'hooks.sock'),
    mobileKey: path.join(home, 'mobile-key'),
    tmuxSock: path.join(home, 'tmux.sock'),
    tmuxConf: path.join(home, 'tmux.conf'),
    hookScript: path.join(home, 'hooks', HOOK_SCRIPT),
    statusScript: path.join(home, 'hooks', STATUS_SCRIPT),
    hookHelper: path.join(home, 'hooks', HOOK_HELPER),
    push: path.join(home, 'push.json'),
    vapid: path.join(home, 'vapid.json'),
    docs: path.join(home, 'docs'),
    agentProfiles: path.join(home, 'agent-profiles'),
    trash: path.join(home, 'trash'),
  };
}
export type Paths = ReturnType<typeof resolvePaths>;

/** The files that hold a fleet's keys, which Files never opens. */
export const fleetKeys = (p: Paths): string[] => [p.token, p.mobileKey, p.env, p.vapid, p.push];

/** `p` with its links resolved, or as it is when it cannot be. */
export const realPath = (p: string): string => {
  try { return fs.realpathSync(p); } catch { return p; }
};

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
