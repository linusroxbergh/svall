import { execFile } from 'node:child_process';
import os from 'node:os';
import { promisify } from 'node:util';
import { AGENTS, AGENT_KINDS, versionOk } from '@svall/svalld/agents';
import { characterKeyEnv } from '@svall/svalld/claude';
import { configuredMainAgent, fleetMainAgent } from '@svall/svalld/config';
import { unitPath } from '@svall/svalld/linux/setup';
import { resolvePaths, userPaths } from '@svall/svalld/paths';
import { SHIM } from '@svall/svalld/profile';
import { ownRuntime } from '@svall/svalld/runtime';
import { resolveTmux } from '@svall/svalld/tmux';
import { tmuxTooOld } from '@svall/svalld/tmux/conf';
import type { AgentKind } from '@svall/protocol';
import { DEFAULT_PREFIX } from '../../../../scripts/install-release.mjs';
import { MARK, type Check } from '../checks-view.js';

export type PreflightDeps = {
  /** `path`: the PATH to find `cmd` on, when it is not this process's own; `env`: added to this process's environment */
  run(cmd: string, args: string[], o?: { path?: string; env?: Record<string, string> }): Promise<string>;
  node: string;
  pathEnv: string;
  /** where the daemon finds the agent CLIs, when that is not this shell's PATH */
  agentPath?: string;
  shimDir: string;
  // the fleet's .env API keys, as a character's shell gets them
  keys: Record<string, string>;
  mainAgent?: AgentKind;
  platform: NodeJS.Platform;
};

const firstLine = (s: string): string => s.trim().split('\n')[0] ?? '';
export const missing = (e: unknown): boolean => (e as NodeJS.ErrnoException).code === 'ENOENT';

async function tmux(d: PreflightDeps): Promise<Check> {
  const linux = d.platform === 'linux';
  try {
    const v = firstLine(await d.run(resolveTmux(), ['-V']));
    return tmuxTooOld(v)
      ? { name: 'tmux', status: 'warn', detail: `${v}: Shift+Enter needs tmux 3.5 or newer; ${linux ? 'Ubuntu 24.04 ships 3.4' : 'brew upgrade tmux'}` }
      : { name: 'tmux', status: 'ok', detail: v };
  } catch (e) {
    const install = linux ? 'sudo apt install tmux' : 'brew install tmux';
    return { name: 'tmux', status: 'fail', detail: missing(e) ? `not found on PATH: ${install}` : (e as Error).message };
  }
}

function node(d: PreflightDeps): Check {
  return Number(d.node.slice(1).split('.')[0]) >= 24
    ? { name: 'node', status: 'ok', detail: d.node }
    : { name: 'node', status: 'fail', detail: `${d.node}: svall needs node 24 or newer` };
}

function shimDirOnPath(d: PreflightDeps): Check {
  return d.pathEnv.split(':').includes(d.shimDir)
    ? { name: 'path', status: 'ok', detail: `${d.shimDir} is on PATH` }
    : { name: 'path', status: 'warn', detail: `${d.shimDir} is not on PATH, so your shell will not find ${SHIM}; add it in your shell profile` };
}

// 1 is the CLI's own "not signed in"; anything else (a timeout, an unknown subcommand) leaves it unknown
const exitCode = (e: unknown): unknown => (e as { code?: unknown }).code;

async function signedIn(d: PreflightDeps, kind: AgentKind): Promise<boolean | undefined> {
  const a = AGENTS[kind];
  try {
    // the fleet's API keys ride along, as they do into a character's shell
    return a.loggedIn(await d.run(a.bin, a.loginArgs, { path: d.agentPath, env: d.keys }));
  } catch (e) {
    return exitCode(e) === 1 ? false : undefined;
  }
}

async function agentCheck(d: PreflightDeps, kind: AgentKind, version: string | Error | undefined, found: AgentKind[]): Promise<Check> {
  const a = AGENTS[kind];
  if (version === undefined) {
    const other = AGENT_KINDS.find((k) => k !== kind && found.includes(k));
    return d.mainAgent === kind && other
      ? { name: kind, status: 'warn', detail: `not installed, but it is the main agent: ${SHIM} agent ${other}` }
      : { name: kind, status: 'skip', detail: 'not installed' };
  }
  if (version instanceof Error) return { name: kind, status: 'warn', detail: firstLine(version.message) };
  const login = await signedIn(d, kind);
  if (!versionOk(a, version)) {
    const old = `${version}: Svall needs ${a.minVersion!.join('.')} or newer; update ${a.label}`;
    return { name: kind, status: 'warn', detail: login === false ? `${old}; not signed in: ${a.loginHint}` : old };
  }
  if (login === undefined) return { name: kind, status: 'warn', detail: `${version}; couldn't tell whether it is signed in` };
  return login
    ? { name: kind, status: 'ok', detail: `${version}, signed in` }
    : { name: kind, status: 'warn', detail: `${version}, not signed in: ${a.loginHint}` };
}

async function agentChecks(d: PreflightDeps): Promise<Check[]> {
  // a CLI whose --version fails other than ENOENT is there but broken
  const versions = new Map<AgentKind, string | Error>();
  for (const k of AGENT_KINDS) {
    try { versions.set(k, firstLine(await d.run(AGENTS[k].bin, ['--version'], { path: d.agentPath }))); }
    catch (e) { if (!missing(e)) versions.set(k, e as Error); }
  }
  if (!versions.size) {
    const how = AGENT_KINDS.map((k) => `${AGENTS[k].installCommand} (${AGENTS[k].label})`).join(' or ');
    // a companion is provisioned before anyone logs an agent in on it, so Linux only warns
    return [{ name: 'agents', status: d.platform === 'linux' ? 'warn' : 'fail', detail: `neither claude nor codex is on PATH, and the desktop apps don't install them: run ${how}` }];
  }
  const found = [...versions.keys()];
  return Promise.all(AGENT_KINDS.map((k) => agentCheck(d, k, versions.get(k), found)));
}

export async function preflight(d: PreflightDeps): Promise<Check[]> {
  return [await tmux(d), node(d), ...await agentChecks(d), shimDirOnPath(d)];
}

export const checkLine = (c: Check): string => `${MARK[c.status]} ${c.name}  ${c.detail}`;

// the lines to show for warnings; any failure stops the caller before it changes anything
export function requireReady(checks: Check[]): string[] {
  const failed = checks.filter((c) => c.status === 'fail');
  if (failed.length) throw new Error(`nothing was changed; fix these first:\n${failed.map(checkLine).join('\n')}`);
  return checks.filter((c) => c.status === 'warn').map(checkLine);
}

const execFileP = promisify(execFile);

// a login over ssh sees less of the machine than the unit the daemon runs in
const unitAgentPath = (): string =>
  unitPath({ runtime: ownRuntime(), homedir: os.homedir(), prefix: DEFAULT_PREFIX });

export function realPreflightDeps(home: string, platform: NodeJS.Platform = process.platform): PreflightDeps {
  let mainAgent: AgentKind | undefined;
  try { mainAgent = fleetMainAgent(home, configuredMainAgent(resolvePaths(home))); } catch { /* doctor's config check reports it */ }
  return {
    // a login probe, the one call given the fleet's keys, must not hold up install when it hangs
    run: async (cmd, args, o) => (await execFileP(cmd, args, {
      timeout: o?.env ? 5_000 : 10_000,
      ...((o?.path || o?.env) && { env: { ...process.env, ...o.env, ...(o.path && { PATH: o.path }) } }),
    })).stdout,
    node: process.version,
    pathEnv: process.env.PATH ?? '',
    ...(platform === 'linux' && { agentPath: unitAgentPath() }),
    shimDir: userPaths().shimDir,
    keys: characterKeyEnv(resolvePaths(home).env),
    mainAgent,
    platform,
  };
}
