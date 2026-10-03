import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { AGENTS, AGENT_KINDS, versionOk } from '@svall/svalld/agents';
import { characterKeyEnv } from '@svall/svalld/claude';
import { fleetMainAgent, loadConfig } from '@svall/svalld/config';
import { resolvePaths, userPaths } from '@svall/svalld/paths';
import { SHIM } from '@svall/svalld/profile';
import { resolveTmux } from '@svall/svalld/tmux';
import { tmuxTooOld } from '@svall/svalld/tmux/conf';
import type { AgentKind } from '@svall/protocol';

export type Check = { name: string; status: 'ok' | 'warn' | 'fail' | 'skip'; detail: string };

export type PreflightDeps = {
  run(cmd: string, args: string[], env?: Record<string, string>): Promise<string>;
  node: string;
  pathEnv: string;
  shimDir: string;
  // the fleet's .env API keys, as a character's shell gets them
  keys: Record<string, string>;
  mainAgent?: AgentKind;
};

const firstLine = (s: string): string => s.trim().split('\n')[0] ?? '';
export const missing = (e: unknown): boolean => (e as NodeJS.ErrnoException).code === 'ENOENT';

async function tmux(d: PreflightDeps): Promise<Check> {
  try {
    const v = firstLine(await d.run(resolveTmux(), ['-V']));
    return tmuxTooOld(v)
      ? { name: 'tmux', status: 'warn', detail: `${v}: Shift+Enter needs tmux 3.5 or newer; brew upgrade tmux` }
      : { name: 'tmux', status: 'ok', detail: v };
  } catch (e) {
    return { name: 'tmux', status: 'fail', detail: missing(e) ? 'not found on PATH: brew install tmux' : (e as Error).message };
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

async function agentCheck(d: PreflightDeps, kind: AgentKind, version: string | Error | undefined, found: AgentKind[]): Promise<Check> {
  const a = AGENTS[kind];
  if (version === undefined) {
    const other = AGENT_KINDS.find((k) => k !== kind && found.includes(k));
    return d.mainAgent === kind && other
      ? { name: kind, status: 'warn', detail: `not installed, but it is the main agent: ${SHIM} agent ${other}` }
      : { name: kind, status: 'skip', detail: 'not installed' };
  }
  if (version instanceof Error) return { name: kind, status: 'warn', detail: firstLine(version.message) };
  if (!versionOk(a, version)) {
    const [x, y] = a.minVersion!;
    return { name: kind, status: 'warn', detail: `${version}: Svall needs ${x}.${y} or newer; update ${a.label}` };
  }
  try {
    // the fleet's API keys ride along, as they do into a character's shell
    return a.loggedIn(await d.run(a.bin, a.loginArgs, d.keys))
      ? { name: kind, status: 'ok', detail: `${version}, signed in` }
      : { name: kind, status: 'warn', detail: `${version}, not signed in: ${a.loginHint}` };
  } catch (e) {
    return exitCode(e) === 1
      ? { name: kind, status: 'warn', detail: `${version}, not signed in: ${a.loginHint}` }
      : { name: kind, status: 'warn', detail: `${version}; couldn't tell whether it is signed in` };
  }
}

async function agentChecks(d: PreflightDeps): Promise<Check[]> {
  // a CLI whose --version fails other than ENOENT is there but broken
  const versions = new Map<AgentKind, string | Error>();
  for (const k of AGENT_KINDS) {
    try { versions.set(k, firstLine(await d.run(AGENTS[k].bin, ['--version']))); }
    catch (e) { if (!missing(e)) versions.set(k, e as Error); }
  }
  if (!versions.size) {
    const how = AGENT_KINDS.map((k) => `${AGENTS[k].installCommand} (${AGENTS[k].label})`).join(' or ');
    return [{ name: 'agents', status: 'fail', detail: `neither claude nor codex is on PATH, and the desktop apps don't install them: run ${how}` }];
  }
  const found = [...versions.keys()];
  return Promise.all(AGENT_KINDS.map((k) => agentCheck(d, k, versions.get(k), found)));
}

export async function preflight(d: PreflightDeps): Promise<Check[]> {
  return [await tmux(d), node(d), ...await agentChecks(d), shimDirOnPath(d)];
}

export const MARK = { ok: '✓', warn: '!', fail: '✗', skip: '–' };
export const checkLine = (c: Check): string => `${MARK[c.status]} ${c.name}  ${c.detail}`;

// the lines to show for warnings; any failure stops the caller before it changes anything
export function requireReady(checks: Check[]): string[] {
  const failed = checks.filter((c) => c.status === 'fail');
  if (failed.length) throw new Error(`nothing was changed; fix these first:\n${failed.map(checkLine).join('\n')}`);
  return checks.filter((c) => c.status === 'warn').map(checkLine);
}

const execFileP = promisify(execFile);

export function realPreflightDeps(home: string): PreflightDeps {
  let mainAgent: AgentKind | undefined;
  try { mainAgent = fleetMainAgent(home, loadConfig(resolvePaths(home).config).mainAgent); } catch { /* doctor's config check reports it */ }
  return {
    // a login probe, the one call given the fleet's keys, must not hold up install when it hangs
    run: async (cmd, args, env) => (await execFileP(cmd, args, { timeout: env ? 5_000 : 10_000, env: env && { ...process.env, ...env } })).stdout,
    node: process.version,
    pathEnv: process.env.PATH ?? '',
    shimDir: userPaths().shimDir,
    keys: characterKeyEnv(resolvePaths(home).env),
    mainAgent,
  };
}
