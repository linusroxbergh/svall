import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Pending } from './claude-transcript.js';
import { jsonLines, orSkip } from './jsonl.js';
import { condenseEvents, promptsOf, type Event } from './turns.js';

export type RawRateWindow = { used_percent?: number; window_minutes?: number; resets_at?: number } | null;
export type RawRateLimits = { primary?: RawRateWindow; secondary?: RawRateWindow; plan_type?: string | null };

type Payload = {
  type?: string; message?: string; name?: string; arguments?: unknown; input?: unknown; output?: unknown;
  item?: { type?: string; content?: { text?: string }[]; cwd?: unknown };
  info?: { last_token_usage?: { total_tokens?: number }; model_context_window?: number } | null;
  rate_limits?: RawRateLimits | null;
};
type Line = { timestamp?: string; type?: string; payload?: Payload };

const lines = (text: string): Line[] => jsonLines<Line>(text);

const ITEMS: Record<string, 'user' | 'agent'> = { UserMessage: 'user', AgentMessage: 'agent' };

// what a person sent and the agent answered: `user_message`/`agent_message` up to codex 0.142, a completed item
// since, never the `response_item` messages, which carry codex's notes to the model too; a tool call is a `response_item`
function eventOf(l: Line): Event | undefined {
  const p = l.payload;
  if (!p) return undefined;
  if (l.type === 'event_msg') {
    const kind = p.type === 'user_message' ? 'user' : p.type === 'agent_message' ? 'agent' : p.type === 'item_completed' ? ITEMS[p.item?.type ?? ''] : undefined;
    const text = (p.type === 'item_completed' ? (p.item?.content ?? []).map((c) => c.text ?? '').join('') : p.message ?? '').trim();
    return kind && text ? { kind, text } : undefined;
  }
  if (l.type !== 'response_item') return undefined;
  if (p.type === 'function_call' || p.type === 'custom_tool_call') return { kind: 'tool', name: p.name ?? 'call', given: p.arguments ?? p.input };
  if (p.type === 'function_call_output' || p.type === 'custom_tool_call_output') return { kind: 'output', printed: p.output };
  return undefined;
}

// a version that wrote what was said both ways would say it twice in a row
function events(text: string): Event[] {
  const out: Event[] = [];
  for (const l of lines(text)) {
    const e = orSkip(() => eventOf(l));
    const last = out.at(-1);
    if (!e || ('text' in e && last && 'text' in last && last.kind === e.kind && last.text === e.text)) continue;
    out.push(e);
  }
  return out;
}

export function userPromptsCodex(text: string, limit: number, pending?: Pending): string[] {
  return promptsOf(events(text).flatMap((e) => (e.kind === 'user' ? [e.text] : [])), limit, pending);
}

export function condenseTurnsCodex(text: string, turns: number, opts: { toolLinks?: boolean } = {}): string {
  return condenseEvents(events(text), turns, opts);
}

// where a command ran: the directory a completed command records since codex 0.155, the workdir an
// exec_command or shell call names up to 0.142, which is the session's own when it names none
function ranIn(l: Line, home: string): string | undefined {
  const p = l.payload;
  if (l.type === 'event_msg' && p?.type === 'item_completed' && p.item?.type === 'CommandExecution') {
    const cwd = p.item.cwd;
    if (typeof cwd !== 'string') return undefined;
    return cwd.startsWith('file:') ? fileURLToPath(cwd) : cwd;
  }
  if (l.type === 'response_item' && p?.type === 'function_call' && (p.name === 'exec_command' || p.name === 'shell') && typeof p.arguments === 'string') {
    const { workdir } = JSON.parse(p.arguments) as { workdir?: unknown };
    return typeof workdir === 'string' ? path.resolve(home, workdir) : home;
  }
  return undefined;
}

/** The directory of the newest command that ran outside `home`, the directory the session began in. */
export function lastWorkdir(text: string, home: string): string | undefined {
  for (const l of lines(text).reverse()) {
    const dir = orSkip(() => ranIn(l, home));
    if (dir && path.isAbsolute(dir) && path.resolve(dir) !== path.resolve(home)) return path.resolve(dir);
  }
  return undefined;
}

/** The newest token_count line: how full the context is now, what the plan has left, and when it was written. */
export function lastTokenCount(text: string): { pct: number; at: number; limits?: RawRateLimits } | undefined {
  for (const l of lines(text).reverse()) {
    const p = l.payload;
    if (l.type !== 'event_msg' || p?.type !== 'token_count') continue;
    // total_token_usage adds up the whole session; last_token_usage is what the context holds
    const used = p.info?.last_token_usage?.total_tokens;
    const window = p.info?.model_context_window;
    if (typeof used !== 'number' || typeof window !== 'number' || window <= 0) continue;
    return { pct: Math.min(100, Math.round((used / window) * 100)), at: Date.parse(l.timestamp ?? '') || 0, ...(p.rate_limits && { limits: p.rate_limits }) };
  }
  return undefined;
}
