import fs from 'node:fs';
import path from 'node:path';
import { AGENT_LABEL, AGENT_UPDATE, type AgentKind } from '@svall/protocol';
import { shq } from './text.js';

export type Version = [number, number, number];

type AgentAdapter = {
  label: string;
  bin: string;
  installUrl: string;
  // the vendor's own installer for the CLI; the desktop apps don't put the command on PATH
  installCommand: string;
  // the CLI's own update to its latest release, whichever way it was installed
  updateCommand: string;
  minVersion?: Version;
  // minVersion is only what a move needs, so a Mac whose robots never move runs on older
  moveFloor?: true;
  // argv that reports the login; exit 1 means not logged in
  loginArgs: string[];
  loggedIn(stdout: string): boolean;
  loginHint: string;
  // what mission control's crew starts with on `model`, unless fleet.json's home.command names a command
  crewCommand(model?: string): string;
  // the models the crew and the scribe run unless fleet.json names one; absent, the CLI's own
  crewModel?: string;
  scribeModel?: string;
};

// the command is typed into a shell, so a model that is not a plain word, such as opus[1m], is quoted
const withModel = (bin: string, flag: string) => (model?: string): string =>
  (model ? `${bin} ${flag} ${/^[\w.:@/-]+$/.test(model) ? model : shq(model)}` : bin);

export const AGENTS: Record<AgentKind, AgentAdapter> = {
  claude: {
    // the oldest release whose sessions a move carries, which a fixture holds
    label: AGENT_LABEL.claude, bin: 'claude', installUrl: 'https://code.claude.com/docs/en/setup', minVersion: [2, 1, 251], moveFloor: true,
    installCommand: 'curl -fsSL https://claude.ai/install.sh | bash', updateCommand: AGENT_UPDATE.claude,
    loginArgs: ['auth', 'status', '--json'],
    loggedIn: (out) => { try { return (JSON.parse(out) as { loggedIn?: boolean }).loggedIn === true; } catch { return false; } },
    loginHint: 'claude auth login',
    crewCommand: withModel('claude', '--model'), crewModel: 'opus', scribeModel: 'haiku',
  },
  codex: {
    label: AGENT_LABEL.codex, bin: 'codex', installUrl: 'https://learn.chatgpt.com/docs/codex/cli', minVersion: [0, 156, 0],
    installCommand: 'curl -fsSL https://chatgpt.com/codex/install.sh | sh', updateCommand: AGENT_UPDATE.codex,
    loginArgs: ['login', 'status'], loggedIn: () => true,
    loginHint: 'codex login',
    crewCommand: withModel('codex', '-m'), scribeModel: 'gpt-6-luna',
  },
  opencode: {
    label: AGENT_LABEL.opencode, bin: 'opencode', installUrl: 'https://opencode.ai/v2/docs/', minVersion: [2, 0, 22],
    installCommand: 'curl -fsSL https://opencode.ai/v2/install | bash', updateCommand: AGENT_UPDATE.opencode,
    // its login is a model provider's login or key, which auth list names; an MCP server's is an integration too. A
    // private server leaves the user's shared background service unstarted
    loginArgs: ['auth', 'list', '--standalone', '--format', 'json'],
    loggedIn: (out) => {
      try {
        const listed: unknown = JSON.parse(out);
        return Array.isArray(listed) && listed.some((i: { id?: unknown }) => typeof i.id === 'string' && !i.id.startsWith('mcp_'));
      } catch { return false; }
    },
    loginHint: 'opencode auth login',
    // its TUI refuses -m: the model is the provider config's
    crewCommand: () => 'opencode',
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

/** The release a CLI names in its `--version` line, whatever it wraps it in. */
export const versionOf = (text: string): string | undefined => /\d+\.\d+\.\d+[0-9A-Za-z.+-]*/.exec(text)?.[0];

// a version line that can't be read passes, so a new format never blocks anyone
export const versionOk = (a: Pick<AgentAdapter, 'minVersion'>, text: string): boolean =>
  !a.minVersion || compareVersions(text, a.minVersion.join('.')) !== -1;

// -1, 0 or 1 in semver order, x.y as x.y.0 and a release after its prereleases; undefined when either line has no x.y
export function compareVersions(a: string, b: string): number | undefined {
  const [x, y] = [a, b].map((t) => /(\d+)\.(\d+)(?:\.(\d+))?(?:-([0-9A-Za-z.-]+))?/.exec(t));
  if (!x || !y) return undefined;
  for (let i = 1; i <= 3; i++) {
    const [m, n] = [Number(x[i] ?? 0), Number(y[i] ?? 0)];
    if (m !== n) return Math.sign(m - n);
  }
  if (!x[4] || !y[4]) return Number(!x[4]) - Number(!y[4]);
  const [p, q] = [x[4].split('.'), y[4].split('.')];
  for (let i = 0; i < Math.min(p.length, q.length); i++) {
    if (p[i] === q[i]) continue;
    const [m, n] = [/^\d+$/.test(p[i]), /^\d+$/.test(q[i])];
    if (m && n) return Math.sign(Number(p[i]) - Number(q[i]));
    if (m !== n) return m ? -1 : 1;
    return p[i] < q[i] ? -1 : 1;
  }
  return Math.sign(p.length - q.length);
}

export const mainAgent =(configured: AgentKind | undefined, found: AgentKind[]): AgentKind =>
  configured ?? (!found.length || found.includes('claude') ? 'claude' : found[0]);
