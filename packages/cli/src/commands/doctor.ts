import { execFile } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { Command } from 'commander';
import { AGENTS, AGENT_KINDS, findAgents, versionOk } from '@svall/svalld/agents';
import { characterKeyEnv } from '@svall/svalld/claude';
import { codexInstalled, codexPaths, type CodexPaths } from '@svall/svalld/codex/install';
import { fleetMainAgent, loadConfig, parseConfig } from '@svall/svalld/config';
import { resolvePaths, userPaths } from '@svall/svalld/paths';
import { PRIVATE, SHIM, profileHome, profileLabel } from '@svall/svalld/profile';
import { HOOK_EVENTS, claudeHooksCurrent, codexHooksCurrent, hooksInstalled, launchdEnv, plistEnv, plistRun } from '@svall/svalld/setup';
import { resolveTmux } from '@svall/svalld/tmux';
import { tmuxTooOld } from '@svall/svalld/tmux/conf';
import type { AgentKind } from '@svall/protocol';
import { Client, restartHint } from '../client.js';
import { askCodexTrust, type HookTrust } from '../codex-trust.js';
import { printResult } from '../format.js';
import type { Target } from '../target.js';
import { checkoutVersion } from '../version.js';

export type Check = { name: string; status: 'ok' | 'warn' | 'fail' | 'skip'; detail: string };
export type Report = { home: string; checks: Check[]; log: { path: string; lines: string[] } };

export type DoctorDeps = {
  run(cmd: string, args: string[], env?: Record<string, string>): Promise<string>;
  read(file: string): string | undefined;
  connect(home: string): Promise<{ close(): void }>;
  connectHook(path: string): Promise<void>;
  uid: number;
  settingsPath: string;
  // the fleet whose scripts setup points the Claude and Codex hooks at
  hooksHome: string;
  launchAgentsDir: string;
  // what setup would hand a fleet's daemon from this shell
  daemonEnv: Record<string, string>;
  codex: CodexPaths;
  exists(path: string): boolean;
  node: string;
  pathEnv: string;
  shimDir: string;
  // the fleet's .env API keys, as a character's shell gets them
  keys: Record<string, string>;
  mainAgent?: AgentKind;
  // agent CLIs on PATH, as setup finds them
  found: AgentKind[];
  integrations?: AgentKind[];
  codexTrust(): Promise<HookTrust | undefined>;
};
export type PreflightDeps = Pick<DoctorDeps, 'run' | 'node' | 'pathEnv' | 'shimDir' | 'keys' | 'mainAgent'>;

const LOG_LINES = 20;
const firstLine = (s: string): string => s.trim().split('\n')[0] ?? '';
const missing = (e: unknown): boolean => (e as NodeJS.ErrnoException).code === 'ENOENT';

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

async function gh(d: DoctorDeps): Promise<Check> {
  try {
    await d.run('gh', ['auth', 'status']);
    return { name: 'gh', status: 'ok', detail: 'logged in' };
  } catch (e) {
    const why = missing(e) ? 'not found on PATH: brew install gh' : 'not logged in: gh auth login';
    return { name: 'gh', status: 'warn', detail: `${why} (pull request links stay unresolved)` };
  }
}

// svalld waits, without starting, while its config.json does not parse
function config(t: Target, d: DoctorDeps): Check {
  const file = resolvePaths(t.home).config;
  const text = d.read(file);
  if (text === undefined) return { name: 'config', status: 'ok', detail: `the defaults, as there is no ${file}` };
  try {
    parseConfig(text, file);
    return { name: 'config', status: 'ok', detail: file };
  } catch (e) {
    return { name: 'config', status: 'fail', detail: `${(e as Error).message}; a stopped svalld waits for it to be fixed` };
  }
}

async function svalld(t: Target, d: DoctorDeps): Promise<Check> {
  const port = d.read(resolvePaths(t.home).port)?.trim();
  // the daemon runs while Svall is open on the fleet; one that stopped otherwise says why in the log below
  if (!port) return { name: 'svalld', status: 'warn', detail: `not running (no port file in ${t.home}): it starts when Svall opens on this fleet` };
  try {
    (await d.connect(t.home)).close();
    return { name: 'svalld', status: 'ok', detail: `running on port ${port}` };
  } catch (e) {
    return { name: 'svalld', status: 'fail', detail: `port ${port} does not answer: ${(e as Error).message}` };
  }
}

async function hookReceiver(t: Target, d: DoctorDeps): Promise<Check> {
  const paths = resolvePaths(t.home);
  // the daemon listens only while Svall is open on the fleet, as the svalld check says
  if (!d.read(paths.port)?.trim()) return { name: 'hook receiver', status: 'skip', detail: 'svalld is not running' };
  const path = paths.hooksSock;
  try {
    await d.connectHook(path);
    return { name: 'hook receiver', status: 'ok', detail: `answering at ${path}` };
  } catch (e) {
    // node adds " - Local (undefined:undefined)" to a socket's error message, so the code stands for it
    const why = (e as NodeJS.ErrnoException).code ?? (e as Error).message;
    return { name: 'hook receiver', status: 'fail', detail: `${path} does not answer (${why}); ${restartHint(t)}` };
  }
}

async function launchd(t: Target, d: DoctorDeps): Promise<Check> {
  if (!t.managed) return { name: 'launchd', status: 'ok', detail: `not managed: ${t.home} is not a profile home` };
  const label = profileLabel(t.name);
  try {
    const out = await d.run('launchctl', ['print', `gui/${d.uid}/${label}`]);
    // the service's own fields sit one tab in; deeper ones belong to its endpoints and triggers
    const fields = out.split('\n').filter((l) => /^\t(state|last exit code|runs) =/.test(l)).map((l) => l.trim());
    // a job at rest is the fleet with its window shut; only one that last exited in failure is wrong
    const failed = !fields.includes('state = running') && fields.some((f) => /^last exit code = [1-9]/.test(f));
    return { name: 'launchd', status: failed ? 'fail' : 'ok', detail: `${label}: ${fields.join(', ') || 'loaded'}` };
  } catch {
    return { name: 'launchd', status: 'fail', detail: `${label} is not loaded: ${SHIM} ${t.name === PRIVATE ? 'setup' : t.name}` };
  }
}

// a fleet's launchd plist, and how to have it written again
function plistOf(t: Target, d: DoctorDeps): { plist: string; fix: string } {
  const label = profileLabel(t.name);
  const plist = path.join(d.launchAgentsDir, `${label}.plist`);
  return { plist, fix: t.name === PRIVATE ? `${SHIM} setup` : `launchctl bootout gui/${d.uid}/${label}, delete ${plist}, then ${SHIM} ${t.name}` };
}

// launchd finds a checkout's node through the plist's PATH, which starts at the node setup ran with; the app names its own
function daemonNode(t: Target, d: DoctorDeps): Check {
  if (!t.managed) return { name: 'daemon node', status: 'skip', detail: 'not managed' };
  const { plist, fix } = plistOf(t, d);
  const run = plistRun(d.read(plist) ?? '');
  const program = run.program[0];
  if (program?.endsWith('/Contents/Helpers/node')) return { name: 'daemon node', status: 'ok', detail: `${program} (the app's own)` };
  const dir = run.path[0];
  if (!dir) return { name: 'daemon node', status: 'skip', detail: `no PATH in ${plist}` };
  if (!d.exists(path.join(dir, 'node'))) return { name: 'daemon node', status: 'warn', detail: `${dir}/node is gone: ${fix}` };
  return /^\/nix\/store\/|\/Cellar\/|\/v?\d+\.\d+\.\d+[^/]*\//.test(`${dir}/`)
    ? { name: 'daemon node', status: 'warn', detail: `${dir} belongs to one node version, and svalld will not start once that version is removed; after changing node: ${fix}` }
    : { name: 'daemon node', status: 'ok', detail: `${dir}/node` };
}

// launchd runs the plist's program with only the plist's PATH, and logs nothing to svalld.log when it cannot:
// a checkout or app moved or deleted since setup, or a claude or codex installed since outside that PATH
function daemonPath(t: Target, d: DoctorDeps): Check {
  if (!t.managed) return { name: 'daemon path', status: 'skip', detail: 'not managed' };
  const { plist, fix } = plistOf(t, d);
  const text = d.read(plist);
  if (text === undefined) return { name: 'daemon path', status: 'skip', detail: `no ${plist}` };
  const run = plistRun(text);
  const missing = run.program.find((p) => !d.exists(p));
  if (missing) return { name: 'daemon path', status: 'fail', detail: `${missing} is gone, so launchd cannot start svalld: ${fix}` };
  const finds = (dirs: string[], bin: string) => dirs.some((dir) => d.exists(path.join(dir, bin)));
  const lacks = ['claude', 'codex'].filter((bin) => finds(d.pathEnv.split(':'), bin) && !finds(run.path, bin));
  return lacks.length
    ? { name: 'daemon path', status: 'warn', detail: `the PATH in ${plist} has no ${lacks.join(' or ')}, which this shell finds: ${fix}` }
    : { name: 'daemon path', status: 'ok', detail: 'its program is there, and it finds claude and codex as this shell does' };
}

// launchd gives svalld only the plist's environment, which setup took from the shell it ran in
function daemonEnv(t: Target, d: DoctorDeps): Check {
  if (!t.managed) return { name: 'daemon env', status: 'skip', detail: 'not managed' };
  const keys = Object.keys(d.daemonEnv);
  if (!keys.length) return { name: 'daemon env', status: 'ok', detail: 'this shell sets no CLAUDE_CONFIG_DIR or CODEX_HOME' };
  const { plist, fix } = plistOf(t, d);
  const text = d.read(plist);
  if (text === undefined) return { name: 'daemon env', status: 'skip', detail: `no ${plist}` };
  const lacks = keys.filter((k) => !text.includes(plistEnv(k, d.daemonEnv[k])));
  return lacks.length
    ? { name: 'daemon env', status: 'warn', detail: `${plist} lacks ${lacks.join(' and ')}, which this shell sets: ${fix}` }
    : { name: 'daemon env', status: 'ok', detail: `same ${keys.join(' and ')} as this shell` };
}

function hooks(d: DoctorDeps): Check {
  if (d.integrations && !d.integrations.includes('claude')) return { name: 'hooks', status: 'skip', detail: 'turned off in setup' };
  if (!d.found.includes('claude') && !d.exists(path.dirname(d.settingsPath))) return { name: 'hooks', status: 'skip', detail: 'Claude Code is not installed' };
  const text = d.read(d.settingsPath);
  let ok = false;
  let current = false;
  let disabled = false;
  try {
    const settings = text === undefined ? undefined : JSON.parse(text);
    ok = settings !== undefined && hooksInstalled(settings, HOOK_EVENTS, d.hooksHome);
    current = ok && claudeHooksCurrent(settings, d.hooksHome);
    disabled = settings?.disableAllHooks === true;
  } catch { /* unparseable counts as missing */ }
  if (!ok) return { name: 'hooks', status: 'fail', detail: `not installed in ${d.settingsPath}: ${SHIM} setup` };
  if (disabled) return { name: 'hooks', status: 'fail', detail: `${d.settingsPath} sets disableAllHooks, so no character gets a status; remove it` };
  return current
    ? { name: 'hooks', status: 'ok', detail: `installed in ${d.settingsPath}` }
    : { name: 'hooks', status: 'warn', detail: `out of date in ${d.settingsPath}: run ${SHIM} setup` };
}

// verifies the hook definition is installed and current, then asks Codex whether it is trusted.
export async function codexCheck(d: Pick<DoctorDeps, 'codex' | 'exists' | 'read' | 'hooksHome' | 'found' | 'integrations' | 'codexTrust'>): Promise<Check> {
  if (d.integrations && !d.integrations.includes('codex')) return { name: 'codex hooks', status: 'skip', detail: 'turned off in setup' };
  if (!d.found.includes('codex') && !d.exists(d.codex.dir)) return { name: 'codex hooks', status: 'skip', detail: 'not installed' };
  const script = resolvePaths(d.hooksHome).hookScript;
  let written = false;
  let current = false;
  try {
    const hooks = JSON.parse(d.read(d.codex.hooks) ?? '{}');
    written = codexInstalled(hooks, script);
    current = written && codexHooksCurrent(hooks, script);
  } catch { /* unparseable counts as missing */ }
  if (!written) return { name: 'codex hooks', status: 'warn', detail: `not installed in ${d.codex.hooks}: ${SHIM} setup` };
  if (!current) return { name: 'codex hooks', status: 'warn', detail: `out of date in ${d.codex.hooks}: run ${SHIM} setup, then trust them in Codex` };
  const trust = await d.codexTrust();
  if (!trust) return { name: 'codex hooks', status: 'ok', detail: `installed in ${d.codex.hooks}; couldn't ask Codex about trust, check /hooks in Codex` };
  return trust.untrusted
    ? { name: 'codex hooks', status: 'warn', detail: 'not trusted yet: start codex and choose "Trust all and continue", or trust them in /hooks' }
    : { name: 'codex hooks', status: 'ok', detail: `installed in ${d.codex.hooks}; trusted` };
}

export async function doctor(t: Target, d: DoctorDeps): Promise<Report> {
  const log = resolvePaths(t.home).log;
  const checks = [
    ...await preflight(d),
    await gh(d),
    config(t, d),
    await svalld(t, d),
    await hookReceiver(t, d),
    await launchd(t, d),
    daemonNode(t, d),
    daemonPath(t, d),
    daemonEnv(t, d),
    hooks(d),
    await codexCheck(d),
  ];
  const lines = (d.read(log) ?? '').split('\n').filter(Boolean).slice(-LOG_LINES);
  return { home: t.home, checks, log: { path: log, lines } };
}

const execFileP = promisify(execFile);

function connectHook(path: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(path);
    socket.setTimeout(1000, () => socket.destroy(new Error('timed out')));
    socket.once('connect', () => { socket.destroy(); resolve(); });
    socket.once('error', reject);
  });
}

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

export function doctorCommand(target: () => Target, json: () => boolean): Command {
  return new Command('doctor').description('check what the fleet needs and show the end of its log; changes nothing').action(async () => {
    const t = target();
    let integrations: AgentKind[] | undefined;
    try { integrations = loadConfig(resolvePaths(profileHome(PRIVATE)).config).integrations; } catch { /* the private fleet's doctor reports it */ }
    const report = { version: checkoutVersion(), ...await doctor(t, {
      ...realPreflightDeps(t.home),
      read: (file) => { try { return fs.readFileSync(file, 'utf8'); } catch { return undefined; } },
      connect: (home) => Client.connect(home),
      connectHook,
      uid: os.userInfo().uid,
      settingsPath: userPaths().claudeSettings,
      hooksHome: profileHome(PRIVATE),
      launchAgentsDir: userPaths().launchAgents,
      daemonEnv: launchdEnv(),
      codex: codexPaths(),
      exists: fs.existsSync,
      found: findAgents(process.env.PATH ?? ''),
      integrations,
      codexTrust: () => askCodexTrust({ codexHome: codexPaths().dir, script: resolvePaths(profileHome(PRIVATE)).hookScript }),
    }) };
    const width = Math.max(...report.checks.map((c) => c.name.length));
    printResult(report, json(), () => [
      `svall ${report.version}`,
      `fleet ${report.home}`,
      ...report.checks.map((c) => `${MARK[c.status]} ${c.name.padEnd(width)}  ${c.detail}`),
      '',
      `last ${LOG_LINES} lines of ${report.log.path}:`,
      ...(report.log.lines.length ? report.log.lines : ['(empty)']),
    ].join('\n'));
    if (report.checks.some((c) => c.status === 'fail')) process.exitCode = 1;
  });
}
