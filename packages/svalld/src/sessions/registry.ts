import { execFile, spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { type AgentKind, type AgentAdapter, type TransferSession } from '@svall/protocol';
import { codexInstalled, hooksInstalled } from '../agent-hooks.js';
import { AGENTS, versionOf, versionOk } from '../agents.js';
import { robotKeyEnv } from '../claude.js';
import { BWRAP_PROFILE, USERNS_RESTRICTED, codexPaths } from '../codex/install.js';
import { opencodePaths } from '../opencode/install.js';
import { claudePaths, resolvePaths } from '../paths.js';
import { PRIVATE, profileHome } from '../profile.js';
import { writeDurable, type DurableStages } from '../durable.js';
import { claudeAdapter } from './claude.js';
import { codexAdapter } from './codex.js';
import { opencodeAdapter } from './opencode.js';
import { SessionError, type CliRun, type SessionAdapter } from './types.js';

export const SESSION_ADAPTERS: readonly SessionAdapter[] = [claudeAdapter, codexAdapter, opencodeAdapter];

/** The agent kinds whose sessions a move carries. */
export const HANDOVER_KINDS: readonly AgentKind[] = [...new Set(SESSION_ADAPTERS.map((a) => a.kind))];

/** The adapter that carries sessions of this CLI release: one whose minimum it has reached. */
export const adapterFor = (kind: AgentKind, version: string): SessionAdapter | undefined =>
  SESSION_ADAPTERS.find((a) => a.kind === kind && versionOk({ minVersion: a.min }, version));

/** The adapter a manifest names for a session: the kind's current one when it names none. */
export function sessionAdapter(kind: AgentKind, adapter?: number): SessionAdapter {
  const found = SESSION_ADAPTERS.filter((a) => a.kind === kind && (adapter === undefined || a.adapter === adapter)).at(-1);
  if (!found) throw new SessionError('incompatible_adapter', `this machine has no ${kind} session adapter ${adapter ?? ''}`.trim());
  return found;
}

/** The reads and writes placing a session makes, so a test can fail one. */
export type InstallFs = { read(file: string): Buffer | undefined; mkdir(dir: string): void; stages?: Partial<DurableStages> };

const realInstallFs: InstallFs = {
  read: (file) => { try { return fs.readFileSync(file); } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw e; } },
  mkdir: (dir) => { fs.mkdirSync(dir, { recursive: true, mode: 0o700 }); },
};

/** Places a carried session byte for byte from `staged`. A file here is kept when the same and replaced when the incoming one
 *  only adds to it, as a session that went away and grew does; anything else means it went on here, and nothing is written. */
export function installSession(session: TransferSession, staged: string, io: InstallFs = realInstallFs): { transcriptPath: string } {
  const { sourceHome, destinationHome, destinationPath } = session;
  if (!sourceHome || !destinationHome || !destinationPath) throw new SessionError('incompatible_adapter', `session ${session.sessionId} has no place on this machine`);
  const adapter = sessionAdapter(session.agent, session.adapter);
  const transcript = path.posix.relative(sourceHome, session.sourcePath);
  const to = path.posix.relative(destinationHome, destinationPath);
  // every file stays under the agent home the manifest names for it
  const outside = [transcript, to, ...session.files.map((f) => f.path)].find((p) => p.startsWith('/') || p.split('/').includes('..'));
  if (outside !== undefined) throw new SessionError('path_unsupported', `session ${session.sessionId} names ${outside}, outside its agent home`);
  if (to !== transcript) throw new SessionError('path_unsupported', `session ${session.sessionId} lands at ${to}, not ${transcript}, under ${destinationHome}`);
  // and is one of this session's own files, where its CLI keeps them
  const foreign = [
    ...(adapter.carries(transcript, transcript, session.sessionId) ? [] : [transcript]),
    ...session.files.map((f) => f.path).filter((p) => !adapter.carries(p, transcript, session.sessionId)),
  ];
  if (foreign.length) throw new SessionError('path_unsupported', `session ${session.sessionId} names ${foreign.join(', ')}, which is no file of that session`);
  const exported = adapter.exportFile?.(session.sessionId);
  if (exported !== undefined && !session.files.some((f) => f.path === exported)) {
    throw new SessionError('transcript_missing', `session ${session.sessionId} came without ${exported}, which its CLI reads it back in from`);
  }

  const writes: { file: string; data: Buffer }[] = [];
  const diverged: string[] = [];
  for (const f of session.files) {
    if (f.type !== 'file') throw new SessionError('incompatible_adapter', `${f.path} is a link, which no session carries`);
    const data = io.read(path.join(staged, f.path));
    if (!data || data.length !== f.size || crypto.createHash('sha256').update(data).digest('hex') !== f.sha256) {
      throw new Error(`the staged ${f.path} is not the file the manifest names`);
    }
    if (f.path === exported) continue;
    const file = path.posix.join(destinationHome, f.path);
    const held = io.read(file);
    if (held?.equals(data)) continue;
    if (held && !(held.length < data.length && data.subarray(0, held.length).equals(held))) { diverged.push(file); continue; }
    writes.push({ file, data });
  }
  if (diverged.length) {
    throw new SessionError('destination_diverged', `the destination's ${AGENTS[session.agent].label} went on with session ${session.sessionId} past the copy coming in: ${diverged.join(', ')}`);
  }
  // the transcript goes last, so a CLI that finds it finds everything beside it too
  for (const w of writes.sort((a, b) => Number(a.file === destinationPath) - Number(b.file === destinationPath))) {
    io.mkdir(path.dirname(w.file));
    writeDurable(w.file, w.data, { mode: 0o600, stages: io.stages });
  }
  return { transcriptPath: destinationPath };
}

/** `sandbox` says why the CLI cannot sandbox the commands its agent runs, when it cannot. */
export type AgentProbe = { kind: AgentKind; version?: string; home: string; loggedIn: boolean; hooks: boolean; sandbox?: string };

/** Runs a command to its exit, whatever the code; rejects only when it cannot start. */
export type AgentRun = (cmd: string, args: string[]) => Promise<{ code: number; stdout: string; stderr?: string }>;
export type ProbeDeps = { run: AgentRun; read(file: string): Promise<string | undefined>; env: NodeJS.ProcessEnv; homedir: string };

const json = (text: string | undefined): Record<string, unknown> | undefined => {
  try { return text === undefined ? undefined : JSON.parse(text); } catch { return undefined; }
};


/** Hooks are those setup points at the private fleet's scripts, in the config folder Claude Code names. OpenCode's sessions
 *  travel as the logs the private fleet keeps, its login is a model provider's, and its hooks are Svall's plugin. */
export async function probeAgent(kind: AgentKind, d: ProbeDeps): Promise<AgentProbe> {
  const hooksHome = profileHome(PRIVATE, d.homedir);
  const home = kind === 'claude' ? claudePaths(d.env, d.homedir).dir
    : kind === 'codex' ? codexPaths(d.env, d.homedir).dir : path.join(hooksHome, 'transcripts', 'opencode');
  let version: string | undefined;
  try { version = versionOf((await d.run(kind, ['--version'])).stdout); } catch { return { kind, home, loggedIn: false, hooks: false }; }
  if (kind === 'claude') {
    const status = json((await d.run('claude', ['auth', 'status'])).stdout);
    const dir = typeof status?.configDirectory === 'string' ? status.configDirectory : home;
    const settings = json(await d.read(path.join(dir, 'settings.json')));
    return { kind, version, home: dir, loggedIn: status?.loggedIn === true, hooks: !!settings && hooksInstalled(settings, hooksHome) };
  }
  if (kind === 'opencode') {
    const login = await d.run('opencode', AGENTS.opencode.loginArgs);
    return { kind, version, home, loggedIn: login.code === 0 && AGENTS.opencode.loggedIn(login.stdout), hooks: (await d.read(opencodePaths(d.env, d.homedir).plugin)) !== undefined };
  }
  const login = await d.run('codex', ['login', 'status']);
  const hooks = json(await d.read(codexPaths(d.env, d.homedir).hooks));
  // AppArmor's restriction denies bwrap a user namespace for each command unless a profile allows it
  const tried = (await d.read(USERNS_RESTRICTED))?.trim() === '1' ? await d.run('codex', ['sandbox', '--', 'true']) : undefined;
  const said = tried?.stderr?.trim() ?? '';
  const sandbox = !tried?.code ? undefined : /bwrap:|namespace|operation not permitted/i.test(said)
    ? `AppArmor keeps bwrap from making the user namespace Codex runs commands in, so a Codex robot asks before each one: ${BWRAP_PROFILE}`
    : `codex sandbox -- true fails there (${said.split('\n').at(-1) || `exit ${tried.code}, nothing said`}): run it there to see why`;
  return { kind, version, home, loggedIn: login.code === 0, hooks: !!hooks && codexInstalled(hooks, resolvePaths(hooksHome).hookScript), ...(sandbox && { sandbox }) };
}

/** `timeoutMs` reads as a failed run; rejects only when the CLI cannot start. `keys` are added to this daemon's env. */
const runAgent = (keys: () => Record<string, string>, timeoutMs = 10_000): AgentRun => (cmd, args) => new Promise((resolve, reject) => {
  execFile(cmd, args, { timeout: timeoutMs, maxBuffer: 1024 * 1024, env: { ...process.env, ...keys() } }, (err, stdout, stderr) => {
    const code = (err as { code?: unknown } | null)?.code;
    if (typeof code === 'string') reject(err);
    else resolve({ code: err ? (typeof code === 'number' ? code : -1) : 0, stdout: String(stdout), stderr: String(stderr) });
  });
});

// how long a CLI sent SIGTERM at its deadline has before SIGKILL
const KILL_GRACE = 2000;

/** Runs an agent CLI with this daemon's env, as the agents it starts have it, less what would make Svall's hooks take it for
 *  a robot's. One still running at `timeoutMs` gets SIGTERM, then SIGKILL, and the run rejects at once. */
export const cliRunner = (env: NodeJS.ProcessEnv = process.env, timeoutMs = 120_000): CliRun => (cmd, args, o = {}) => new Promise((resolve, reject) => {
  const { SVALL_ROBOT_ID: _id, SVALL_CHAR_ID: _old, SVALL_TERM: _term, ...rest } = env;
  const out = o.stdout === undefined ? 'pipe' : fs.openSync(o.stdout, 'w', 0o600);
  const child = spawn(cmd, args, { env: rest, cwd: o.cwd ?? os.homedir(), stdio: ['ignore', out, 'pipe'] });
  if (typeof out === 'number') fs.closeSync(out);
  const read = (s: NodeJS.ReadableStream | null): (() => string) => {
    const chunks: Buffer[] = [];
    s?.on('data', (c: Buffer) => { if (chunks.length < 1024) chunks.push(c); });
    return () => Buffer.concat(chunks).toString('utf8');
  };
  const [stdout, stderr] = [read(child.stdout), read(child.stderr)];
  let killer: NodeJS.Timeout | undefined;
  const timer = setTimeout(() => {
    child.kill('SIGTERM');
    killer = setTimeout(() => child.kill('SIGKILL'), KILL_GRACE);
    killer.unref();
    reject(new Error(`${cmd} did not finish within ${timeoutMs / 1000} s`));
  }, timeoutMs);
  child.on('error', (e) => { clearTimeout(timer); reject(e); });
  child.on('close', (code) => {
    clearTimeout(timer);
    clearTimeout(killer);
    resolve({ code: code ?? -1, stdout: stdout(), stderr: stderr() });
  });
});

// each CLI is asked with the fleet's .env keys, as a resumed robot and doctor have them
export const realProbeDeps = (envFile: string): ProbeDeps => ({
  run: runAgent(() => robotKeyEnv(envFile)), read: (file) => fs.promises.readFile(file, 'utf8').catch(() => undefined), env: process.env, homedir: os.homedir(),
});

/** How to ask this machine's agent CLIs: as they last answered, or `fresh`. */
export type AgentProber = (fresh?: boolean) => Promise<AgentProbe[]>;

/** Every agent CLI as it last answered, asked again once `ttlMs` has passed or when asked `fresh`; callers in between share one probe. */
export function agentProber(d: ProbeDeps, ttlMs = 60_000, now: () => number = Date.now): AgentProber {
  let last: { at: number; probes: Promise<AgentProbe[]> } | undefined;
  return (fresh = false) => {
    if (fresh || !last || now() - last.at >= ttlMs) {
      // a CLI that fails mid-probe answers as one that is not there
      const probes = Promise.all(HANDOVER_KINDS.map((kind) => probeAgent(kind, d).catch((): AgentProbe => ({ kind, home: '', loggedIn: false, hooks: false }))));
      last = { at: now(), probes };
    }
    return last.probes;
  };
}

/** What `system.info` says of each installed CLI: its release, the adapter that reads its sessions (0 for none), its login, hooks and sandbox. */
export const agentAdapters = (probes: readonly AgentProbe[]): AgentAdapter[] => probes.map((p) => ({
  kind: p.kind, ...(p.version && { version: p.version }), adapter: (p.version && adapterFor(p.kind, p.version)?.adapter) || 0, home: p.home,
  loggedIn: p.loggedIn, hooks: p.hooks, ...(p.sandbox && { sandbox: p.sandbox }),
}));
