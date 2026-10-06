import fs from 'node:fs';
import path from 'node:path';
import { AGENT_LABEL, type AgentKind } from '@svall/protocol';

type Version = [number, number, number];

// what Svall needs to know about each agent CLI
type AgentAdapter = {
  label: string;
  bin: string;
  installUrl: string;
  // the vendor's own installer for the CLI; the desktop apps don't put the command on PATH
  installCommand: string;
  minVersion?: Version;
  // argv that reports the login; exit 1 means not logged in
  loginArgs: string[];
  loggedIn(stdout: string): boolean;
  loginHint: string;
  // what mission control's crew starts with, unless config.json's home.command names a command
  crewCommand: string;
};

export const AGENTS: Record<AgentKind, AgentAdapter> = {
  claude: {
    label: AGENT_LABEL.claude, bin: 'claude', installUrl: 'https://code.claude.com/docs/en/setup',
    installCommand: 'curl -fsSL https://claude.ai/install.sh | bash',
    loginArgs: ['auth', 'status', '--json'],
    loggedIn: (out) => { try { return (JSON.parse(out) as { loggedIn?: boolean }).loggedIn === true; } catch { return false; } },
    loginHint: 'claude auth login',
    crewCommand: 'claude --model sonnet',
  },
  codex: {
    label: AGENT_LABEL.codex, bin: 'codex', installUrl: 'https://learn.chatgpt.com/docs/codex/cli', minVersion: [0, 155, 0],
    installCommand: 'curl -fsSL https://chatgpt.com/codex/install.sh | sh',
    loginArgs: ['login', 'status'], loggedIn: () => true,
    loginHint: 'codex login',
    crewCommand: 'codex',
  },
  opencode: {
    label: AGENT_LABEL.opencode, bin: 'opencode', installUrl: 'https://opencode.ai/docs/', minVersion: [2, 0, 22],
    installCommand: 'curl -fsSL https://opencode.ai/install | bash',
    // a fresh install runs on OpenCode Zen's free model without a login; a private server leaves the user's shared
    // background service unstarted
    loginArgs: ['auth', 'list', '--standalone'], loggedIn: () => true,
    loginHint: 'opencode auth login',
    crewCommand: 'opencode',
  },
};
export const AGENT_KINDS = Object.keys(AGENTS) as AgentKind[];

export function isExecutable(file: string): boolean {
  try { fs.accessSync(file, fs.constants.X_OK); return fs.statSync(file).isFile(); } catch { return false; }
}

export function onPath(bin: string, pathEnv: string, isExec = isExecutable): string | undefined {
  return pathEnv.split(':').filter((dir) => path.isAbsolute(dir)).find((dir) => isExec(path.join(dir, bin)));
}

export const findAgents = (pathEnv: string, isExec = isExecutable): AgentKind[] =>
  AGENT_KINDS.filter((k) => onPath(AGENTS[k].bin, pathEnv, isExec) !== undefined);

export function parseVersion(text: string): Version | undefined {
  const m = /(\d+)\.(\d+)\.(\d+)/.exec(text);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : undefined;
}

// a version line that can't be read passes, so a new format never blocks anyone
export function versionOk(a: AgentAdapter, text: string): boolean {
  const v = parseVersion(text);
  if (!a.minVersion || !v) return true;
  for (let i = 0; i < 3; i++) if (v[i] !== a.minVersion[i]) return v[i] > a.minVersion[i];
  // 0.155.0-alpha.3 comes before 0.155.0
  return !text.includes(`${v.join('.')}-`);
}

export const mainAgent = (configured: AgentKind | undefined, found: AgentKind[]): AgentKind =>
  configured ?? (!found.length || found.includes('claude') ? 'claude' : found[0]);
