import { trimEnd } from '@svall/protocol';
import { LINK, MAX_URLS, clip, clipLine, jsonLines, orSkip } from './jsonl.js';
import { carries } from './turns.js';

type Block = { type: string; text?: string; name?: string; input?: unknown; content?: unknown };
type Entry = {
  type?: string; isSidechain?: boolean; isMeta?: boolean; promptId?: string; timestamp?: string; origin?: { kind?: string }; message?: { content?: string | Block[] };
  toolUseResult?: { questions?: unknown; answers?: Record<string, string> };
  attachment?: { type?: string; commandMode?: string; origin?: { kind?: string }; prompt?: string | Block[] };
};

const entries = (text: string): Entry[] => jsonLines<Entry>(text);

// the URLs a tool call was given or printed, which the prose around it may never repeat
function toolUrls(blocks: Block[]): string[] {
  const raw = blocks.map((b) => (b.type === 'tool_use' ? JSON.stringify(b.input ?? '') : b.type === 'tool_result' ? JSON.stringify(b.content ?? '') : '')).join(' ');
  return [...new Set((raw.match(LINK) ?? []).map((u) => trimEnd(u, '.,;:!?')))].slice(0, MAX_URLS);
}

function render(e: Entry, toolLinks: boolean): string | undefined {
  const c = e.message?.content;
  const urls = toolLinks && Array.isArray(c) ? toolUrls(c) : [];
  const links = urls.length ? `[links: ${urls.join(' ')}]` : '';
  if (e.type === 'user') {
    if (typeof c === 'string') return `USER: ${c}`;
    const text = (c ?? []).filter((b) => b.type === 'text').map((b) => b.text ?? '').join(' ').trim();
    return text ? `USER: ${text}` : links ? `TOOL: ${links}` : undefined;
  }
  if (e.type === 'assistant') {
    const parts = (Array.isArray(c) ? c : []).map((b) =>
      b.type === 'text' ? (b.text ?? '').trim() : b.type === 'tool_use' ? `[tool: ${b.name}]` : '');
    const text = [...parts, links].filter(Boolean).join(' ');
    return text ? `CLAUDE: ${text}` : undefined;
  }
  return undefined;
}

const textOf = (c: string | Block[] | undefined): string =>
  (typeof c === 'string' ? c : (c ?? []).filter((b) => b.type === 'text').map((b) => b.text ?? '').join('\n')).trim();

// a prompt submitted while a turn runs reaches it between tool calls, written as a queued command rather than a user entry
function queued(e: Entry): string | undefined {
  const a = e.attachment;
  return e.type === 'attachment' && !e.isSidechain && a?.type === 'queued_command' ? textOf(a.prompt) || undefined : undefined;
}

const COMMAND = /<command-name>([^<]*)<\/command-name>/;
const COMMAND_ARGS = /<command-args>([\s\S]*?)<\/command-args>/;

// Claude Code stamps the turns a person typed with a human origin. Everything else sharing the user
// stream — tool results, task notifications, interrupts, local command output — is its own writing.
// A typed slash command is the exception: it arrives unstamped, inside a command envelope.
export function submitted(e: Entry): string | undefined {
  if (e.type === 'attachment') return e.attachment?.commandMode === 'prompt' && e.attachment.origin?.kind === 'human' ? queued(e) : undefined;
  if (e.type !== 'user' || e.isSidechain || e.isMeta) return undefined;
  const text = textOf(e.message?.content);
  if (!text) return undefined;
  const cmd = COMMAND.exec(text);
  if (cmd) return [cmd[1].trim(), COMMAND_ARGS.exec(text)?.[1].trim()].filter(Boolean).join(' ');
  return e.origin?.kind === 'human' ? text : undefined;
}

// the questions AskUserQuestion put to the person, each over what they picked or wrote; a declined one has no answers
function answered(e: Entry): string | undefined {
  const r = e.toolUseResult;
  if (e.type !== 'user' || !Array.isArray(r?.questions) || !r.answers) return undefined;
  return Object.entries(r.answers).map(([q, a]) => `${q}\n→ ${a}`).join('\n\n') || undefined;
}

const INTERRUPT = '[Request interrupted by user';

/** When an Esc or a "No" ended the turn, if that is the newest thing the user side wrote; Claude Code fires no hook for it. */
export function interruptedAt(text: string): number | undefined {
  const last = entries(text).filter((e) => e.type === 'user' && !e.isSidechain && !e.isMeta).at(-1);
  const c = last?.message?.content;
  const said = typeof c === 'string' ? c : c?.find((b) => b.type === 'text')?.text;
  return said?.startsWith(INTERRUPT) ? Date.parse(last?.timestamp ?? '') || undefined : undefined;
}

export type Pending = { id: string; text: string; at: number };

// a turn Claude Code opened by itself — a finished background agent, a continuation — carries an origin
// that is not a person's. The hook fires for those too, and what it reports was never typed.
const machine = (e: Entry): boolean => Boolean(e.origin?.kind) && e.origin?.kind !== 'human';

// what an entry says was put to the session, typed or not
const carried = (e: Entry): string | undefined => orSkip(() => submitted(e) ?? (machine(e) ? textOf(e.message?.content) : queued(e)));

// the hook's prompt leads until an entry from its turn on carries its text: the hook names the turn it came in, and one sent
// mid-turn lands later, queued into it or opening the next. An entry written since the hook means it was never the newest
function leads(all: Entry[], sent: { e: Entry }[], pending: Pending): boolean {
  const turn = all.findIndex((e) => e.promptId === pending.id);
  if (turn >= 0 && all.slice(turn).some((e) => carries(carried(e), pending.text))) return false;
  return !(Date.parse(sent.at(-1)?.e.timestamp ?? '') > pending.at);
}

export function userPromptsClaude(text: string, limit: number, pending?: Pending): string[] {
  const all = entries(text);
  const said = all.map((e) => ({ e, text: orSkip(() => submitted(e)), answers: orSkip(() => answered(e)) }));
  const sent = said.filter((r) => r.text);
  const list = said.flatMap((r) => r.text ?? r.answers ?? []).slice(-limit).reverse().map(clip);
  if (pending && leads(all, sent, pending)) list.unshift(clip(pending.text));
  return list.slice(0, limit);
}

// toolLinks adds the URLs tool calls were given or printed, which are otherwise left out
export function condenseTurnsClaude(text: string, turns: number, { toolLinks = false } = {}): string {
  const rendered = entries(text)
    .filter((e) => !e.isSidechain)
    .map((e) => orSkip(() => render(e, toolLinks)))
    .filter((s): s is string => Boolean(s))
    .map(clipLine);
  return turns > 0 ? rendered.slice(-turns).join('\n') : '';
}
