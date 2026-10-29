import path from 'node:path';
import { inSpan, outliner, type Outline, type Span } from '../retro/outline.js';
import { submitted } from './claude-transcript.js';
import { orSkip } from './jsonl.js';

type Block = { type: string; id?: string; tool_use_id?: string; text?: string; name?: string; input?: unknown; content?: unknown; is_error?: boolean };
type Line = {
  type?: string; timestamp?: string; isSidechain?: boolean; isMeta?: boolean; origin?: { kind?: string };
  cwd?: string; gitBranch?: string; message?: { model?: string; content?: string | Block[] };
  attachment?: { type?: string; commandMode?: string; origin?: { kind?: string }; prompt?: string | Block[] };
  prUrl?: string; totalCostUSD?: number;
};

// the only line types parsed; logged API requests and the like are most of a transcript's bytes
const READ = new Set(['user', 'assistant', 'attachment', 'system', 'pr-link', 'cost-state']);
const REJECTED = "The user doesn't want to proceed";
const INTERRUPT = '[Request interrupted by user';
// a skill's text, loaded after its Skill call or after the person typed its slash command
const SKILL_TEXT = 'Base directory for this skill:';
const HOOK_ERROR = /^hook_\w*error$/;
const WRITES = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

function lines(text: string): { n: number; e: Line }[] {
  const out: { n: number; e: Line }[] = [];
  text.split('\n').forEach((raw, i) => {
    if (!raw.startsWith('{') || (raw.startsWith('{"type":"') && !READ.has(raw.slice(9, raw.indexOf('"', 9))))) return;
    const e = orSkip(() => JSON.parse(raw) as Line);
    if (e) out.push({ n: i + 1, e });
  });
  return out;
}

const blocks = (e: Line): Block[] => (Array.isArray(e.message?.content) ? e.message.content : []);
const textOf = (c: unknown): string => (typeof c === 'string' ? c : Array.isArray(c) ? c.map((b: Block) => b.text ?? '').join('\n') : '').trim();
const rejection = (b: Block): boolean => Boolean(b.is_error) && textOf(b.content).startsWith(REJECTED);

// the file a tool call wrote or the command it ran, from the folder the session stood in
function worked(out: ReturnType<typeof outliner>, b: Block, cwd?: string): void {
  const input = (b.input ?? {}) as { file_path?: unknown; notebook_path?: unknown; command?: unknown };
  const file = input.file_path ?? input.notebook_path;
  if (WRITES.has(b.name ?? '') && typeof file === 'string') out.wrote(file, cwd);
  if (b.name === 'Bash' && typeof input.command === 'string') out.ran(input.command, cwd);
}

function subagentCounts(text: string, span: Span, out: ReturnType<typeof outliner>): { tools: number; errors: number } {
  let [tools, errors] = [0, 0];
  let cwd: string | undefined;
  for (const { e } of lines(text)) {
    cwd = e.cwd ?? cwd;
    if (!inSpan(Date.parse(e.timestamp ?? ''), span)) continue;
    for (const b of blocks(e)) {
      if (e.type === 'assistant' && b.type === 'tool_use') { tools++; worked(out, b, cwd); }
      if (e.type === 'user' && b.type === 'tool_result' && b.is_error && !rejection(b)) errors++;
    }
  }
  return { tools, errors };
}

/** `subagents` are the texts of the session's subagent files; their tool calls and errors count toward its outline. */
export function outlineClaude(text: string, file: string, span: Span, subagents: string[] = []): Outline {
  const out = outliner();
  const calls = new Map<string, { name: string; command?: string }>();
  let model: string | undefined, cwd: string | undefined, branch: string | undefined;
  // a cost-state line has no time of its own; it holds what the session had cost by the line before it
  let lastAt = NaN, costBefore = 0, costAfter: number | undefined;
  // a slash command just typed, which the next line shows to be a skill when it loads one
  let typed: { name: string; n: number; at: number } | undefined;
  for (const { n, e } of lines(text)) {
    if (e.type === 'cost-state') {
      if (typeof e.totalCostUSD !== 'number') continue;
      if (!(lastAt >= span.from)) costBefore = e.totalCostUSD;
      else if (lastAt <= span.to) costAfter = e.totalCostUSD;
      continue;
    }
    const at = Date.parse(e.timestamp ?? '');
    if (!Number.isNaN(at)) lastAt = at;
    if (!inSpan(at, span) || e.isSidechain) continue;
    const command = typed;
    typed = undefined;
    if (e.type === 'pr-link' && typeof e.prUrl === 'string') out.pr(e.prUrl);
    if (e.type === 'attachment' && HOOK_ERROR.test(e.attachment?.type ?? '')) out.hookError();
    if (e.type !== 'user' && e.type !== 'assistant' && e.type !== 'attachment') continue;
    cwd = e.cwd ?? cwd;
    branch = e.gitBranch ?? branch;
    const said = orSkip(() => submitted(e));
    if (said) {
      out.prompt(n, at, said);
      const name = /^\/(\S+)/.exec(said)?.[1];
      if (name) typed = { name, n, at };
      continue;
    }
    if (e.type === 'assistant') {
      if (e.message?.model && e.message.model !== '<synthetic>') model = e.message.model;
      for (const b of blocks(e)) {
        if (b.type === 'text' && b.text?.trim()) out.said(n, at, b.text.trim());
        if (b.type !== 'tool_use') continue;
        const name = b.name ?? 'tool';
        const input = (b.input ?? {}) as { skill?: unknown; command?: unknown };
        out.tool(n, at, name, b.input);
        worked(out, b, cwd);
        calls.set(b.id ?? '', { name, ...(name === 'Bash' && typeof input.command === 'string' && { command: input.command }) });
        if (name === 'Skill' && typeof input.skill === 'string') out.skill(input.skill, n, at);
      }
      continue;
    }
    if (e.type !== 'user') continue;
    const first = textOf(typeof e.message?.content === 'string' ? e.message.content : blocks(e).find((b) => b.type === 'text')?.text);
    if (first.startsWith(INTERRUPT)) out.interrupt(n, at);
    if (e.isMeta && command && first.startsWith(SKILL_TEXT)) out.skill(command.name, command.n, command.at);
    for (const b of blocks(e)) {
      if (b.type !== 'tool_result') continue;
      const call = calls.get(b.tool_use_id ?? '');
      if (rejection(b)) {
        out.rejected(n, at, call?.name ?? 'tool');
        continue;
      }
      if (b.is_error) out.error(n, at, textOf(b.content));
      if (call?.command !== undefined) out.command(call.command, Boolean(b.is_error));
    }
  }
  const counts = subagents.map((s) => subagentCounts(s, span, out));
  const o = out.outline({ agent: 'claude', session: path.basename(file, '.jsonl'), file, model, cwd, branch, costUsd: costAfter === undefined ? undefined : costAfter - costBefore });
  for (const c of counts) {
    o.tools += c.tools;
    o.errors += c.errors;
  }
  return o;
}
