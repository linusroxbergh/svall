import { execFile } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { Command } from 'commander';
import type { z } from 'zod';
import { FleetConfig, NodeConfig, type AgentKind } from '@svall/protocol';
import { claudeHooksCurrent, codexHooksCurrent, codexInstalled, hooksInstalled } from '@svall/svalld/agent-hooks';
import { AGENTS, AGENT_KINDS, findAgents } from '@svall/svalld/agents';
import { codexPaths, type CodexPaths } from '@svall/svalld/codex/install';
import { Config, configRefusal, parseConfig, peekConfig } from '@svall/svalld/config';
import { gatewayPaths, socketTooLong } from '@svall/svalld/gateway/authority';
import { gatewayPrefix } from '@svall/svalld/gateway/bin';
import { launchdEnv, plistEnv, plistRun } from '@svall/svalld/launchd';
import { lingerState, unitStatus, type Run } from '@svall/svalld/linux/service';
import { agentHomesEnv, svalldUnitName, GATEWAY_UNIT, unitDirOf, unitEnv } from '@svall/svalld/linux/setup';
import { claudePaths, resolvePaths, userPaths } from '@svall/svalld/paths';
import { PRIVATE, SHIM, profileHome, profileLabel } from '@svall/svalld/profile';
import { isRelease } from '@svall/svalld/release';
import { ownRuntime } from '@svall/svalld/runtime';
import { readOrUndefined } from '@svall/svalld/settings-file';
import { shimsCurrent } from '@svall/svalld/setup';
import { MARK, grouped, renderGroups, useColor, type Check } from '../checks-view.js';
import { Client, restartHint } from '../client.js';
import { askCodexTrust, type HookTrust } from '../codex-trust.js';
import { bundledRsync, rsyncVersion } from '../controller/rsync.js';
import { printResult } from '../format.js';
import type { Target } from '../target.js';
import { checkoutVersion } from '../version.js';
import { missing, preflight, realPreflightDeps, type PreflightDeps } from './preflight.js';

export type Report = { version?: string; home: string; config: { fleet: string; node: string }; checks: Check[]; log: { path: string; lines: string[] } };

export type DoctorDeps = PreflightDeps & {
  read(file: string): string | undefined;
  connect(home: string): Promise<{ close(): void }>;
  connectHook(path: string): Promise<void>;
  uid: number;
  settingsPath: string;
  // the fleet whose scripts setup points the Claude and Codex hooks at
  hooksHome: string;
  launchAgentsDir: string;
  // where the Linux daemons' units lie
  unitDir: string;
  // what setup would hand a fleet's daemon from this account
  daemonEnv: Record<string, string>;
  codex: CodexPaths;
  exists(path: string): boolean;
  // agent CLIs on PATH, as setup finds them
  found: AgentKind[];
  integrations?: AgentKind[];
  codexTrust(): Promise<HookTrust | undefined>;
  // whether the shims hold what setup would write now
  shimsCurrent: boolean;
  // the program this build's plist starts svalld with
  daemon: string[];
  user: string;
  // the rsync this Mac hands over with, and how to get it back when it is missing
  rsync: { bundled: string; fix: string };
};
const LOG_LINES = 20;
const firstLine = (s: string): string => s.trim().split('\n')[0] ?? '';

async function gh(d: DoctorDeps): Promise<Check> {
  try {
    await d.run('gh', ['auth', 'status']);
    return { name: 'gh', status: 'ok', detail: 'logged in' };
  } catch (e) {
    const install = d.platform === 'linux' ? 'sudo apt install gh' : 'brew install gh';
    const why = missing(e) ? `not found on PATH: ${install}` : 'not logged in: gh auth login';
    return { name: 'gh', status: 'warn', detail: `${why} (pull request links stay unresolved)` };
  }
}

// svalld waits, without starting, while its fleet.json or node.json does not parse, or the config.json they are
// still to be split out of, or its config files lie in a layout it refuses
function config(t: Target, d: DoctorDeps): Check {
  const p = resolvePaths(t.home);
  const refused = configRefusal(p, (file) => d.exists(file));
  if (refused) return { name: 'config', status: 'fail', detail: `${refused.replace(/\.$/, '')}; a stopped svalld waits for it to be fixed` };
  const files: [string, z.ZodTypeAny][] = d.read(p.fleetConfig) === undefined && d.read(p.legacyConfig) !== undefined
    ? [[p.legacyConfig, Config]]
    : [[p.fleetConfig, FleetConfig], [p.nodeConfig, NodeConfig]];
  const found = files.flatMap(([file, schema]) => { const text = d.read(file); return text === undefined ? [] : [{ file, text, schema }]; });
  if (!found.length) return { name: 'config', status: 'ok', detail: `the defaults, as there is no ${p.fleetConfig}` };
  try {
    for (const f of found) parseConfig(f.text, f.file, f.schema);
    return { name: 'config', status: 'ok', detail: found.map((f) => f.file).join(' and ') };
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
// a checkout, app or release moved or deleted since setup, or a claude or codex installed since outside that PATH
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

// launchd and systemd give svalld only the environment its plist or unit holds, which setup took from this account
function daemonEnv(t: Target, d: DoctorDeps): Check {
  if (!t.managed) return { name: 'daemon env', status: 'skip', detail: 'not managed' };
  const keys = Object.keys(d.daemonEnv);
  if (!keys.length) return { name: 'daemon env', status: 'ok', detail: 'this account sets no CLAUDE_CONFIG_DIR or CODEX_HOME' };
  const linux = d.platform === 'linux';
  const { plist: file, fix } = linux
    ? { plist: path.join(d.unitDir, svalldUnitName(t.name)), fix: t.name === PRIVATE ? `${SHIM} setup` : `${SHIM} host enable <this machine> --fleet ${t.name} from the controller` }
    : plistOf(t, d);
  const text = d.read(file);
  if (text === undefined) return { name: 'daemon env', status: 'skip', detail: `no ${file}` };
  const lacks = keys.filter((k) => !text.includes((linux ? unitEnv : plistEnv)(k, d.daemonEnv[k])));
  return lacks.length
    ? { name: 'daemon env', status: 'warn', detail: `${file} lacks ${lacks.join(' and ')}, which this account sets: ${fix}` }
    : { name: 'daemon env', status: 'ok', detail: `same ${keys.join(' and ')} as this account` };
}

// the wrappers take stdout and stderr; doctor's runner reports a failure by throwing
const asRun = (d: DoctorDeps): Run => async (cmd, args) => ({ stdout: await d.run(cmd, args), stderr: '' });

async function unitCheck(name: string, unit: string, d: DoctorDeps, why?: () => string | undefined): Promise<Check> {
  try {
    const s = await unitStatus(asRun(d), unit);
    const detail = `${unit}: ${s.load}, ${s.active} (${s.sub}), ${s.state}`;
    if (s.load === 'not-found') return { name, status: 'fail', detail: `${unit} is not installed: ${SHIM} setup` };
    if (s.active === 'active') return { name, status: 'ok', detail };
    const cause = why?.();
    return { name, status: 'fail', detail: cause ? `${detail}; ${cause}` : detail };
  } catch (e) {
    return { name, status: 'fail', detail: (e as Error).message };
  }
}

function systemd(t: Target, d: DoctorDeps): Promise<Check> {
  if (!t.managed) return Promise.resolve({ name: 'systemd', status: 'ok', detail: `not managed: ${t.home} is not a profile home` });
  return unitCheck('systemd', svalldUnitName(t.name), d);
}

async function linger(d: DoctorDeps): Promise<Check> {
  try {
    const l = await lingerState(asRun(d), d.user);
    return l.linger
      ? { name: 'linger', status: 'ok', detail: `on for ${l.user}: the fleet keeps running after you log out` }
      : { name: 'linger', status: 'warn', detail: `off for ${l.user}: the fleet stops when you log out; run ${l.action}` };
  } catch (e) {
    return { name: 'linger', status: 'warn', detail: (e as Error).message };
  }
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

async function rsyncAt(d: DoctorDeps, exe: string): Promise<{ version: string } | { reason: string }> {
  try {
    return rsyncVersion(await d.run(exe, ['--version']));
  } catch (e) {
    return { reason: missing(e) ? 'is not there' : `could not run: ${firstLine((e as Error).message)}` };
  }
}

/** The rsync a handover runs on this Mac. macOS's own is openrsync, which cannot stand in for it. */
async function rsync(d: DoctorDeps): Promise<Check> {
  const bundled = await rsyncAt(d, d.rsync.bundled);
  if ('version' in bundled) return { name: 'rsync', status: 'ok', detail: `${bundled.version} at ${d.rsync.bundled}` };
  const system = await rsyncAt(d, 'rsync');
  const fallback = 'version' in system ? `the rsync on PATH is ${system.version}, which handover does not use` : `the rsync on PATH ${system.reason}`;
  return { name: 'rsync', status: 'warn', detail: `${d.rsync.bundled} ${bundled.reason}, and ${fallback}; handover needs the bundled rsync: ${d.rsync.fix}` };
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
  const paths = resolvePaths(t.home);
  const linux = d.platform === 'linux';
  const checks = [
    ...await preflight(d),
    await gh(d),
    config(t, d),
    await svalld(t, d),
    await hookReceiver(t, d),
    ...(linux
      ? [await systemd(t, d), daemonEnv(t, d), await unitCheck('gateway', GATEWAY_UNIT, d, () => socketTooLong(gatewayPaths(gatewayPrefix()).socket, 'linux')?.message), await linger(d)]
      : [await launchd(t, d), daemonNode(t, d), daemonPath(t, d), daemonEnv(t, d), await rsync(d)]),
    hooks(d),
    await codexCheck(d),
    shims(d),
    ...(linux ? [] : [plistCheck(t, d)]),
  ];
  const lines = (d.read(paths.log) ?? '').split('\n').filter(Boolean).slice(-LOG_LINES);
  return {
    home: t.home,
    config: { fleet: paths.fleetConfig, node: paths.nodeConfig },
    checks,
    log: { path: paths.log, lines },
  };
}

/** One padded line per check, for a report too short to group. */
export function checkLines(checks: Check[]): string[] {
  const width = Math.max(...checks.map((c) => c.name.length));
  return checks.map((c) => `${MARK[c.status]} ${c.name.padEnd(width)}  ${c.detail}`);
}

/** What `svall doctor` prints when it is not asked for JSON. */
export function reportLines(report: Report, color = false): string[] {
  return [
    ...(report.version ? [`svall ${report.version}`] : []),
    `fleet ${report.home}`,
    `config ${report.config.fleet} and ${report.config.node}`,
    renderGroups(grouped(report.checks), color),
    '',
    `last ${LOG_LINES} lines of ${report.log.path}:`,
    ...(report.log.lines.length ? report.log.lines : ['(empty)']),
  ];
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

export function doctorCommand(target: () => Target, json: () => boolean, platform: NodeJS.Platform = process.platform): Command {
  return new Command('doctor').description('check what the fleet needs and show the end of its log; changes nothing').action(async () => {
    const t = target();
    let integrations: AgentKind[] | undefined;
    try { integrations = peekConfig(resolvePaths(profileHome(PRIVATE))).integrations; } catch { /* the private fleet's doctor reports it */ }
    const { launchAgents, shimDir } = userPaths();
    const pre = realPreflightDeps(t.home, platform);
    // a login shell asked over ssh must leave host add's doctor its own time to answer
    const daemonEnv = platform === 'linux' ? await agentHomesEnv((cmd, args) => execFileP(cmd, args, { timeout: 10_000 })) : launchdEnv();
    // the hooks are checked where the daemon's agents read them, which an ssh command's env may not name
    const codex = codexPaths(daemonEnv);
    const report = { version: checkoutVersion(), ...await doctor(t, {
      ...pre,
      read: readOrUndefined,
      connect: (home) => Client.connect(home),
      connectHook,
      uid: os.userInfo().uid,
      settingsPath: path.join(claudePaths(daemonEnv).dir, 'settings.json'),
      hooksHome: profileHome(PRIVATE),
      launchAgentsDir: launchAgents,
      unitDir: unitDirOf(os.homedir()),
      daemonEnv,
      codex,
      exists: fs.existsSync,
      found: findAgents(pre.agentPath ?? pre.pathEnv),
      integrations,
      codexTrust: () => askCodexTrust({ codexHome: codex.dir, script: resolvePaths(profileHome(PRIVATE)).hookScript }),
      shimsCurrent: shimsCurrent(shimDir, ownRuntime()),
      daemon: ownRuntime().daemon,
      user: os.userInfo().username,
      rsync: {
        bundled: bundledRsync(),
        fix: isRelease() ? 'reinstall Svall; its release carries one in bin/' : 'build it with node scripts/build-controller.mjs',
      },
    }) };
    printResult(report, json(), () => reportLines(report, useColor()).join('\n'));
    if (report.checks.some((c) => c.status === 'fail')) process.exitCode = 1;
  });
}
