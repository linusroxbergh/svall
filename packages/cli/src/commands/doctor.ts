import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { Command } from 'commander';
import { claudeHooksCurrent, codexHooksCurrent, codexInstalled, hooksInstalled } from '@svall/svalld/agent-hooks';
import { AGENTS, AGENT_KINDS, findAgents } from '@svall/svalld/agents';
import { codexPaths, type CodexPaths } from '@svall/svalld/codex/install';
import { loadConfig, parseConfig } from '@svall/svalld/config';
import { launchdEnv, plistEnv, plistRun } from '@svall/svalld/launchd';
import { opencodePaths, opencodePluginCurrent, type OpencodePaths } from '@svall/svalld/opencode/install';
import { resolvePaths, userPaths } from '@svall/svalld/paths';
import { PRIVATE, SHIM, profileHome, profileLabel } from '@svall/svalld/profile';
import { ownRuntime } from '@svall/svalld/runtime';
import { readOrUndefined } from '@svall/svalld/settings-file';
import { shimsCurrent } from '@svall/svalld/setup';
import type { AgentKind } from '@svall/protocol';
import { grouped, renderGroups, useColor } from '../checks-view.js';
import { Client, restartHint } from '../client.js';
import { askCodexTrust, type HookTrust } from '../codex-trust.js';
import { printResult } from '../format.js';
import type { Target } from '../target.js';
import { checkoutVersion } from '../version.js';
import { missing, preflight, realPreflightDeps, type Check, type PreflightDeps } from './preflight.js';

type Report = { home: string; checks: Check[]; log: { path: string; lines: string[] } };

export type DoctorDeps = PreflightDeps & {
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
  opencode: OpencodePaths;
  exists(path: string): boolean;
  // agent CLIs on PATH, as setup finds them
  found: AgentKind[];
  integrations?: AgentKind[];
  codexTrust(): Promise<HookTrust | undefined>;
  // whether the shims hold what setup would write now
  shimsCurrent: boolean;
  // the program this build's plist starts svalld with
  daemon: string[];
};
const LOG_LINES = 20;

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

// the process listening on the port, on `host` alone when given, as lsof names it
async function heldBy(d: DoctorDeps, port: number, host?: string): Promise<string | undefined> {
  try {
    const out = await d.run('lsof', ['-nP', `-iTCP${host ? `@${host}` : ''}:${port}`, '-sTCP:LISTEN', '-Fpc']);
    const pid = /^p(\d+)$/m.exec(out)?.[1];
    return pid && `${/^c(.+)$/m.exec(out)?.[1] ?? 'a process'} (pid ${pid})`;
  } catch { return undefined; }
}

async function svalld(t: Target, d: DoctorDeps): Promise<Check> {
  const paths = resolvePaths(t.home);
  const port = d.read(paths.port)?.trim();
  if (!port) {
    // svalld does not start while another process listens on the port config.json sets, on its host: one on another
    // address, even a wildcard, leaves that bind free
    let set: number | undefined;
    let host: string | undefined;
    try { ({ port: set, host } = parseConfig(d.read(paths.config) ?? '{}', paths.config)); } catch { /* the config check reports it */ }
    const by = set ? await heldBy(d, set, host) : undefined;
    if (by) return { name: 'svalld', status: 'fail', detail: `not running: ${by} holds port ${set}, which ${paths.config} sets; stop it, or take port out of config.json` };
    // the daemon runs while Svall is open on the fleet; one that stopped otherwise says why in the log below
    return { name: 'svalld', status: 'warn', detail: `not running (no port file in ${t.home}): it starts when Svall opens on this fleet` };
  }
  try {
    (await d.connect(t.home)).close();
    return { name: 'svalld', status: 'ok', detail: `running on port ${port}` };
  } catch (e) {
    const by = await heldBy(d, Number(port));
    return { name: 'svalld', status: 'fail', detail: `port ${port} does not answer: ${(e as Error).message}${by ? `; ${by} holds it` : ''}` };
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
  const lacks = AGENT_KINDS.map((k) => AGENTS[k].bin).filter((bin) => finds(d.pathEnv.split(':'), bin) && !finds(run.path, bin));
  return lacks.length
    ? { name: 'daemon path', status: 'warn', detail: `the PATH in ${plist} has no ${lacks.join(' or ')}, which this shell finds: ${fix}` }
    : { name: 'daemon path', status: 'ok', detail: 'its program is there, and it finds claude and codex as this shell does' };
}

// launchd gives svalld only the plist's environment, which setup took from the shell it ran in
function daemonEnv(t: Target, d: DoctorDeps): Check {
  if (!t.managed) return { name: 'daemon env', status: 'skip', detail: 'not managed' };
  const keys = Object.keys(d.daemonEnv);
  if (!keys.length) return { name: 'daemon env', status: 'ok', detail: 'this shell sets none of CLAUDE_CONFIG_DIR, CODEX_HOME, XDG_CONFIG_HOME or XDG_DATA_HOME' };
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
    ok = settings !== undefined && hooksInstalled(settings, d.hooksHome);
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
  if (!written) return { name: 'codex hooks', status: 'fail', detail: `not installed in ${d.codex.hooks}: ${SHIM} setup` };
  if (!current) return { name: 'codex hooks', status: 'warn', detail: `out of date in ${d.codex.hooks}: run ${SHIM} setup, then trust them in Codex` };
  const trust = await d.codexTrust();
  if (!trust) return { name: 'codex hooks', status: 'ok', detail: `installed in ${d.codex.hooks}; couldn't ask Codex about trust, check /hooks in Codex` };
  return trust.untrusted
    ? { name: 'codex hooks', status: 'warn', detail: 'not trusted yet: start codex and choose "Trust all and continue", or trust them in /hooks' }
    : { name: 'codex hooks', status: 'ok', detail: `installed in ${d.codex.hooks}; trusted` };
}

export function opencodeCheck(d: Pick<DoctorDeps, 'opencode' | 'exists' | 'read' | 'found' | 'integrations'>): Check {
  if (d.integrations && !d.integrations.includes('opencode')) return { name: 'opencode plugin', status: 'skip', detail: 'turned off in setup' };
  if (!d.found.includes('opencode') && !d.exists(d.opencode.dir)) return { name: 'opencode plugin', status: 'skip', detail: 'not installed' };
  const text = d.read(d.opencode.plugin);
  if (text === undefined) return { name: 'opencode plugin', status: 'fail', detail: `not installed in ${d.opencode.plugin}: ${SHIM} setup` };
  return opencodePluginCurrent(text)
    ? { name: 'opencode plugin', status: 'ok', detail: `installed in ${d.opencode.plugin}` }
    : { name: 'opencode plugin', status: 'warn', detail: `out of date in ${d.opencode.plugin}: run ${SHIM} setup` };
}

function shims(d: DoctorDeps): Check {
  return d.shimsCurrent
    ? { name: 'shims', status: 'ok', detail: `${SHIM} in ${d.shimDir} runs this build` }
    : { name: 'shims', status: 'warn', detail: `missing or not what this build writes: run ${SHIM} setup from the build you use` };
}

// only the build it runs: the plist's PATH and env come from the shell setup ran in, which the daemon checks compare
function plistCheck(t: Target, d: DoctorDeps): Check {
  if (!t.managed) return { name: 'launchd plist', status: 'skip', detail: 'not managed' };
  const { plist, fix } = plistOf(t, d);
  const text = d.read(plist);
  if (text === undefined) return { name: 'launchd plist', status: 'warn', detail: `missing: ${fix}` };
  return plistRun(text).program.join('\n') === d.daemon.join('\n')
    ? { name: 'launchd plist', status: 'ok', detail: `${plist} runs this build` }
    : { name: 'launchd plist', status: 'warn', detail: `runs another build: ${fix}, from the build you use` };
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
    opencodeCheck(d),
    shims(d),
    plistCheck(t, d),
  ];
  const lines = (d.read(log) ?? '').split('\n').filter(Boolean).slice(-LOG_LINES);
  return { home: t.home, checks, log: { path: log, lines } };
}

function connectHook(path: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(path);
    socket.setTimeout(1000, () => socket.destroy(new Error('timed out')));
    socket.once('connect', () => { socket.destroy(); resolve(); });
    socket.once('error', reject);
  });
}

export function doctorCommand(target: () => Target, json: () => boolean): Command {
  return new Command('doctor').description('check what the fleet needs and show the end of its log; changes nothing').action(async () => {
    const t = target();
    let integrations: AgentKind[] | undefined;
    try { integrations = loadConfig(resolvePaths(profileHome(PRIVATE)).config).integrations; } catch { /* the private fleet's doctor reports it */ }
    const { claudeSettings, launchAgents, shimDir } = userPaths();
    const report = { version: checkoutVersion(), ...await doctor(t, {
      ...realPreflightDeps(t.home),
      read: readOrUndefined,
      connect: (home) => Client.connect(home),
      connectHook,
      uid: os.userInfo().uid,
      settingsPath: claudeSettings,
      hooksHome: profileHome(PRIVATE),
      launchAgentsDir: launchAgents,
      daemonEnv: launchdEnv(),
      codex: codexPaths(),
      opencode: opencodePaths(),
      exists: fs.existsSync,
      found: findAgents(process.env.PATH ?? ''),
      integrations,
      codexTrust: () => askCodexTrust({ codexHome: codexPaths().dir, script: resolvePaths(profileHome(PRIVATE)).hookScript }),
      shimsCurrent: shimsCurrent(shimDir, ownRuntime()),
      daemon: ownRuntime().daemon,
    }) };
    printResult(report, json(), () => [
      `svall ${report.version}`,
      `fleet ${report.home}`,
      renderGroups(grouped(report.checks), useColor()),
      '',
      `last ${LOG_LINES} lines of ${report.log.path}:`,
      ...(report.log.lines.length ? report.log.lines : ['(empty)']),
    ].join('\n'));
    if (report.checks.some((c) => c.status === 'fail')) process.exitCode = 1;
  });
}
