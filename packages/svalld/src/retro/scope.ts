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

/** A session written to in the span; a Claude session's subagents keep files of their own, and a Codex sub-agent's rollout
 *  names the session that started it as `parent`. */
export type Candidate = { agent: AgentKind; session: string; file: string; cwd?: string; mtime: number; subagents?: string[]; parent?: string };
export type InScope = Candidate & { record?: SessionRecord; repo?: string };

const HEAD = 64 * 1024;
const ROLLOUT = /^rollout-.+-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/;
// the fields an agent's sessions never record, which the plan counts against the sessions in scope
const LACKS: Record<AgentKind, string[]> = { claude: [], codex: ['cost'], opencode: [] };

// discovery stats and reads the heads of every transcript on disk, so it waits on each rather than hold svalld up
const names = (dir: string, recursive = false): Promise<string[]> => fs.promises.readdir(dir, { encoding: 'utf8', recursive }).catch(() => []);

const mtimeOf = (file: string): Promise<number | undefined> => fs.promises.stat(file).then((s) => s.mtimeMs, () => undefined);

// the folder a session started in: Claude's lines carry it, and a Codex rollout's first session_meta holds it with the
// parent a sub-agent's rollout names, as a later one is its parent's
async function head(agent: 'claude' | 'codex', file: string): Promise<{ cwd?: string; parent?: string }> {
  let text = '';
  try {
    const fh = await fs.promises.open(file, 'r');
    try {
      const buf = Buffer.alloc(HEAD);
      text = buf.toString('utf8', 0, (await fh.read(buf, 0, HEAD, 0)).bytesRead);
    } finally { await fh.close(); }
  } catch { return {}; }
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
  const touched = async (file: string): Promise<number | undefined> => {
    const t = await mtimeOf(file);
    return t !== undefined && t >= o.span.from ? t : undefined;
  };
  const out: Candidate[] = [];
  const projects = path.join(o.claudeDir, 'projects');
  for (const project of await names(projects)) {
    for (const f of (await names(path.join(projects, project))).filter((f) => f.endsWith('.jsonl'))) {
      const file = path.join(projects, project, f);
      const mtime = await touched(file);
      if (mtime === undefined) continue;
      const session = f.slice(0, -'.jsonl'.length);
      const dir = path.join(projects, project, session, 'subagents');
      const subagents: string[] = [];
      for (const s of (await names(dir)).filter((s) => s.endsWith('.jsonl'))) if (await touched(path.join(dir, s)) !== undefined) subagents.push(path.join(dir, s));
      out.push({ agent: 'claude', session, file, cwd: (await head('claude', file)).cwd, mtime, ...(subagents.length > 0 && { subagents }) });
    }
  }
  const rollouts = path.join(o.codexDir, 'sessions');
  for (const rel of await names(rollouts, true)) {
    const session = ROLLOUT.exec(path.basename(rel))?.[1];
    const file = path.join(rollouts, rel);
    const mtime = session ? await touched(file) : undefined;
    if (session && mtime !== undefined) out.push({ agent: 'codex', session, file, mtime, ...(await head('codex', file)) });
  }
  const opencode = (await o.opencode?.()) ?? [];
  return [...out, ...opencode.filter((c) => c.mtime >= o.span.from)];
}

const Listed = z.array(z.object({ id: z.string(), updated: z.number(), directory: z.string() }));

/** It lists by project, so a session in a project none of `dirs` is in is missed; OpenCode keeps no file per session, so
 *  its candidates name none. */
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

/** The main checkout of a folder's repo, asked of git once per folder; a folder gone is asked by its nearest existing
 *  ancestor, as a worktree removed since lies in its repo. */
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

/** This fleet's sessions less excluded islands (id or name) and repos, plus unrecorded ones in the repos the user picked; the
 *  rest are counted, the unrecorded by repo, else cwd. Repos compare by real path; a Codex sub-agent goes with its parent. */
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
  // an excluded folder leaves out its repo's sessions and any that ran inside it, in git or not
  const out = (repo?: string, cwd?: string): boolean =>
    (!!repo && excludedRepos.has(real(repo))) || (!!cwd && [...excludedRepos].some((x) => real(cwd) === x || real(cwd).startsWith(x + path.sep)));
  for (const c of o.candidates) {
    const ids = [c.session, ...(c.parent ? [c.parent] : [])];
    if (ids.some((id) => o.others.has(id))) { otherFleets++; continue; }
    const record = ids.map((id) => o.own.get(id)).find((r) => r);
    const cwd = c.cwd ?? record?.cwd;
    if (record) {
      if (islandOut(record.island)) { excluded++; continue; }
      const repo = record.repo ?? (cwd ? await o.repoOf(cwd) : undefined);
      if (out(repo, cwd)) { excluded++; continue; }
      inScope.push({ ...c, record, repo });
      continue;
    }
    const repo = cwd ? await o.repoOf(cwd) : undefined;
    if (out(repo, cwd)) { excluded++; continue; }
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
