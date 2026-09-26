import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';

export const HOOK_SCRIPT = 'agent-hook.mjs';
export const STATUS_SCRIPT = 'claude-status.mjs';
// an install may still name the script claude-hook.mjs; that entry is ours to repair and remove too
const HOOK_NAMES = [HOOK_SCRIPT, 'claude-hook.mjs'];

/** Whether a hook command runs `script`, or the older name beside it: it holds the full path, bare or shell-quoted. */
export const isOurs = (command: unknown, script: string): boolean =>
  typeof command === 'string' && HOOK_NAMES.map((n) => path.join(path.dirname(script), n))
    .some((p) => command.includes(p) || command.includes(p.replace(/'/g, `'\\''`)));
// every hook command setup installs starts here, so the hook costs nothing outside a character
export const HOOK_GUARD = '[ -z "$ARCHI_CHAR_ID" ] ||';

/** The scripts setup points Claude and Codex at from this home: the hook under both its names, and the statusline. */
export const installedScripts = (home: string = archiHome()): string[] =>
  [...HOOK_NAMES, STATUS_SCRIPT].map((file) => path.join(home, 'hooks', file));

export function archiHome(): string {
  return process.env.ARCHI_HOME ?? path.join(os.homedir(), '.archipelago');
}

export function resolvePaths(home: string = archiHome()) {
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
    // the gateway's secret for this fleet's owner relay; never in fleet.json, a snapshot or a transfer
    relaySecret: path.join(home, 'relay-secret'),
    token: path.join(home, 'token'),
    port: path.join(home, 'port'),
    log: path.join(home, 'archid.log'),
    hooksSock: path.join(home, 'hooks.sock'),
    mobileKey: path.join(home, 'mobile-key'),
    tmuxSock: path.join(home, 'tmux.sock'),
    tmuxConf: path.join(home, 'tmux.conf'),
    hookScript: path.join(home, 'hooks', HOOK_SCRIPT),
    statusScript: path.join(home, 'hooks', STATUS_SCRIPT),
    push: path.join(home, 'push.json'),
    vapid: path.join(home, 'vapid.json'),
    docs: path.join(home, 'docs'),
    agentProfiles: path.join(home, 'agent-profiles'),
  };
}
export type Paths = ReturnType<typeof resolvePaths>;

/** The files that hold a fleet's keys, which Files never opens. */
export const fleetKeys = (p: Paths): string[] => [p.token, p.mobileKey, p.env, p.vapid, p.push, p.relaySecret];

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
