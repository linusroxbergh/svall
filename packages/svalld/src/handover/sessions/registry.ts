import { execFile, spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  type AgentKind, type AgentAdapter, type Blocker, type Character, type FleetState, type ResumeFolder, type TransferManifestV1, type TransferSession,
} from '@svall/protocol';
import { codexInstalled, hooksInstalled } from '../../agent-hooks.js';
import { versionOk } from '../../agents.js';
import { codexPaths } from '../../codex/install.js';
import { opencodePaths } from '../../opencode/install.js';
import { claudePaths, resolvePaths } from '../../paths.js';
import { PRIVATE, profileHome } from '../../profile.js';
import { writeDurable, type DurableStages } from '../durable.js';
import { holds } from '../portable-path.js';
import { claudeAdapter } from './claude.js';
import { codexAdapter } from './codex.js';
import { opencodeAdapter } from './opencode.js';
import { versionOf } from './records.js';
import { SessionError, type CliRun, type SessionAdapter } from './types.js';

/** Every session adapter, each for one agent kind from its minimum release on. */
export const SESSION_ADAPTERS: readonly SessionAdapter[] = [claudeAdapter, codexAdapter, opencodeAdapter];

/** The agent kinds a handover carries sessions of; it refuses a fleet that runs any other. */
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

export const realInstallFs: InstallFs = {
  read: (file) => { try { return fs.readFileSync(file); } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw e; } },
  mkdir: (dir) => { fs.mkdirSync(dir, { recursive: true, mode: 0o700 }); },
};

/**
 * Puts one carried session in place under this machine's agent home, where the source's agent home had it, byte for
 * byte. `staged` holds the source's bytes at their manifest paths. A file already here is kept when it is the same,
 * and replaced when the incoming one only adds to it, as a session that went away and grew does; anything else means
 * the session was continued here, and nothing is written.
 */
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
  if (diverged.length) throw new SessionError('destination_diverged', `this machine continued session ${session.sessionId}: ${diverged.join(', ')}`);
  // the transcript goes last, so a CLI that finds it finds everything beside it too
  for (const w of writes.sort((a, b) => Number(a.file === destinationPath) - Number(b.file === destinationPath))) {
    io.mkdir(path.dirname(w.file));
    writeDurable(w.file, w.data, { mode: 0o600, stages: io.stages });
  }
  return { transcriptPath: destinationPath };
}

/** Where a terminal's agent resumes and, when its character's repository holds that, the repository's main checkout and the top of its own; `at` makes each absolute. */
export function resumeFolder(c: Character, term: 2 | undefined, at: (p: string) => string): Omit<ResumeFolder, 'kind'> {
  const cwd = at(term === 2 ? c.second?.cwd ?? c.cwd : c.cwd);
  if (!c.repo || !holds(at(c.repo.root), cwd)) return { cwd };
  return { cwd, repo: at(c.repo.mainRoot), root: at(c.repo.root) };
}

/** Where each session the manifest carries resumes on the destination, which is where it ran on the source, and whether its revive asks for bypass mode. */
export function resumeFolders(m: TransferManifestV1): (ResumeFolder & { characterId: string })[] {
  const at = (p: string) => (p === '~' || p.startsWith('~/') ? path.posix.join(m.home, p.slice(1)) : p);
  return m.sessions.flatMap((s) => {
    const c = m.snapshot.characters[s.characterId];
    if (!c) return [];
    const bypass = sessionAdapter(s.agent).asksBypass?.((s.term === 2 ? c.second : c)?.revive?.command ?? '');
    return [{ characterId: s.characterId, kind: s.agent, ...resumeFolder(c, s.term, at), ...(bypass && { bypass }) }];
  });
}

/** The imported state with every agent pointing at the transcript its session was placed as. */
export function placeTranscripts(state: FleetState, sessions: readonly TransferSession[]): FleetState {
  const next = structuredClone(state);
  for (const c of Object.values(next.characters)) {
    for (const [term, slot] of [[undefined, c], [2, c.second]] as const) {
      if (!slot?.agent) continue;
      const placed = sessions.find((s) => s.characterId === c.id && s.term === term && s.sessionId === slot.agent!.sessionId)?.destinationPath;
      if (!placed) throw new Error(`${c.id}'s ${term ? 'second ' : ''}${slot.agent.kind} session was not placed on this machine`);
      slot.agent.transcriptPath = placed;
    }
  }
  return next;
}

/** What one machine's agent CLI says about itself: its release, where it keeps its files, its login and whether Svall's hooks are in. */
export type AgentProbe = { kind: AgentKind; version?: string; home: string; loggedIn: boolean; hooks: boolean };

/** Runs a command to its exit, whatever the code; rejects only when it cannot start. */
export type AgentRun = (cmd: string, args: string[]) => Promise<{ code: number; stdout: string }>;
export type ProbeDeps = { run: AgentRun; read(file: string): Promise<string | undefined>; env: NodeJS.ProcessEnv; homedir: string };

const json = (text: string | undefined): Record<string, unknown> | undefined => {
  try { return text === undefined ? undefined : JSON.parse(text); } catch { return undefined; }
};

/**
 * Probes this machine's CLI for one agent. Claude Code names its own config folder, which is where its hooks must be;
 * the hooks are the ones setup points at the private fleet's scripts. OpenCode's sessions travel as the logs the
 * private fleet keeps of them, and its hooks are Svall's plugin.
 */
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
    const login = await d.run('opencode', ['auth', 'list', '--standalone']);
    return { kind, version, home, loggedIn: login.code === 0, hooks: (await d.read(opencodePaths(d.env, d.homedir).plugin)) !== undefined };
  }
  const login = await d.run('codex', ['login', 'status']);
  const hooks = json(await d.read(codexPaths(d.env, d.homedir).hooks));
  return { kind, version, home, loggedIn: login.code === 0, hooks: !!hooks && codexInstalled(hooks, resolvePaths(hooksHome).hookScript) };
}

/** Runs a CLI to its exit, or to `timeoutMs`, which reads as a failed run; rejects only when it cannot start. */
const runAgent = (timeoutMs = 10_000): AgentRun => (cmd, args) => new Promise((resolve, reject) => {
  execFile(cmd, args, { timeout: timeoutMs, maxBuffer: 1024 * 1024 }, (err, stdout) => {
    const code = (err as { code?: unknown } | null)?.code;
    if (typeof code === 'string') reject(err);
    else resolve({ code: err ? (typeof code === 'number' ? code : -1) : 0, stdout: String(stdout) });
  });
});

// how long a CLI sent SIGTERM at its deadline has before SIGKILL
const KILL_GRACE = 2000;

/**
 * Runs an agent CLI with this daemon's env, which places its files as the agents it starts find them, less the
 * variables that would make Svall's own hooks take the run for a character's, in the home unless told where. One
 * still running at `timeoutMs` is sent SIGTERM, then SIGKILL, and the run rejects at once.
 */
export const cliRunner = (env: NodeJS.ProcessEnv = process.env, timeoutMs = 120_000): CliRun => (cmd, args, o = {}) => new Promise((resolve, reject) => {
  const { SVALL_CHAR_ID: _id, SVALL_TERM: _term, ...rest } = env;
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

export const realProbeDeps = (): ProbeDeps => ({
  run: runAgent(), read: (file) => fs.promises.readFile(file, 'utf8').catch(() => undefined), env: process.env, homedir: os.homedir(),
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

/** What `system.info` says of each installed CLI: its release, the adapter that reads its sessions (0 for none), its login and hooks. */
export const agentAdapters = (probes: readonly AgentProbe[]): AgentAdapter[] => probes.map((p) => ({
  kind: p.kind, ...(p.version && { version: p.version }), adapter: (p.version && adapterFor(p.kind, p.version)?.adapter) || 0, home: p.home,
  loggedIn: p.loggedIn, hooks: p.hooks,
}));

/**
 * What stops the agents the fleet runs from resuming on the destination: a CLI that is not there, a release on
 * either machine older than its adapter's minimum or the two read by different adapters, a destination not logged
 * in, or one without Svall's hooks, whose SessionStart is how a resumed agent reports back.
 */
export function agentBlockers(o: { kinds: readonly AgentKind[]; source: readonly AgentProbe[]; destination: readonly AgentProbe[] }): Blocker[] {
  const blockers: Blocker[] = [];
  for (const kind of new Set(o.kinds)) {
    if (!HANDOVER_KINDS.includes(kind)) { blockers.push({ code: 'incompatible_adapter', message: `a handover carries no ${kind} sessions` }); continue; }
    const there = o.destination.find((p) => p.kind === kind);
    if (!there?.version) { blockers.push({ code: 'agent_cli_missing', message: `the destination has no ${kind} CLI` }); continue; }
    const here = o.source.find((p) => p.kind === kind);
    const [a, b] = [here?.version && adapterFor(kind, here.version), adapterFor(kind, there.version)];
    const unsupported = [here?.version && !a && `this machine's ${kind} ${here.version}`, !b && `the destination's ${kind} ${there.version}`].filter(Boolean);
    if (unsupported.length) {
      blockers.push({ code: 'incompatible_adapter', message: `a handover carries ${kind} sessions from ${sessionAdapter(kind).min.join('.')} on; update ${unsupported.join(' and ')}` });
      continue;
    }
    if (a && b && a !== b) blockers.push({ code: 'incompatible_adapter', message: `${kind} sessions are read by adapter ${a.adapter} here and ${b.adapter} on the destination` });
    if (!there.loggedIn) blockers.push({ code: 'agent_logged_out', message: `${kind} is not logged in on the destination` });
    if (!there.hooks) {
      blockers.push({
        code: 'agent_hooks_missing',
        message: kind === 'opencode'
          ? `Svall's plugin is not installed for OpenCode on the destination (${opencodePaths({}, '~').plugin}, or under its XDG_CONFIG_HOME): run svall setup there`
          : `Svall's hooks are not installed for ${kind} on the destination (${there.home}): run svall setup there`,
      });
    }
  }
  return blockers;
}
