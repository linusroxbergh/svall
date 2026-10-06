import { trimEnd } from '@svall/protocol';
import { MAX_PROMPT } from '../hooks/receiver.js';
import type { Pending } from './claude-transcript.js';
import { LINK, MAX_URLS, clip, clipLine } from './jsonl.js';

/** What a session's log says happened: something said, a tool called with what it was given, or what a call printed. */
export type Event = { kind: 'user' | 'agent'; text: string } | { kind: 'tool'; name: string; given: unknown } | { kind: 'output'; printed: unknown };

/** The newest `limit` prompts, newest first. */
export function promptsOf(said: string[], limit: number, pending?: Pending): string[] {
  const list = said.slice(-limit).reverse().map(clip);
  // the hook reports a prompt before the log holds it, so it leads until its own line, the newest, lands.
  // The hook clips a long prompt, ends trimmed or not, and the log does not, so one longer than that is matched on its head
  const head = pending?.text.trim();
  const last = said.at(-1);
  const landed = head !== undefined && last !== undefined && (last === head || (last.length > MAX_PROMPT && last.startsWith(head)));
  if (head && !landed) list.unshift(clip(head));
  return list.slice(0, limit);
}

const urlsIn = (v: unknown): string[] => (JSON.stringify(v ?? '').match(LINK) ?? []).map((u) => trimEnd(u, '.,;:!?'));

// a turn is a dozen tool calls to one thing said, each on a line of its own in the log. They ride on the agent's
// line here, so a turn is counted by what was said, as it is for Claude Code
export function condenseEvents(events: Event[], turns: number, { toolLinks = false } = {}): string {
  const rendered: { who: 'USER' | 'AGENT'; parts: string[]; said: boolean; urls: Set<string> }[] = [];
  const agent = (fresh = false) => {
    const last = rendered.at(-1);
    if (last?.who === 'AGENT' && !(fresh && last.said)) return last;
    rendered.push({ who: 'AGENT', parts: [], said: false, urls: new Set() });
    return rendered.at(-1)!;
  };
  for (const e of events) {
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
    return [clipLine(`${r.who}: ${body}`)];
  });
  return turns > 0 ? out.slice(-turns).join('\n') : '';
}
