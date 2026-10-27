import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import type { AgentKind, RetroPlan } from '@svall/protocol';
import { orSkip } from '../agent/jsonl.js';
import { resolveRepo, type GitRunner } from '../links/git.js';
import { realPath, resolvePaths } from '../paths.js';
import { cliRunner } from '../sessions/registry.js';
import type { CliRun } from '../sessions/types.js';
import { fleetHomes } from '../uninstall.js';
import { readSessions, type SessionRecord } from './sessions.js';

/**
 * A session an agent wrote to in the span, with the folder it started in; a Claude session's subagents keep files of their
 * own, and a Codex sub-agent's rollout names the session that started it as `parent`.
 */
export type Candidate = { agent: AgentKind; session: string; file: string; cwd?: string; mtime: number; subagents?: string[]; parent?: string };
export type InScope = Candidate & { record?: SessionRecord; repo?: string };

const HEAD = 64 * 1024;
const ROLLOUT = /^rollout-.+-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/;
// the fields an agent's sessions never record, which the plan counts against the sessions in scope
const LACKS: Record<AgentKind, string[]> = { claude: [], codex: ['cost'], opencode: [] };

const names = (dir: string, recursive = false): string[] => {
  try { return fs.readdirSync(dir, { encoding: 'utf8', recursive }); } catch { return []; }
};

const mtimeOf = (file: string): number | undefined => orSkip(() => fs.statSync(file).mtimeMs);

// the folder a session started in: Claude's lines carry it, and a Codex rollout's first session_meta holds it with the
// parent a sub-agent's rollout names, as a later one is its parent's
function head(agent: 'claude' | 'codex', file: string): { cwd?: string; parent?: string } {
  let fd: number | undefined;
  let text = '';
  try {
    fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(HEAD);
    text = buf.toString('utf8', 0, fs.readSync(fd, buf, 0, HEAD, 0));
  } catch { return {}; } finally { if (fd !== undefined) fs.closeSync(fd); }
  for (const line of text.split('\n')) {
    if (agent === 'claude') {
      const cwd = line.includes('"cwd"') ? orSkip(() => (JSON.parse(line) as { cwd?: unknown }).cwd) : undefined;
      if (typeof cwd === 'string') return { cwd };
      continue;
    }
    if (!line.includes('"session_meta"')) continue;
    const meta = orSkip(() => JSON.parse(line) as { type?: unknown; payload?: { cwd?: unknown; parent_thread_id?: unknown } });
    if (meta?.type !== 'session_meta') continue;
    const { cwd, parent_thread_id: parent } = meta.payload ?? {};
    return { ...(typeof cwd === 'string' && { cwd }), ...(typeof parent === 'string' && { parent }) };
  }
  return {};
}

/** Every Claude and Codex session file on this machine touched since the span began, and the OpenCode sessions `opencode` lists. */
export async function discover(o: { span: { from: number; to: number }; claudeDir: string; codexDir: string; opencode?: () => Promise<Candidate[]> }): Promise<Candidate[]> {
  const touched = (file: string): number | undefined => {
    const t = mtimeOf(file);
    return t !== undefined && t >= o.span.from ? t : undefined;
  };
  const out: Candidate[] = [];
  const projects = path.join(o.claudeDir, 'projects');
  for (const project of names(projects)) {
    for (const f of names(path.join(projects, project)).filter((f) => f.endsWith('.jsonl'))) {
      const file = path.join(projects, project, f);
      const mtime = touched(file);
      if (mtime === undefined) continue;
      const session = f.slice(0, -'.jsonl'.length);
      const dir = path.join(projects, project, session, 'subagents');
      const subagents = names(dir).filter((s) => s.endsWith('.jsonl')).map((s) => path.join(dir, s)).filter((s) => touched(s) !== undefined);
      out.push({ agent: 'claude', session, file, cwd: head('claude', file).cwd, mtime, ...(subagents.length > 0 && { subagents }) });
    }
  }
  const rollouts = path.join(o.codexDir, 'sessions');
  for (const rel of names(rollouts, true)) {
    const session = ROLLOUT.exec(path.basename(rel))?.[1];
    const file = path.join(rollouts, rel);
    const mtime = session ? touched(file) : undefined;
    if (session && mtime !== undefined) out.push({ agent: 'codex', session, file, mtime, ...head('codex', file) });
  }
  const opencode = (await o.opencode?.()) ?? [];
  return [...out, ...opencode.filter((c) => c.mtime >= o.span.from)];
}

const Listed = z.array(z.object({ id: z.string(), updated: z.number(), directory: z.string() }));

/**
 * The sessions `opencode session list` gives in each of `dirs`. It lists the project a folder is in, so a session in a
 * project none of `dirs` is in is not found; OpenCode keeps no file per session, and its candidates name none.
 */
export async function opencodeSessions(dirs: string[], run: CliRun = cliRunner()): Promise<Candidate[]> {
  const out = new Map<string, Candidate>();
  for (const cwd of new Set(dirs)) {
    // newest first, and only 100 unless asked for more; an OpenCode not installed, or a folder gone, lists none
    const r = await run('opencode', ['session', 'list', '--format', 'json', '--standalone', '--max-count', '1000'], { cwd }).catch(() => undefined);
    const listed = r?.code === 0 ? Listed.safeParse(orSkip(() => JSON.parse(r.stdout))).data : undefined;
    for (const s of listed ?? []) out.set(s.id, { agent: 'opencode', session: s.id, file: '', cwd: s.directory, mtime: s.updated });
  }
  return [...out.values()];
}

/**
 * The main checkout of the repo a folder is in, asked of git once per folder; a folder gone is asked by the nearest one
 * above it still there, as a worktree removed since lies in its repo. None outside any repo.
 */
export function repoFinder(git?: GitRunner): (cwd: string) => Promise<string | undefined> {
  const seen = new Map<string, Promise<string | undefined>>();
  return (cwd) => {
    let repo = seen.get(cwd);
    if (!repo) {
      let dir = cwd;
      while (!fs.existsSync(dir) && path.dirname(dir) !== dir) dir = path.dirname(dir);
      repo = resolveRepo(dir, git).then((r) => r?.mainRoot);
      seen.set(cwd, repo);
    }
    return repo;
  };
}

/** The sessions the other fleets on this machine recorded, which a retro of this one never reads. */
export function otherFleetSessions(home: string, homedir: string = os.homedir()): Set<string> {
  const self = realPath(home);
  return new Set(fleetHomes(homedir).filter((h) => realPath(h) !== self).flatMap((h) => [...readSessions(resolvePaths(h).retroSessions).keys()]));
}

/**
 * This fleet's sessions less those on an excluded island (by id or name) or in an excluded repo, plus the sessions no
 * fleet recorded in the repos the user picked and did not exclude; those it leaves are counted, the unrecorded by repo,
 * else by cwd. Repos compare by real path, and a Codex sub-agent's rollout goes with the session that started it.
 */
export async function scope(o: {
  candidates: Candidate[]; own: Map<string, SessionRecord>; others: Set<string>;
  exclude: { repos: string[]; islands: string[] }; unrecorded: string[];
  islandName: (id: string) => string | undefined; repoOf: (cwd: string) => Promise<string | undefined>; remote: number;
}): Promise<{ inScope: InScope[]; counts: RetroPlan['counts'] }> {
  const inScope: InScope[] = [];
  const groups = new Map<string, number>();
  let [excluded, otherFleets] = [0, 0];
  const islandOut = (id?: string): boolean => !!id && o.exclude.islands.some((n) => n === id || n === o.islandName(id));
  const reals = new Map<string, string>();
  const real = (p: string): string => {
    let r = reals.get(p);
    if (r === undefined) reals.set(p, (r = realPath(path.resolve(p))));
    return r;
  };
  const [excludedRepos, picks] = [new Set(o.exclude.repos.map(real)), new Set(o.unrecorded.map(real))];
  for (const c of o.candidates) {
    const ids = [c.session, ...(c.parent ? [c.parent] : [])];
    if (ids.some((id) => o.others.has(id))) { otherFleets++; continue; }
    const record = ids.map((id) => o.own.get(id)).find((r) => r);
    const cwd = c.cwd ?? record?.cwd;
    if (record) {
      if (islandOut(record.island)) { excluded++; continue; }
      const repo = record.repo ?? (cwd ? await o.repoOf(cwd) : undefined);
      if (repo && excludedRepos.has(real(repo))) { excluded++; continue; }
      inScope.push({ ...c, record, repo });
      continue;
    }
    const repo = cwd ? await o.repoOf(cwd) : undefined;
    if (repo && excludedRepos.has(real(repo))) { excluded++; continue; }
    const group = repo ?? cwd ?? 'unknown';
    groups.set(group, (groups.get(group) ?? 0) + 1);
    if (picks.has(real(group))) inScope.push({ ...c, repo });
  }
  const missing: Record<string, number> = {};
  for (const field of inScope.flatMap((c) => LACKS[c.agent])) missing[field] = (missing[field] ?? 0) + 1;
  const unrecorded = [...groups].map(([repo, count]) => ({ repo, count, picked: picks.has(real(repo)) }))
    .sort((a, b) => b.count - a.count || a.repo.localeCompare(b.repo));
  return { inScope, counts: { inScope: inScope.length, excluded, otherFleets, remote: o.remote, unrecorded, missing } };
}
