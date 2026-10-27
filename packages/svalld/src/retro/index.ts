import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { Worker } from 'node:worker_threads';
import type { AgentKind } from '@svall/protocol';
import { outlineClaude } from '../agent/claude-outline.js';
import { outlineCodex } from '../agent/codex-outline.js';
import { orSkip } from '../agent/jsonl.js';
import { outlineOpencode } from '../agent/opencode-outline.js';
import { workerFile } from '../runtime.js';
import { cliRunner } from '../sessions/registry.js';
import type { Outline, Span } from './outline.js';

/** The sessions to outline, OpenCode's by id, and the transcripts on disk whose runs of `skills` count, in the span or not. */
export type IndexJob = {
  files: { agent: AgentKind; session: string; file: string; cwd?: string; subagents?: string[] }[];
  span: Span; skills: string[]; onDisk: string[]; opencodeBin?: string;
};
// a share's outlines in the order it was given its files, one it could not read left null
type Share = { outlines: (Outline | null)[]; skillsSeen: string[] };

/** The scan reads a transcript this much at a time. */
export const SCAN_CHUNK = 4 << 20;
const EXPORT_MS = 20_000;
// a piece's cost in bytes outlined: a scan reads about twice as fast, and an OpenCode export takes as long as 400 MB
const SCAN_COST = 0.5;
const EXPORT_COST = 400e6;

// what marks a run in a transcript's raw text: Claude's Skill input, a typed slash command, and in a Codex rollout, which
// runs a skill by reading it, skills/<name>/SKILL.md on a tool call's line, as its instructions list every skill's path
const INPUT = Buffer.from('"skill":"');
const TYPED = Buffer.from('<command-name>/');
const SKILL_MD = Buffer.from('/SKILL.md');
const SKILLS = Buffer.from('skills/');
const CALLS = ['custom_tool_call', 'function_call', 'local_shell_call', 'exec_command_begin', 'CommandExecution'].map((t) => Buffer.from(`"type":"${t}"`));
// a rollout line names its type within this many bytes of its start
const HEAD = 400;

// whether the line `i` is in is a Codex tool call; one that started before the chunk is `carried`
function callAt(buf: Buffer, i: number, carried: boolean): boolean {
  const start = i > 0 ? buf.lastIndexOf(0x0a, i - 1) + 1 : 0;
  if (start === 0) return carried;
  const head = buf.subarray(start, start + HEAD);
  return CALLS.some((c) => head.includes(c));
}

// each name a chunk marks as a run, `max` bytes long at most
function named(buf: Buffer, max: number, codex: boolean, found: (name: string) => void, carried = false): void {
  const after = (mark: Buffer, end: string) => {
    for (let i = buf.indexOf(mark); i >= 0; i = buf.indexOf(mark, i + mark.length)) {
      const from = i + mark.length;
      const len = buf.subarray(from, from + max + 1).indexOf(end);
      if (len > 0) found(buf.toString('utf8', from, from + len));
    }
  };
  after(INPUT, '"');
  after(TYPED, '<');
  if (!codex) return;
  for (let i = buf.indexOf(SKILL_MD); i >= 0; i = buf.indexOf(SKILL_MD, i + SKILL_MD.length)) {
    const head = buf.subarray(Math.max(0, i - max - SKILLS.length), i);
    const slash = head.lastIndexOf('/');
    if (slash >= SKILLS.length - 1 && head.subarray(slash + 1 - SKILLS.length, slash + 1).equals(SKILLS) && callAt(buf, i, carried)) found(head.toString('utf8', slash + 1));
  }
}

// each chunk starts a little before the last one ended, so a run named across the cut is whole in the next
function scan(files: string[], wanted: Set<string>, seen: Set<string>): void {
  const max = Math.max(0, ...[...wanted].map((s) => Buffer.byteLength(s)));
  const overlap = max + 32;
  const buf = Buffer.alloc(SCAN_CHUNK);
  const found = (name: string) => { if (wanted.has(name)) seen.add(name); };
  for (const file of files) {
    if (seen.size === wanted.size) return;
    const codex = path.basename(file).startsWith('rollout-');
    let fd: number | undefined;
    try {
      fd = fs.openSync(file, 'r');
      for (let kept = 0, got, carried = false; (got = fs.readSync(fd, buf, kept, buf.length - kept, null)) > 0;) {
        const end = kept + got;
        named(buf.subarray(0, end), max, codex, found, carried);
        kept = Math.min(overlap, end);
        carried = codex && callAt(buf, end - kept, carried);
        buf.copy(buf, 0, end - kept, end);
      }
    } catch { /* a file gone or unreadable names none */ } finally {
      if (fd !== undefined) fs.closeSync(fd);
    }
  }
}

/** Outlines a share of a job's sessions and scans its share of `onDisk`; the worker runs it, and `inline` runs it here. */
export async function indexShare(job: IndexJob): Promise<Share> {
  const run = cliRunner(process.env, EXPORT_MS);
  let tmp: string | undefined;
  const exported = async (session: string, cwd?: string): Promise<unknown> => {
    tmp ??= fs.mkdtempSync(path.join(os.tmpdir(), 'svall-retro-'));
    const out = path.join(tmp, 'export.json');
    const r = await run(job.opencodeBin ?? 'opencode', ['session', 'export', '--standalone', session], { stdout: out, cwd: cwd && fs.existsSync(cwd) ? cwd : os.homedir() });
    if (r.code !== 0) throw new Error(`opencode could not export ${session}`);
    return JSON.parse(fs.readFileSync(out, 'utf8'));
  };
  const outline = async (f: IndexJob['files'][number]): Promise<Outline> => {
    if (f.agent === 'opencode') return outlineOpencode(await exported(f.session, f.cwd), job.span);
    const text = fs.readFileSync(f.file, 'utf8');
    if (f.agent === 'codex') return outlineCodex(text, f.file, job.span);
    const subagents = (f.subagents ?? []).flatMap((s) => orSkip(() => fs.readFileSync(s, 'utf8')) ?? []);
    return outlineClaude(text, f.file, job.span, subagents);
  };
  const outlines: Share['outlines'] = [];
  try {
    // a session that cannot be read or exported is skipped
    for (const f of job.files) outlines.push(await outline(f).catch(() => null));
  } finally {
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
  }
  const wanted = new Set(job.skills);
  // a run an outline holds counts too, an OpenCode session's among them
  const seen = new Set(outlines.flatMap((o) => o?.skills.map((r) => r.name) ?? []).filter((n) => wanted.has(n)));
  scan(job.onDisk, wanted, seen);
  return { outlines, skillsSeen: job.skills.filter((s) => seen.has(s)) };
}

// the job dealt out by cost, largest first, each piece to the share with the least so far; `order` maps a share's files back
async function deal(job: IndexJob, n: number): Promise<{ job: IndexJob; order: number[] }[]> {
  const size = (file: string): Promise<number> => fs.promises.stat(file).then((s) => s.size, () => 0);
  const shares = Array.from({ length: n }, () => ({ job: { ...job, files: [] as IndexJob['files'], onDisk: [] as string[] }, order: [] as number[], cost: 0 }));
  const pieces = [
    ...await Promise.all(job.files.map(async (f, i) => ({
      cost: f.agent === 'opencode' ? EXPORT_COST : (await Promise.all([f.file, ...f.subagents ?? []].map(size))).reduce((a, b) => a + b, 0),
      put: (s: (typeof shares)[number]) => { s.job.files.push(f); s.order.push(i); },
    }))),
    ...await Promise.all((job.skills.length > 0 ? job.onDisk : []).map(async (file) => ({
      cost: (await size(file)) * SCAN_COST,
      put: (s: (typeof shares)[number]) => { s.job.onDisk.push(file); },
    }))),
  ].sort((a, b) => b.cost - a.cost);
  for (const p of pieces) {
    const least = shares.reduce((a, b) => (b.cost < a.cost ? b : a));
    least.cost += p.cost;
    p.put(least);
  }
  return shares.filter((s) => s.job.files.length > 0 || s.job.onDisk.length > 0);
}

// a checkout's worker is TypeScript, which tsx loads as it does the daemon's own sources
const tsx = (): string => pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href;

function inWorker(job: IndexJob): Promise<Share> {
  const file = workerFile('retro-index');
  return new Promise((resolve, reject) => {
    const w = new Worker(file, { workerData: job, ...(file.endsWith('.ts') && { execArgv: [...process.execArgv, '--import', tsx()] }) });
    w.once('message', resolve);
    w.once('error', reject);
    w.once('exit', (code) => reject(new Error(`the retro index worker exited with code ${code} before it answered`)));
  });
}

/**
 * Each session's outline, in the job's order less those that could not be read, and which of `skills` ran in any transcript
 * on disk. The work is shared among worker threads, so svalld keeps serving; `inline` does it all on this thread.
 */
export async function indexSessions(job: IndexJob, o: { inline?: true; workers?: number } = {}): Promise<{ outlines: Outline[]; skillsSeen: string[] }> {
  const shares = o.inline
    ? [{ job, order: job.files.map((_, i) => i) }]
    : await deal(job, Math.max(1, o.workers ?? Math.min(4, os.availableParallelism() - 1)));
  const done = await Promise.all(shares.map((s) => (o.inline ? indexShare(s.job) : inWorker(s.job))));
  const outlines: (Outline | null)[] = job.files.map(() => null);
  shares.forEach((s, k) => s.order.forEach((i, j) => { outlines[i] = done[k].outlines[j]; }));
  const seen = new Set(done.flatMap((d) => d.skillsSeen));
  return { outlines: outlines.filter((x) => x !== null), skillsSeen: job.skills.filter((s) => seen.has(s)) };
}
