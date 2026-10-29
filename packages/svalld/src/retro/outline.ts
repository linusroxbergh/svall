import os from 'node:os';
import path from 'node:path';
import { ellipsis, type AgentKind } from '@svall/protocol';
import { orSkip } from '../agent/jsonl.js';
import { redact } from './redact.js';

export type Span = { from: number; to: number };
export type Turn = { line: number; at: number; role: 'user' | 'agent' | 'tool' | 'error'; text: string };
/** A skill's run, from its call to the next prompt; `next` is what followed it first, a prompt only when it came within two minutes. */
export type SkillRun = { name: string; line: number; at: number; end: number; next?: 'interrupt' | 'rejected' | 'reply'; replyMs?: number };
/** Where a session worked: the folders of the files it wrote and those its commands ran in, each with how often. */
export type Work = { wrote: Record<string, number>; ran: Record<string, number> };
/** One session as the index reads it: only what its lines say inside the span, text clipped and redacted, tool output left out. */
export type Outline = {
  agent: AgentKind; session: string; file: string; model?: string; cwd?: string; branch?: string;
  start: number; end: number; turns: Turn[]; prompts: Turn[]; skills: SkillRun[];
  tools: number; errors: number; interrupts: number; rejected: number; prs: string[]; costUsd?: number;
  commands: { text: string; failed: boolean }[]; hookErrors: number; work: Work;
};

export const CLIP = { text: 1500, input: 300, error: 300 } as const;
const REPLY_MS = 2 * 60_000;
// a PR's link; the user:password@ a remote's URL can carry falls outside its groups
const PR = /(https?:\/\/)(?:[^\s/@"'<>`\\]*@)?([^\s/@"'<>()[\]{}`\\]+\/[^\s/"'<>()[\]{}`\\]+\/[^\s/"'<>()[\]{}`\\]+\/pull\/\d+)/g;

// a call that writes a PR's body or a comment on one, the output most rules govern, whose input is kept as agent text is
export const GH_BODY = /\bgh\s+(?:pr\s+(?:create|edit|comment)\b|api\b.*\bbody=)/;

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

/** Folds what a reader finds in a session, in order and inside the span, into its outline. */
export function outliner() {
  const o = { start: 0, end: 0, turns: [] as Turn[], prompts: [] as Turn[], skills: [] as SkillRun[], tools: 0, errors: 0, interrupts: 0, rejected: 0, commands: [] as Outline['commands'], hookErrors: 0 };
  const prs = new Set<string>();
  const work: Work = { wrote: {}, ran: {} };
  const count = (m: Record<string, number>, dir?: string) => { if (dir) m[dir] = (m[dir] ?? 0) + 1; };
  // the runs no prompt has ended yet
  let open: SkillRun[] = [];
  const links = (text: string) => { for (const [, scheme, rest] of text.matchAll(PR)) prs.add(scheme + rest); };
  const turn = (role: Turn['role'], line: number, at: number, text: string): Turn => {
    if (!o.start || at < o.start) o.start = at;
    o.end = Math.max(o.end, at);
    const t = { line, at, role, text };
    o.turns.push(t);
    return t;
  };
  const follow = (next: 'interrupt' | 'rejected') => { for (const r of open) r.next ??= next; };
  // whole before it is clipped, so a secret the clip cuts is still masked
  const masked = (text: string, max: number): string => ellipsis(redact(text), max);
  return {
    prompt(line: number, at: number, text: string) {
      links(text);
      const last = o.turns.at(-1)?.at;
      for (const r of open) {
        r.end = at;
        if (last === undefined) continue;
        r.replyMs = at - last;
        if (!r.next && r.replyMs <= REPLY_MS) r.next = 'reply';
      }
      open = [];
      o.prompts.push(turn('user', line, at, masked(text, CLIP.text)));
    },
    said(line: number, at: number, text: string) {
      links(text);
      turn('agent', line, at, masked(text, CLIP.text));
    },
    tool(line: number, at: number, name: string, input: unknown) {
      // JSON text, as a Codex call's arguments are, is read as the input it holds
      const v = typeof input === 'string' ? orSkip(() => JSON.parse(input) as unknown) ?? input : input;
      const given = typeof v === 'string' ? v : JSON.stringify(leaves(v)) ?? '';
      links(given);
      o.tools++;
      turn('tool', line, at, `${name} ${masked(given, GH_BODY.test(given) ? CLIP.text : CLIP.input)}`);
    },
    error(line: number, at: number, text: string) {
      o.errors++;
      turn('error', line, at, masked(text, CLIP.error));
    },
    rejected(line: number, at: number, tool: string) {
      o.rejected++;
      follow('rejected');
      turn('error', line, at, `[rejected] ${tool}`);
    },
    interrupt(line: number, at: number) {
      o.interrupts++;
      follow('interrupt');
      turn('user', line, at, '[interrupted]');
    },
    // a skill already running since the last prompt is the same run, read again or named twice
    skill(name: string, line: number, at: number) {
      if (open.some((r) => r.name === name)) return;
      const r: SkillRun = { name, line, at, end: at };
      open.push(r);
      o.skills.push(r);
    },
    command(text: string, failed: boolean) {
      o.commands.push({ text: masked(text, CLIP.input), failed });
    },
    pr(url: string) {
      prs.add(url);
    },
    wrote(file: string, cwd?: string) {
      const f = pathAt(file, cwd);
      count(work.wrote, f && path.dirname(f));
    },
    ran(command: string, cwd?: string) {
      const to = (CD.exec(command) ?? GIT_C.exec(command))?.[1];
      count(work.ran, to ? pathAt(to, cwd) : cwd);
    },
    hookError() {
      o.hookErrors++;
    },
    // a run no prompt ended lasts to the session's last turn
    outline(head: Pick<Outline, 'agent' | 'session' | 'file' | 'model' | 'cwd' | 'branch' | 'costUsd'>): Outline {
      for (const r of open) r.end = Math.max(r.at, o.end);
      return { ...head, ...o, prs: [...prs], work };
    },
  };
}
