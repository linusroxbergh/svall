import os from 'node:os';
import path from 'node:path';
import { ellipsis, type AgentKind } from '@svall/protocol';
import { orSkip } from '../agent/jsonl.js';
import { redact } from './redact.js';

export type Span = { from: number; to: number };
/** One turn of a session; `id` is `L<line>.<block>`, as several blocks can share a transcript line. A tool call keeps its
 *  name and the file it names, and a shell call its command, with how it ended once its result came. */
export type Turn = {
  id: string; line: number; at: number; role: 'user' | 'agent' | 'tool' | 'error' | 'subagent'; text: string; clipped?: true;
  name?: string; file?: string; cmd?: { text: string; failed?: boolean; exit?: number; out?: string };
};
/** A skill's run, from its call to the next prompt; `next` is what followed it first, a prompt only when it came within two
 *  minutes. `id` is the turn that started it, and an `inferred` run is one a read of its SKILL.md started. */
export type SkillRun = { name: string; id: string; line: number; at: number; end: number; next?: 'interrupt' | 'rejected' | 'reply'; replyMs?: number; inferred?: true };
/** A shell command that ran: `id` is its call's turn. */
export type Command = { id: string; at: number; text: string; failed: boolean; exit?: number; out?: string };
/** Where a session worked: the folders of the files it wrote and those its commands ran in, each with how often. */
export type Work = { wrote: Record<string, number>; ran: Record<string, number> };
/** One session as the index reads it: only what its lines say inside the span, text clipped and redacted, tool output left
 *  out but a failed command's. */
export type Outline = {
  agent: AgentKind; session: string; file: string; model?: string; cwd?: string; branch?: string;
  start: number; end: number; turns: Turn[]; prompts: Turn[]; skills: SkillRun[];
  tools: number; errors: number; interrupts: number; rejected: number; prs: { url: string; at: number }[]; costUsd?: number;
  commands: Command[]; hookErrors: number; clipped: number; work: Work;
};

export const CLIP = { user: 4_000, agent: 1_500, input: 300, error: 300, failed: 1_000, body: 8_000, subagent: 4_000 } as const;
const REPLY_MS = 2 * 60_000;
// a PR's link; the user:password@ a remote's URL can carry falls outside its groups
const PR = /(https?:\/\/)(?:[^\s/@"'<>`\\]*@)?([^\s/@"'<>()[\]{}`\\]+\/[^\s/"'<>()[\]{}`\\]+\/[^\s/"'<>()[\]{}`\\]+\/pull\/\d+)/g;

// a call that writes a PR's body or a comment on one, the output most rules govern, whose input is kept as agent text is
export const GH_BODY = /\bgh\s+(?:pr\s+(?:create|edit|comment)\b|api\b.*\bbody=)/;

const turnId = (line: number, block: number): string => `L${line}.${block}`;

// a command works where a leading `cd` takes it or a `git -C` points, else where its shell stands
const CD = /^\s*(?:cd|pushd)\s+("[^"]+"|'[^']+'|[^\s;&|]+)\s*(?:&&|;|\n)/;
const GIT_C = /\bgit\s+-C\s+("[^"]+"|'[^']+'|[^\s;&|]+)/;

// a path as a shell or tool names it, from the folder it was named in
const pathAt = (p: string, cwd?: string): string | undefined => {
  const q = p.replace(/^(["'])(.*)\1$/, '$2');
  if (q === '~' || q.startsWith('~/')) return path.join(os.homedir(), q.slice(1));
  return path.isAbsolute(q) ? path.normalize(q) : cwd && path.resolve(cwd, q);
};

export const inSpan = (at: number, span: Span): boolean => at >= span.from && at <= span.to;
// a tool input with each string in it redacted, so a .env line it writes is masked before JSON escapes its newlines
const leaves = (v: unknown): unknown =>
  typeof v === 'string' ? redact(v)
  : Array.isArray(v) ? v.map(leaves)
  : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, leaves(x)]))
  : v;
const FILE_KEYS = ['file_path', 'path', 'filePath', 'notebook_path'];

/** Folds what a reader finds in a session, in order and inside the span, into its outline. */
export function outliner() {
  const o = { start: 0, end: 0, turns: [] as Turn[], prompts: [] as Turn[], skills: [] as SkillRun[], tools: 0, errors: 0, interrupts: 0, rejected: 0, hookErrors: 0, clipped: 0 };
  const prs: Outline['prs'] = [];
  const work: Work = { wrote: {}, ran: {} };
  const count = (m: Record<string, number>, dir?: string) => { if (dir) m[dir] = (m[dir] ?? 0) + 1; };
  // the runs no prompt has ended yet
  let open: SkillRun[] = [];
  const links = (text: string, at: number) => { for (const [, scheme, rest] of text.matchAll(PR)) prs.push({ url: scheme + rest, at }); };
  // redacted whole before it is clipped, so a secret the clip cuts is still masked; a clip of prose is counted, a tool's input or error by design
  const turn = (role: Turn['role'], line: number, at: number, block: number, text: string, max: number, more: Partial<Turn> = {}, prose = role !== 'tool' && role !== 'error'): Turn => {
    if (!o.start || at < o.start) o.start = at;
    o.end = Math.max(o.end, at);
    const whole = redact(text);
    const t: Turn = { id: turnId(line, block), line, at, role, text: ellipsis(whole, max), ...more };
    if (prose && whole.length > max) { t.clipped = true; o.clipped++; }
    o.turns.push(t);
    return t;
  };
  const tool = (line: number, at: number, name: string, input: unknown, block = 0): Turn => {
    // JSON text, as a Codex call's arguments are, is read as the input it holds
    const v = typeof input === 'string' ? orSkip(() => JSON.parse(input) as unknown) ?? input : input;
    const given = typeof v === 'string' ? v : JSON.stringify(leaves(v)) ?? '';
    links(given, at);
    o.tools++;
    const body = GH_BODY.test(given);
    const t = turn('tool', line, at, block, `${name} ${given}`, name.length + 1 + (body ? CLIP.body : CLIP.input), { name }, body);
    const file = v && typeof v === 'object' ? FILE_KEYS.map((k) => (v as Record<string, unknown>)[k]).find((f) => typeof f === 'string') : undefined;
    if (typeof file === 'string') t.file = redact(file);
    return t;
  };
  const follow = (next: 'interrupt' | 'rejected') => { for (const r of open) r.next ??= next; };
  return {
    prompt(line: number, at: number, text: string, block = 0) {
      links(text, at);
      const last = o.turns.at(-1)?.at;
      for (const r of open) {
        r.end = at;
        if (last === undefined) continue;
        r.replyMs = at - last;
        if (!r.next && r.replyMs <= REPLY_MS) r.next = 'reply';
      }
      open = [];
      const t = turn('user', line, at, block, text, CLIP.user);
      o.prompts.push(t);
      return t;
    },
    said(line: number, at: number, text: string, block = 0) {
      links(text, at);
      turn('agent', line, at, block, text, CLIP.agent);
    },
    tool,
    // a shell command's end, on its call's turn; one whose call is not in the outline gets a turn of its own
    ran(call: Turn | undefined, line: number, at: number, command: string, r: { failed: boolean; exit?: number; out?: string }, block = 0) {
      const t = call ?? tool(line, at, 'shell', command, block);
      t.cmd = {
        text: ellipsis(redact(command), CLIP.input), failed: r.failed,
        ...(r.exit !== undefined && { exit: r.exit }), ...(r.failed && r.out?.trim() && { out: ellipsis(redact(r.out.trim()), CLIP.failed) }),
      };
      if (r.failed) o.errors++;
    },
    error(line: number, at: number, text: string, block = 0) {
      o.errors++;
      turn('error', line, at, block, text, CLIP.error);
    },
    rejected(line: number, at: number, name: string, block = 0) {
      o.rejected++;
      follow('rejected');
      turn('error', line, at, block, `[rejected] ${name}`, CLIP.error);
    },
    interrupt(line: number, at: number, block = 0) {
      o.interrupts++;
      follow('interrupt');
      turn('user', line, at, block, '[interrupted]', CLIP.user);
    },
    // a subagent's final message, read into its parent as what the parent was told
    subagent(line: number, at: number, type: string, text: string, block = 0) {
      links(text, at);
      turn('subagent', line, at, block, `SUBAGENT ${type}: ${text}`, CLIP.subagent);
    },
    // a skill already running since the last prompt is the same run, read again or named twice
    skill(name: string, line: number, at: number, more: { id?: string; inferred?: true } = {}) {
      if (open.some((r) => r.name === name)) return;
      const r: SkillRun = { name, id: more.id ?? turnId(line, 0), line, at, end: at, ...(more.inferred && { inferred: true }) };
      open.push(r);
      o.skills.push(r);
    },
    pr(url: string, at: number) {
      prs.push({ url, at });
    },
    wrote(file: string, cwd?: string) {
      const f = pathAt(file, cwd);
      count(work.wrote, f && path.dirname(f));
    },
    ranIn(command: string, cwd?: string) {
      const to = (CD.exec(command) ?? GIT_C.exec(command))?.[1];
      count(work.ran, to ? pathAt(to, cwd) : cwd);
    },
    hookError() {
      o.hookErrors++;
    },
    // a run no prompt ended lasts to the session's last turn
    outline(head: Pick<Outline, 'agent' | 'session' | 'file' | 'model' | 'cwd' | 'branch' | 'costUsd'>): Outline {
      for (const r of open) r.end = Math.max(r.at, o.end);
      const commands = o.turns.flatMap((t): Command[] => (t.cmd?.failed === undefined ? [] : [{
        id: t.id, at: t.at, text: t.cmd.text, failed: t.cmd.failed, ...(t.cmd.exit !== undefined && { exit: t.cmd.exit }), ...(t.cmd.out && { out: t.cmd.out }),
      }]));
      return { ...head, ...o, prs, commands, work };
    },
  };
}
