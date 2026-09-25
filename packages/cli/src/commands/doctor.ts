import { execFile } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { Command } from 'commander';
import { codexInstalled, codexPaths, type CodexPaths } from '@archipelago/archid/codex/install';
import { parseConfig } from '@archipelago/archid/config';
import { resolvePaths, userPaths } from '@archipelago/archid/paths';
import { PRIVATE, profileHome, profileLabel } from '@archipelago/archid/profile';
import { HOOK_EVENTS, claudeHooksCurrent, codexHooksCurrent, hooksInstalled, launchdEnv, plistEnv, plistRun } from '@archipelago/archid/setup';
import { tmuxTooOld } from '@archipelago/archid/tmux/conf';
import { Client, restartHint } from '../client.js';
import { printResult } from '../format.js';
import type { Target } from '../target.js';
import { checkoutVersion } from '../version.js';

export type Check = { name: string; status: 'ok' | 'warn' | 'fail' | 'skip'; detail: string };
export type Report = { home: string; checks: Check[]; log: { path: string; lines: string[] } };

export type DoctorDeps = {
  run(cmd: string, args: string[]): Promise<string>;
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
};
export type PreflightDeps = Pick<DoctorDeps, 'run' | 'node' | 'pathEnv' | 'shimDir'>;

const LOG_LINES = 20;
const firstLine = (s: string): string => s.trim().split('\n')[0] ?? '';
const missing = (e: unknown): boolean => (e as NodeJS.ErrnoException).code === 'ENOENT';

async function tmux(d: PreflightDeps): Promise<Check> {
  try {
    const v = firstLine(await d.run('tmux', ['-V']));
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
    : { name: 'node', status: 'fail', detail: `${d.node}: archipelago needs node 24 or newer` };
}

async function claude(d: PreflightDeps): Promise<Check> {
  try {
    return { name: 'claude', status: 'ok', detail: firstLine(await d.run('claude', ['--version'])) };
  } catch (e) {
    return { name: 'claude', status: 'fail', detail: missing(e) ? 'not found on PATH: install Claude Code, https://code.claude.com/docs/en/setup' : firstLine((e as Error).message) };
  }
}

function shimDirOnPath(d: PreflightDeps): Check {
  return d.pathEnv.split(':').includes(d.shimDir)
    ? { name: 'path', status: 'ok', detail: `${d.shimDir} is on PATH` }
    : { name: 'path', status: 'warn', detail: `${d.shimDir} is not on PATH, so your shell will not find archi; add it in your shell profile` };
}

export async function preflight(d: PreflightDeps): Promise<Check[]> {
  return [await tmux(d), node(d), await claude(d), shimDirOnPath(d)];
}

const MARK = { ok: '✓', warn: '!', fail: '✗', skip: '–' };
const checkLine = (c: Check): string => `${MARK[c.status]} ${c.name}  ${c.detail}`;

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

// archid waits, without starting, while its config.json does not parse
function config(t: Target, d: DoctorDeps): Check {
  const file = resolvePaths(t.home).config;
  const text = d.read(file);
  if (text === undefined) return { name: 'config', status: 'ok', detail: `the defaults, as there is no ${file}` };
  try {
    parseConfig(text, file);
    return { name: 'config', status: 'ok', detail: file };
  } catch (e) {
    return { name: 'config', status: 'fail', detail: `${(e as Error).message}; a stopped archid waits for it to be fixed` };
  }
}

async function archid(t: Target, d: DoctorDeps): Promise<Check> {
  const port = d.read(resolvePaths(t.home).port)?.trim();
  if (!port) return { name: 'archid', status: 'fail', detail: `not running (no port file in ${t.home}): the log below says why` };
  try {
    (await d.connect(t.home)).close();
    return { name: 'archid', status: 'ok', detail: `running on port ${port}` };
  } catch (e) {
    return { name: 'archid', status: 'fail', detail: `port ${port} does not answer: ${(e as Error).message}` };
  }
}

async function hookReceiver(t: Target, d: DoctorDeps): Promise<Check> {
  const path = resolvePaths(t.home).hooksSock;
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
    const running = fields.includes('state = running');
    return { name: 'launchd', status: running ? 'ok' : 'fail', detail: `${label}: ${fields.join(', ') || 'loaded'}` };
  } catch {
    return { name: 'launchd', status: 'fail', detail: `${label} is not loaded: archi ${t.name === PRIVATE ? 'setup' : t.name}` };
  }
}

// a fleet's launchd plist, and how to have it written again
function plistOf(t: Target, d: DoctorDeps): { plist: string; fix: string } {
  const label = profileLabel(t.name);
  const plist = path.join(d.launchAgentsDir, `${label}.plist`);
  return { plist, fix: t.name === PRIVATE ? 'archi setup' : `launchctl bootout gui/${d.uid}/${label}, delete ${plist}, then archi ${t.name}` };
}

// launchd finds node through the plist's PATH, which starts at the node setup ran with
function daemonNode(t: Target, d: DoctorDeps): Check {
  if (!t.managed) return { name: 'daemon node', status: 'skip', detail: 'not managed' };
  const { plist, fix } = plistOf(t, d);
  const dir = plistRun(d.read(plist) ?? '').path[0];
  if (!dir) return { name: 'daemon node', status: 'skip', detail: `no PATH in ${plist}` };
  if (!d.exists(path.join(dir, 'node'))) return { name: 'daemon node', status: 'warn', detail: `${dir}/node is gone: ${fix}` };
  return /^\/nix\/store\/|\/Cellar\/|\/v?\d+\.\d+\.\d+[^/]*\//.test(`${dir}/`)
    ? { name: 'daemon node', status: 'warn', detail: `${dir} belongs to one node version, and archid will not start once that version is removed; after changing node: ${fix}` }
    : { name: 'daemon node', status: 'ok', detail: `${dir}/node` };
}

// launchd runs the plist's tsx with only the plist's PATH, and logs nothing to archid.log when it cannot:
// a checkout moved or deleted since setup, or a claude or codex installed since outside that PATH
function daemonPath(t: Target, d: DoctorDeps): Check {
  if (!t.managed) return { name: 'daemon path', status: 'skip', detail: 'not managed' };
  const { plist, fix } = plistOf(t, d);
  const text = d.read(plist);
  if (text === undefined) return { name: 'daemon path', status: 'skip', detail: `no ${plist}` };
  const run = plistRun(text);
  if (run.tsx && !d.exists(run.tsx)) return { name: 'daemon path', status: 'fail', detail: `${run.tsx} is gone, so launchd cannot start archid: ${fix}` };
  const finds = (dirs: string[], bin: string) => dirs.some((dir) => d.exists(path.join(dir, bin)));
  const lacks = ['claude', 'codex'].filter((bin) => finds(d.pathEnv.split(':'), bin) && !finds(run.path, bin));
  return lacks.length
    ? { name: 'daemon path', status: 'warn', detail: `the PATH in ${plist} has no ${lacks.join(' or ')}, which this shell finds: ${fix}` }
    : { name: 'daemon path', status: 'ok', detail: 'its checkout is there, and it finds claude and codex as this shell does' };
}

// launchd gives archid only the plist's environment, which setup took from the shell it ran in
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
  if (!ok) return { name: 'hooks', status: 'fail', detail: `not installed in ${d.settingsPath}: archi setup` };
  if (disabled) return { name: 'hooks', status: 'fail', detail: `${d.settingsPath} sets disableAllHooks, so no character gets a status; remove it` };
  return current
    ? { name: 'hooks', status: 'ok', detail: `installed in ${d.settingsPath}` }
    : { name: 'hooks', status: 'warn', detail: `out of date in ${d.settingsPath}: run archi setup` };
}

// Codex keeps hook trust in its own state; this only verifies the hook definition is installed.
export async function codexCheck(d: Pick<DoctorDeps, 'codex' | 'exists' | 'read' | 'run' | 'hooksHome'>): Promise<Check> {
  if (!d.exists(d.codex.dir)) return { name: 'codex', status: 'skip', detail: 'not installed' };
  const script = resolvePaths(d.hooksHome).hookScript;
  let written = false;
  let current = false;
  try {
    const hooks = JSON.parse(d.read(d.codex.hooks) ?? '{}');
    written = codexInstalled(hooks, script);
    current = written && codexHooksCurrent(hooks, script);
  } catch { /* unparseable counts as missing */ }
  if (!written) return { name: 'codex', status: 'warn', detail: `hooks not installed in ${d.codex.hooks}: archi setup` };
  if (!current) return { name: 'codex', status: 'warn', detail: `hooks out of date in ${d.codex.hooks}: run archi setup, then trust them with /hooks in Codex` };
  try {
    const v = firstLine(await d.run('codex', ['--version']));
    return { name: 'codex', status: 'ok', detail: `${v}; hooks installed (review trust with /hooks in Codex)` };
  } catch (e) {
    return { name: 'codex', status: 'warn', detail: missing(e) ? 'hooks installed, but codex is not found on PATH' : firstLine((e as Error).message) };
  }
}

export async function doctor(t: Target, d: DoctorDeps): Promise<Report> {
  const log = resolvePaths(t.home).log;
  const checks = [
    ...await preflight(d),
    await gh(d),
    config(t, d),
    await archid(t, d),
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

export function realPreflightDeps(): PreflightDeps {
  return {
    run: async (cmd, args) => (await execFileP(cmd, args, { timeout: 10_000 })).stdout,
    node: process.version,
    pathEnv: process.env.PATH ?? '',
    shimDir: userPaths().shimDir,
  };
}

export function doctorCommand(target: () => Target, json: () => boolean): Command {
  return new Command('doctor').description('check what the fleet needs and show the end of its log; changes nothing').action(async () => {
    const report = { version: checkoutVersion(), ...await doctor(target(), {
      ...realPreflightDeps(),
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
    }) };
    const width = Math.max(...report.checks.map((c) => c.name.length));
    printResult(report, json(), () => [
      `archi ${report.version}`,
      `fleet ${report.home}`,
      ...report.checks.map((c) => `${MARK[c.status]} ${c.name.padEnd(width)}  ${c.detail}`),
      '',
      `last ${LOG_LINES} lines of ${report.log.path}:`,
      ...(report.log.lines.length ? report.log.lines : ['(empty)']),
    ].join('\n'));
    if (report.checks.some((c) => c.status === 'fail')) process.exitCode = 1;
  });
}
