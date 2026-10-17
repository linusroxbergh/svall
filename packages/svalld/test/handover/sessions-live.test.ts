import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { emptyState, FleetConfig, type AgentKind, type MachineId, type TransferSession } from '@svall/protocol';
import { sha256Hex } from '../../src/handover/hash.js';
import { buildInventory } from '../../src/handover/inventory.js';
import { buildManifest } from '../../src/handover/manifest.js';
import { adapterFor, installSession, probeAgent, sessionAdapter, type AgentProbe } from '../../src/handover/sessions/registry.js';
import type { SessionFs } from '../../src/handover/sessions/types.js';

// Real agents on two machines, as a handover would move them: a session started on one resumes on the other
// under the same id and still remembers what it was told. Both machines must have Claude Code and Codex logged
// in; each run costs a few tiny turns and removes every folder and session file it made on both.
const REMOTE = process.env.SVALL_LIVE_REMOTE;
const AGENTS = (process.env.SVALL_LIVE_AGENTS ?? 'claude,codex').split(',') as AgentKind[];
const REASON = 'needs SVALL_LIVE_REMOTE: an ssh destination with this machine\'s home path and Claude Code and Codex logged in, as they are here';
// a remote CLI other than the one on its PATH, such as an older release still installed there
const REMOTE_BIN: Partial<Record<AgentKind, string>> = { claude: process.env.SVALL_LIVE_REMOTE_CLAUDE, codex: process.env.SVALL_LIVE_REMOTE_CODEX };

// the test process runs with a throwaway HOME; the agents need the real one, none of a live fleet's variables, and
// not the doubles of claude and codex isolate.ts puts first on PATH
const REAL_HOME = os.userInfo().homedir;
const ENV: NodeJS.ProcessEnv = {
  ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(SVALL_|CLAUDE_CODE_|CLAUDECODE$|CLAUDE_PID$|CLAUDE_EFFORT$|TMUX)/.test(k))),
  HOME: REAL_HOME,
  PATH: process.env.PATH?.split(':').filter((d) => d !== path.join(os.homedir(), 'bin')).join(':'),
};
const q = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`;

type Result = { code: number; stdout: string; stderr: string; bytes: Buffer };
type Side = { name: string; home: string; bin: Partial<Record<AgentKind, string>>; run(argv: string[], o?: { cwd?: string; input?: Buffer }): Promise<Result> };

function exec(cmd: string, args: string[], o: { cwd?: string; input?: Buffer } = {}): Promise<Result> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd: o.cwd, env: ENV, stdio: [o.input ? 'pipe' : 'ignore', 'pipe', 'pipe'] });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout!.on('data', (d: Buffer) => out.push(d));
    child.stderr!.on('data', (d: Buffer) => err.push(d));
    child.on('error', reject);
    child.on('close', (code) => { const bytes = Buffer.concat(out); resolve({ code: code ?? -1, stdout: bytes.toString(), stderr: Buffer.concat(err).toString(), bytes }); });
    if (o.input) child.stdin!.end(o.input);
  });
}

const here: Side = { name: 'this machine', home: REAL_HOME, bin: {}, run: (argv, o) => exec(argv[0], argv.slice(1), o) };

async function remote(destination: string): Promise<Side> {
  const run: Side['run'] = (argv, o = {}) =>
    exec('ssh', ['-o', 'BatchMode=yes', destination, `${o.cwd ? `cd ${q(o.cwd)} && ` : ''}${argv.map(q).join(' ')}${o.input ? '' : ' </dev/null'}`], { input: o.input });
  const home = (await run(['sh', '-c', 'printf %s "$HOME"'])).stdout;
  return { name: destination, home, bin: REMOTE_BIN, run };
}

const text = async (side: Side, argv: string[], cwd?: string): Promise<string> => {
  const r = await side.run(argv, { cwd });
  if (r.code !== 0) throw new Error(`${side.name}: ${argv.join(' ')} exited ${r.code}: ${r.stderr.slice(-2000)}`);
  return r.stdout;
};

const probe = (side: Side, kind: AgentKind): Promise<AgentProbe> => probeAgent(kind, {
  run: async (cmd, args) => { const r = await side.run([side.bin[cmd as AgentKind] ?? cmd, ...args]); if (r.code === 127) throw new Error(`${cmd} is not installed`); return r; },
  read: async (file) => { const r = await side.run(['cat', file]); return r.code === 0 ? r.stdout : undefined; },
  env: {}, homedir: side.home,
});

/** One turn of an agent in `cwd`: a new session, or a resumed one. Answers the session id it ran under and what it said. */
async function turn(side: Side, kind: AgentKind, cwd: string, prompt: string, session: { id?: string; resume?: boolean }): Promise<{ id: string; said: string }> {
  if (kind === 'claude') {
    const out = await text(side, [side.bin.claude ?? 'claude', '--safe-mode', '-p', session.resume ? '--resume' : '--session-id', session.id!, '--model', 'haiku',
      '--allowedTools', 'Bash(pwd)', '--output-format', 'json', prompt], cwd);
    const r = JSON.parse(out) as { session_id: string; result: string; is_error: boolean };
    if (r.is_error) throw new Error(`${side.name}: claude failed: ${r.result}`);
    return { id: r.session_id, said: r.result };
  }
  const out = await text(side, [side.bin.codex ?? 'codex', 'exec', '--json', '--skip-git-repo-check', '-s', 'danger-full-access', '-m', 'gpt-5.6-luna',
    '-c', 'model_reasoning_effort="low"', ...(session.resume ? ['resume', session.id!] : []), prompt], cwd);
  const events = out.split('\n').filter((l) => l.startsWith('{')).map((l) => JSON.parse(l));
  const id = events.find((e) => e.type === 'thread.started')?.thread_id;
  const said = events.filter((e) => e.type === 'item.completed' && e.item?.type === 'agent_message').map((e) => e.item.text).join('\n');
  return { id, said };
}

/** Where the agent's own lookup finds the session: the path its SessionStart hook reports as `transcript_path`. */
async function transcriptOf(side: Side, kind: AgentKind, home: string, id: string): Promise<string> {
  const found = await text(side, ['find', kind === 'claude' ? path.posix.join(home, 'projects') : path.posix.join(home, 'sessions'), '-name', kind === 'claude' ? `${id}.jsonl` : `rollout-*-${id}.jsonl`]);
  const hits = found.split('\n').filter(Boolean);
  if (hits.length !== 1) throw new Error(`${side.name}: expected one transcript for ${id}, found ${hits.length}`);
  return hits[0];
}

// what each run leaves behind, removed on both machines however the run ends
const cleanups: (() => Promise<unknown>)[] = [];
afterAll(async () => { for (const c of cleanups.reverse()) await c().catch(() => undefined); }, 120_000);

// a Claude session's project folder and per-session state, or a Codex rollout, its dated folders if it left them
// empty, and the rows Codex indexed it under
function forget(side: Side, kind: AgentKind, home: string, id: string, owned: string): void {
  if (kind === 'claude') {
    cleanups.push(() => side.run(['rm', '-rf', owned, ...['file-history', 'session-env', 'tasks'].map((d) => path.posix.join(home, d, id))]));
    return;
  }
  const day = path.posix.dirname(owned);
  const rows = (db: string, tables: string[]): string[] =>
    tables.map((t) => t.split(':')).map(([table, col]) => `sqlite3 ${q(path.posix.join(home, db))} ${q(`delete from ${table} where ${col}='${id}'`)}`);
  cleanups.push(() => side.run(['sh', '-c', [
    `rm -f ${q(owned)}`,
    `rmdir ${[day, path.posix.dirname(day), path.posix.dirname(path.posix.dirname(day))].map(q).join(' ')} 2>/dev/null`,
    ...rows('state_5.sqlite', ['threads:id', 'thread_dynamic_tools:thread_id', 'thread_attachments:thread_id', 'thread_spawn_edges:child_thread_id', 'thread_spawn_edges:parent_thread_id']),
    ...rows('thread_history_1.sqlite', ['thread_items:thread_id', 'thread_turns:thread_id', 'thread_history_projection_state:thread_id', 'thread_realtime_items:thread_id']),
    'true',
  ].join('; ')]));
}

const MAC = '9b4d0b1c-2d3e-4f50-8617-9a0b1c2d3e4f' as MachineId;
const TRIFT = '42aa0b1c-2d3e-4f50-8617-9a0b1c2d3e4f' as MachineId;

type Trip = { kind: AgentKind; tag: string; marker: string; id: string };

const workOf = (side: Side, trip: Trip): string => path.posix.join(side.home, `.svall-probe-${trip.tag}`, 'work');

/** A new session on `side`, told a code word to remember, in a throwaway folder that is removed with everything it made. */
async function start(kind: AgentKind, side: Side, sides: Side[]): Promise<Trip> {
  const tag = `${kind}-${crypto.randomBytes(3).toString('hex')}`;
  for (const s of sides) {
    const root = path.posix.join(s.home, `.svall-probe-${tag}`);
    // a Claude project folder is named for the cwd, so it carries the tag too, even if the run stops early
    cleanups.push(() => s.run(['sh', '-c', `rm -rf ${q(root)} ${q(path.posix.join(s.home, '.claude/projects'))}/*svall-probe-${tag}*`]));
  }
  const marker = `MARBLE-${tag}`;
  const work = path.posix.join(side.home, `.svall-probe-${tag}`, 'work');
  await text(side, ['mkdir', '-p', work]);
  const started = await turn(side, kind, work, `Remember the code word ${marker}. Run pwd with your shell tool, then answer in one short line.`,
    { id: kind === 'claude' ? crypto.randomUUID() : undefined });
  const home = (await probe(side, kind)).home;
  forget(side, kind, home, started.id, kind === 'claude' ? path.posix.dirname(await transcriptOf(side, kind, home, started.id)) : await transcriptOf(side, kind, home, started.id));
  return { kind, tag, marker, id: started.id };
}

/**
 * A session carried from `source` to `destination` as a handover carries it: found from its transcript by its
 * adapter, placed byte for byte at the same place under the destination's agent home, and resumed there under the
 * same id, remembering what it was told.
 */
async function carry(trip: Trip, source: Side, destination: Side): Promise<void> {
  const { kind, id, marker } = trip;
  const [work, placedWork] = [workOf(source, trip), workOf(destination, trip)];
  const [before, after] = await Promise.all([probe(source, kind), probe(destination, kind)]);
  for (const p of [before, after]) {
    expect(p.version && adapterFor(kind, p.version), `${kind} ${p.version}`).toBeTruthy();
    expect(p.loggedIn).toBe(true);
  }
  await text(destination, ['mkdir', '-p', placedWork]);
  const sourceTranscript = await transcriptOf(source, kind, before.home, id);

  let session: TransferSession;
  let staged: string;
  if (source === here) {
    // the whole manifest path, as the source daemon runs it
    const state = emptyState();
    state.characters.c1 = {
      id: 'c1', islandId: 'i1', cell: { x: 0, y: 0 }, name: 'c1', note: '', portrait: 'fox', instructions: '', cwd: work,
      context: [], shell: { lastOutputAt: 0 }, unread: false, agent: { kind, sessionId: id, transcriptPath: sourceTranscript, status: 'idle', lastActivityAt: 0 },
    };
    const fleet = FleetConfig.parse({ id: '5e1f0b1c-2d3e-4f50-8617-9a0b1c2d3e4f', home: { cwd: work } });
    const maps = {
      source: { machineId: MAC, home: source.home, fleetHome: path.posix.join(work, '../fleet') },
      destination: { machineId: TRIFT, home: destination.home, fleetHome: path.posix.join(placedWork, '../fleet'), agentHomes: { [kind]: after.home } },
    };
    const built = await buildManifest(buildInventory(state, { fleet }, maps), { generation: 1 });
    expect(built.blockers).toEqual([]);
    session = built.manifest.sessions[0];
    staged = session.sourceHome!;
  } else {
    // the source's bytes fetched as rsync would stage them, then found by the adapter where they landed
    staged = fs.mkdtempSync(path.join(os.tmpdir(), 'svall-live-'));
    cleanups.push(async () => fs.rmSync(staged, { recursive: true, force: true }));
    const adapter = sessionAdapter(kind);
    const rel = path.posix.relative(before.home, sourceTranscript);
    const carried = kind === 'claude' ? [path.posix.dirname(rel)] : [rel];
    const tar = await source.run(['sh', '-c', `cd ${q(before.home)} && tar -cf - ${carried.map(q).join(' ')} 2>/dev/null; true`]);
    await exec('tar', ['-C', staged, '-xf', '-'], { input: tar.bytes });
    const found = await adapter.discover(path.join(staged, rel), id, localFs);
    session = {
      characterId: 'c1', agent: kind, sessionId: id, sourcePath: sourceTranscript, sourceHome: before.home, destinationHome: after.home, adapter: adapter.adapter,
      destinationPath: path.posix.join(after.home, found.transcript),
      files: found.files.map((f) => {
        const data = fs.readFileSync(path.join(staged, f));
        return { type: 'file' as const, path: f, mode: 0o600, size: data.length, mtimeMs: 0, sha256: sha256Hex(data) };
      }),
    };
  }
  forget(destination, kind, after.home, id, kind === 'claude' ? path.posix.dirname(session.destinationPath!) : session.destinationPath!);

  if (destination === here) {
    expect(installSession(session, staged)).toEqual({ transcriptPath: session.destinationPath });
  } else {
    // one file at a time, private and never over one already there
    for (const f of session.files) {
      const file = path.posix.join(after.home, f.path);
      const data = fs.readFileSync(path.join(staged, f.path));
      const r = await destination.run(['sh', '-c', 'umask 077; mkdir -p "$(dirname "$1")" && set -C && cat > "$1"', 'sh', file], { input: data });
      if (r.code !== 0) throw new Error(`${destination.name}: could not place ${file}: ${r.stderr}`);
    }
  }
  const placed = (await text(destination, ['cat', session.destinationPath!])).split('\n').filter(Boolean).length;

  const resumed = await turn(destination, kind, placedWork, 'What was the code word I asked you to remember? Run pwd with your shell tool, then answer with the code word and the directory.', { id, resume: true });
  console.info(`${kind} ${id}: ${before.version} on ${source.name} -> ${after.version} on ${destination.name}: ${JSON.stringify(resumed.said)}`);
  expect(resumed.id).toBe(id);
  expect(resumed.said).toContain(marker);
  expect(resumed.said).toContain(placedWork);
  // the same file grew, and no other session file was made for it
  expect(await transcriptOf(destination, kind, after.home, id)).toBe(session.destinationPath);
  expect((await text(destination, ['cat', session.destinationPath!])).split('\n').filter(Boolean).length).toBeGreaterThan(placed);
}

const localFs: SessionFs = {
  lstat: (p) => fs.promises.lstat(p),
  readdir: (p) => fs.promises.readdir(p, { encoding: 'buffer' }),
};

describe.skipIf(!REMOTE)(`agent sessions carried between two real machines (${REASON})`, () => {
  for (const kind of AGENTS) {
    it(`carries a ${kind} session to ${REMOTE} and home again, and one started there`, async () => {
      const there = await remote(REMOTE!);
      const trip = await start(kind, here, [here, there]);
      await carry(trip, here, there);
      // the morning pull-back: this machine still holds the copy it handed away, which the session has grown past
      await carry(trip, there, here);
      await carry(await start(kind, there, [here, there]), there, here);
    }, 900_000);
  }
});
