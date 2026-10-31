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

// the node setup ran with, or the one on PATH once a version manager has removed it
export const nodeRun = (node: string, script: string): string => `n=${shq(node)}; [ -x "$n" ] || n=node; "$n" ${shq(script)}`;

// every hook command setup installs starts here, so the hook costs nothing outside a robot
// a session an older svalld started carries SVALL_CHAR_ID
export const HOOK_GUARD = '[ -z "$SVALL_ROBOT_ID$SVALL_CHAR_ID" ] ||';

/** `env` less the ids HOOK_GUARD looks for, so Svall's hooks do not take a process run with it for a robot's. */
export const withoutRobotEnv = (env: NodeJS.ProcessEnv): NodeJS.ProcessEnv => {
  const { SVALL_ROBOT_ID: _id, SVALL_CHAR_ID: _old, ...rest } = env;
  return rest;
};

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
    env: path.join(home, '.env'),
    token: path.join(home, 'token'),
    port: path.join(home, 'port'),
    log: path.join(home, 'svalld.log'),
    hooksSock: path.join(home, 'hooks.sock'),
    mobileKey: path.join(home, 'mobile-key'),
    mobilePass: path.join(home, 'mobile-pass'),
    tmuxSock: path.join(home, 'tmux.sock'),
    tmuxConf: path.join(home, 'tmux.conf'),
    hookScript: path.join(home, 'hooks', HOOK_SCRIPT),
    statusScript: path.join(home, 'hooks', STATUS_SCRIPT),
    hookHelper: path.join(home, 'hooks', HOOK_HELPER),
    push: path.join(home, 'push.json'),
    vapid: path.join(home, 'vapid.json'),
    // a worker's: what its home's phone link accepts and signs pushes with, while it serves the phone itself
    phone: path.join(home, 'phone.json'),
    // the home's, of this machine alone: each worker's phone link and pass
    phoneFallbacks: path.join(home, 'phone-fallbacks.json'),
    docs: path.join(home, 'docs'),
    agentProfiles: path.join(home, 'agent-profiles'),
    // a worker's own settings and files, in the mirror's layout, over what the home's agent configuration brings
    mirrorOverrides: path.join(home, 'mirror-overrides'),
    // the home's: which keys each worker's mirror may copy, field by field
    mirrorConsent: path.join(home, 'mirror-consent.json'),
    trash: path.join(home, 'trash'),
    opencodeConfig: path.join(home, 'opencode-config'),
    opencodeReplaced: path.join(home, 'opencode-config-replaced'),
    zdotdir: path.join(home, 'zsh'),
    // a worker's: the home it serves, that home's last snapshot, the outbox, its epoch and the seq the home last acknowledged,
    // the log of mutations the home applied, the link's socket
    workerFile: path.join(home, 'worker.json'),
    cache: path.join(home, 'cache'),
    snapshotFile: path.join(home, 'cache', 'snapshot.json'),
    // the sha256 of each doc as the worker and the home last both held it
    docsSynced: path.join(home, 'cache', 'docs-synced.json'),
    // what the mirror last wrote here, by sha256, and the variables the home's agent configuration names
    mirrorState: path.join(home, 'cache', 'mirror-state.json'),
    mirrorVars: path.join(home, 'cache', 'mirror-vars.json'),
    outbox: path.join(home, 'journal', 'outbox.ndjson'),
    acked: path.join(home, 'journal', 'acked'),
    epoch: path.join(home, 'journal', 'epoch'),
    applied: path.join(home, 'journal', 'applied.ndjson'),
    linkSock: path.join(home, 'link.sock'),
    // each robot move's journal, on either side of it
    moves: path.join(home, 'journal', 'moves'),
    // the retro's runs, its ledger, and the record of which robot, island and repo each session ran in
    retro: path.join(home, 'retro'),
    retroSessions: path.join(home, 'retro', 'sessions.ndjson'),
    // the home's: the token it issued each worker of this fleet
    workersFile: path.join(home, 'workers.json'),
  };
}
export type Paths = ReturnType<typeof resolvePaths>;

// the bytes a Unix socket path holds before its NUL
const SOCKET_MAX: Partial<Record<NodeJS.Platform, number>> = { linux: 107, darwin: 103 };

/** Why nothing can listen on `socket` on `platform`: a path longer than a Unix socket takes, which listen refuses with EINVAL. */
export function socketTooLong(socket: string, platform: NodeJS.Platform = process.platform): { message: string; over: number } | undefined {
  const max = SOCKET_MAX[platform];
  const bytes = Buffer.byteLength(socket);
  if (max === undefined || bytes <= max) return undefined;
  return { message: `the socket ${socket} is ${bytes} bytes, past the ${max} a Unix socket path holds, so its listen fails with EINVAL`, over: bytes - max };
}

/** The files that hold a fleet's keys, which Files never opens. */
export const fleetKeys = (p: Paths): string[] => [p.token, p.mobileKey, p.mobilePass, p.env, p.vapid, p.push, p.phone, p.phoneFallbacks, p.workerFile, p.workersFile];

/** `p` with its links resolved, or as it is when it cannot be. */
export const realPath = (p: string): string => {
  try { return fs.realpathSync(p); } catch { return p; }
};

export function expandHome(p: string, home = os.homedir()): string {
  if (p === '~') return home;
  return p.startsWith('~/') ? path.join(home, p.slice(2)) : p;
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
