import { LINK, MAX_URLS, clip, clipLine, jsonLines, orSkip } from './jsonl.js';

type Block = { type: string; text?: string; name?: string; input?: unknown; content?: unknown };
type Entry = { type?: string; isSidechain?: boolean; isMeta?: boolean; promptId?: string; timestamp?: string; origin?: { kind?: string }; message?: { content?: string | Block[] } };

const entries = (text: string): Entry[] => jsonLines<Entry>(text);

// the URLs a tool call was given or printed, which the prose around it may never repeat
function toolUrls(blocks: Block[]): string[] {
  const raw = blocks.map((b) => (b.type === 'tool_use' ? JSON.stringify(b.input ?? '') : b.type === 'tool_result' ? JSON.stringify(b.content ?? '') : '')).join(' ');
  return [...new Set((raw.match(LINK) ?? []).map((u) => u.replace(/[.,;:!?]+$/, '')))].slice(0, MAX_URLS);
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

const COMMAND = /<command-name>([^<]*)<\/command-name>/;
const COMMAND_ARGS = /<command-args>([^<]*)<\/command-args>/;

// Claude Code stamps the turns a person typed with a human origin. Everything else sharing the user
// stream — tool results, task notifications, interrupts, local command output — is its own writing.
// A typed slash command is the exception: it arrives unstamped, inside a command envelope.
function submitted(e: Entry): string | undefined {
  if (e.type !== 'user' || e.isSidechain || e.isMeta) return undefined;
  const c = e.message?.content;
  const text = (typeof c === 'string' ? c : (c ?? []).filter((b) => b.type === 'text').map((b) => b.text ?? '').join('\n')).trim();
  if (!text) return undefined;
  const cmd = COMMAND.exec(text);
  if (cmd) return [cmd[1].trim(), COMMAND_ARGS.exec(text)?.[1].trim()].filter(Boolean).join(' ');
  return e.origin?.kind === 'human' ? text : undefined;
}

export type Pending = { id: string; text: string; at: number };

// a turn Claude Code opened by itself — a finished background agent, a continuation — carries an origin
// that is not a person's. The hook fires for those too, and what it reports was never typed.
const machine = (e: Entry): boolean => Boolean(e.origin?.kind) && e.origin?.kind !== 'human';

// Claude Code writes a prompt down after its UserPromptSubmit hook, and a long turn can push it out
// of the tail, so the reported prompt leads the list until its own entry shows up — or until one under
// the same id shows it opened a turn nobody typed. An entry written since the hook means the reported
// one was never the newest, and it is dropped instead.
function leads(all: Entry[], sent: { e: Entry }[], pending: Pending): boolean {
  if (all.some((e) => e.promptId === pending.id && (orSkip(() => submitted(e)) || machine(e)))) return false;
  return !(Date.parse(sent.at(-1)?.e.timestamp ?? '') > pending.at);
}

export function userPromptsClaude(text: string, limit: number, pending?: Pending): string[] {
  const all = entries(text);
  const sent = all.map((e) => ({ e, text: orSkip(() => submitted(e)) })).filter((r): r is { e: Entry; text: string } => Boolean(r.text));
  const list = sent.slice(-limit).reverse().map((r) => clip(r.text));
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
