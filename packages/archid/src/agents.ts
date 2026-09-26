import fs from 'node:fs';
import path from 'node:path';
import { AGENT_LABEL, type AgentKind } from '@archipelago/protocol';

export type Version = [number, number, number];

// what Archipelago needs to know about each agent CLI; later PRs add hooks, transcripts, launch and usage here
export type AgentAdapter = {
  kind: AgentKind;
  label: string;
  bin: string;
  installUrl: string;
  minVersion?: Version;
  // argv that reports the login; a non-zero exit means not logged in
  loginArgs: string[];
  loggedIn(stdout: string): boolean;
  loginHint: string;
};

export const AGENTS: Record<AgentKind, AgentAdapter> = {
  claude: {
    kind: 'claude', label: AGENT_LABEL.claude, bin: 'claude', installUrl: 'https://code.claude.com/docs/en/setup',
    loginArgs: ['auth', 'status', '--json'],
    loggedIn: (out) => { try { return (JSON.parse(out) as { loggedIn?: boolean }).loggedIn === true; } catch { return false; } },
    loginHint: 'claude auth login',
  },
  codex: {
    kind: 'codex', label: AGENT_LABEL.codex, bin: 'codex', installUrl: 'https://learn.chatgpt.com/docs/codex/cli', minVersion: [0, 155, 0],
    loginArgs: ['login', 'status'], loggedIn: () => true,
    loginHint: 'codex login',
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
  return true;
}

export const mainAgent = (configured: AgentKind | undefined, found: AgentKind[]): AgentKind =>
  configured ?? (found.length === 1 ? found[0] : 'claude');
