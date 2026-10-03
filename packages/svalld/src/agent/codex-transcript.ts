import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { trimEnd } from '@svall/protocol';
import { MAX_PROMPT } from '../hooks/receiver.js';
import type { Pending } from './claude-transcript.js';
import { LINK, MAX_URLS, clip, clipLine, jsonLines, orSkip } from './jsonl.js';

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

type Event = { kind: 'user' | 'agent'; text: string } | { kind: 'tool'; name: string; given: unknown } | { kind: 'output'; printed: unknown };

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
  const said = events(text).flatMap((e) => (e.kind === 'user' ? [e.text] : []));
  const list = said.slice(-limit).reverse().map(clip);
  // the hook reports a prompt before the rollout holds it, so it leads until its own line, the newest, lands.
  // The hook clips a long prompt, ends trimmed or not, and the rollout does not, so one longer than that is matched on its head
  const head = pending?.text.trim();
  const last = said.at(-1);
  const landed = head !== undefined && last !== undefined && (last === head || (last.length > MAX_PROMPT && last.startsWith(head)));
  if (head && !landed) list.unshift(clip(head));
  return list.slice(0, limit);
}

const urlsIn = (v: unknown): string[] => (JSON.stringify(v ?? '').match(LINK) ?? []).map((u) => trimEnd(u, '.,;:!?'));

// a codex turn is a dozen tool calls to one thing said, each on a line of its own in the rollout. They
// ride on the agent's line here, so a turn is counted by what was said, as it is for Claude Code
export function condenseTurnsCodex(text: string, turns: number, { toolLinks = false } = {}): string {
  const rendered: { who: 'USER' | 'AGENT'; parts: string[]; said: boolean; urls: Set<string> }[] = [];
  const agent = (fresh = false) => {
    const last = rendered.at(-1);
    if (last?.who === 'AGENT' && !(fresh && last.said)) return last;
    rendered.push({ who: 'AGENT', parts: [], said: false, urls: new Set() });
    return rendered.at(-1)!;
  };
  for (const e of events(text)) {
    if (e.kind === 'user') rendered.push({ who: 'USER', parts: [e.text], said: true, urls: new Set() });
    else if (e.kind === 'agent') {
      // what the agent says next starts a line; what it says after only calling tools finishes theirs
      const line = agent(true);
      line.parts.push(e.text);
      line.said = true;
    } else if (e.kind === 'tool') {
      const line = agent();
      line.parts.push(`[tool: ${e.name}]`);
      if (toolLinks) for (const u of urlsIn(e.given)) line.urls.add(u);
    } else if (e.kind === 'output' && toolLinks) {
      const line = agent();
      for (const u of urlsIn(e.printed)) line.urls.add(u);
    }
  }
  const out = rendered.flatMap((r) => {
    const links = r.urls.size ? [`[links: ${[...r.urls].slice(0, MAX_URLS).join(' ')}]`] : [];
    const body = [...r.parts, ...links].join(' ');
    if (!body) return [];
    const s = `${r.who}: ${body}`;
    return [clipLine(s)];
  });
  return turns > 0 ? out.slice(-turns).join('\n') : '';
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
