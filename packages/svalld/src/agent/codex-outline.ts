import path from 'node:path';
import { inSpan, outliner, type Outline, type Span, type Turn } from '../retro/outline.js';
import { orSkip } from './jsonl.js';

type Texts = { text?: string }[];
type Item = {
  type?: string; content?: Texts; command?: unknown; status?: string; exit_code?: number; aggregated_output?: string;
  server?: string; tool?: string; result?: { isError?: boolean; content?: Texts }; error?: { message?: string };
};
type Payload = {
  type?: string; id?: string; cwd?: string; model?: string; git?: { branch?: string };
  message?: string; name?: string; arguments?: unknown; input?: unknown; item?: Item;
};
type Line = { timestamp?: string; type?: string; payload?: Payload };

// a read of a skill's SKILL.md runs that skill, as a $name in a prompt does
const SKILL_READ = /\bskills\/(?:[^\s'"]+\/)?([^/\s'"]+)\/SKILL\.md\b/g;
const MENTION = /(?:^|\s)\$([a-z][\w-]*)/g;

const texts = (c?: Texts): string => (c ?? []).map((x) => x.text ?? '').join('').trim();
// the command a shell ran, without the `zsh -lc` it ran under
const commandOf = (c: unknown): string =>
  Array.isArray(c) ? (c.length === 3 && /^-l?c$/.test(String(c[1])) ? String(c[2]) : c.join(' ')) : String(c ?? '');

/** Codex records no cost, so the outline carries none. */
export function outlineCodex(text: string, file: string, span: Span): Outline {
  const out = outliner();
  let session = path.basename(file, '.jsonl'), cwd: string | undefined, model: string | undefined, branch: string | undefined;
  // what was said last: a version that wrote it both as an event and as an item says it twice in a row
  let said: string | undefined;
  // a sub-agent's rollout holds its parent's session_meta after its own
  let met = false;
  // the calls no command has ended yet, newest last
  const calls: Turn[] = [];
  text.split('\n').forEach((raw, i) => {
    const l = raw.startsWith('{') ? orSkip(() => JSON.parse(raw) as Line) : undefined;
    if (!l?.payload) return;
    const p = l.payload;
    const n = i + 1;
    if (l.type === 'session_meta') {
      if (met) return;
      met = true;
      session = p.id ?? session;
      cwd = p.cwd ?? cwd;
      branch = p.git?.branch ?? branch;
      return;
    }
    const at = Date.parse(l.timestamp ?? '');
    if (!inSpan(at, span)) return;
    if (l.type === 'turn_context') {
      cwd = p.cwd ?? cwd;
      model = p.model ?? model;
      return;
    }
    if (l.type === 'response_item' && (p.type === 'function_call' || p.type === 'custom_tool_call')) {
      said = undefined;
      calls.push(out.tool(n, at, p.name ?? 'call', p.arguments ?? p.input));
      return;
    }
    if (l.type !== 'event_msg') return;
    if (p.type === 'turn_aborted') {
      said = undefined;
      out.interrupt(n, at);
      return;
    }
    const it = p.type === 'item_completed' ? p.item : undefined;
    if (it?.type === 'CommandExecution') {
      said = undefined;
      const command = commandOf(it.command);
      const failed = it.status === 'failed' || (typeof it.exit_code === 'number' && it.exit_code !== 0);
      // a command ends the newest call that holds it, as calls can run side by side, else the newest call
      const escaped = JSON.stringify(command).slice(1, -1);
      let i = calls.length - 1;
      while (i >= 0 && !calls[i].text.includes(command) && !calls[i].text.includes(escaped)) i--;
      const [call] = calls.splice(i >= 0 ? i : calls.length - 1, 1);
      out.ran(call, n, at, command, { failed, ...(typeof it.exit_code === 'number' && { exit: it.exit_code }), out: it.aggregated_output });
      for (const m of command.matchAll(SKILL_READ)) out.skill(m[1], n, at, { id: call?.id, inferred: true });
      return;
    }
    if (it?.type === 'McpToolCall' && (it.status === 'failed' || it.result?.isError)) {
      said = undefined;
      out.error(n, at, texts(it.result?.content) || it.error?.message || `${it.server}/${it.tool} failed`);
      return;
    }
    // what a person sent and the agent answered: an event up to codex 0.142, a completed item since
    const role = p.type === 'user_message' || it?.type === 'UserMessage' ? 'user' : p.type === 'agent_message' || it?.type === 'AgentMessage' ? 'agent' : undefined;
    const words = (it ? texts(it.content) : p.message ?? '').trim();
    if (!role || !words || said === role + words) return;
    said = role + words;
    if (role === 'agent') {
      out.said(n, at, words);
      return;
    }
    out.prompt(n, at, words);
    for (const m of words.matchAll(MENTION)) out.skill(m[1], n, at);
  });
  return out.outline({ agent: 'codex', session, file, model, cwd, branch });
}
