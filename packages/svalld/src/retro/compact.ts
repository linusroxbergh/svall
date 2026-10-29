import path from 'node:path';
import { ellipsis } from '@svall/protocol';
import { GH_BODY, type Outline, type Turn } from './outline.js';

/** Bumped when a compacted line reads differently, so cached cards of the old text are read again. */
export const COMPACT_VERSION = 1;

/** One line of a compacted session and the turns it stands for, in order. */
export type Line = { ids: string[]; at: number; role: 'user' | 'agent' | 'subagent' | 'skill' | 'body' | 'event' | 'tools'; text: string };

const COMMANDS = 8, FILES = 6, COMMAND = 80, OUTPUT = 120;
const REJECTED = '[rejected] ';

const firstLine = (s: string): string => s.split('\n').map((l) => l.trim()).find(Boolean) ?? '';

// a run of tool calls and their errors: the tools by name, the files they name, then each command and error, every failure
// kept and the rest up to eight in all
function tools(run: Turn[]): string {
  const named = new Map<string, number>();
  for (const t of run) if (t.role === 'tool' && !t.cmd) named.set(t.name ?? 'tool', (named.get(t.name ?? 'tool') ?? 0) + 1);
  const files = [...new Set(run.flatMap((t) => (t.file ? [path.basename(t.file)] : [])))];
  const marks = run.flatMap((t, i) => {
    if (t.role === 'error') return [{ i, failed: true, text: `✗ ${ellipsis(firstLine(t.text), OUTPUT)}` }];
    if (!t.cmd) return [];
    const cmd = ellipsis(t.cmd.text, COMMAND);
    if (!t.cmd.failed) return [{ i, failed: false, text: `✓ ${cmd}` }];
    const out = t.cmd.out ? ` → "${ellipsis(firstLine(t.cmd.out), OUTPUT)}"` : '';
    return [{ i, failed: true, text: `✗${t.cmd.exit === undefined ? '' : `(${t.cmd.exit})`} ${cmd}${out}` }];
  });
  const failed = marks.filter((m) => m.failed).slice(0, COMMANDS);
  const shown = [...failed, ...marks.filter((m) => !m.failed).slice(0, COMMANDS - failed.length)].sort((a, b) => a.i - b.i);
  const head = [...named].map(([n, k]) => (k > 1 ? `${n}×${k}` : n)).join(' ');
  return [
    `TOOLS${head ? ` ${head}` : ''}${files.length ? ` (${files.slice(0, FILES).join(', ')}${files.length > FILES ? ', …' : ''})` : ''}`,
    ...shown.map((m) => m.text), ...(marks.length > shown.length ? [`+${marks.length - shown.length} more`] : []),
  ].join(' · ');
}

/** A session as the cards read it: what the user and agents said kept as it is, a skill call named, a PR body, a rejection
 *  and an interrupt kept apart, and each run of other tool calls folded into one line. */
export function compact(o: Outline): Line[] {
  const runs = new Map(o.skills.map((r) => [r.id, r]));
  const out: Line[] = [];
  let run: Turn[] = [];
  const flush = () => {
    if (run.length) out.push({ ids: run.map((t) => t.id), at: run[0].at, role: 'tools', text: tools(run) });
    run = [];
  };
  const own = (t: Turn, role: Line['role'], text: string) => {
    flush();
    out.push({ ids: [t.id], at: t.at, role, text });
  };
  for (const t of o.turns) {
    const skill = t.role === 'tool' ? runs.get(t.id) : undefined;
    if (t.role === 'user') own(t, 'user', `USER: ${t.text}`);
    else if (t.role === 'agent') own(t, 'agent', `AGENT: ${t.text}`);
    else if (t.role === 'subagent') own(t, 'subagent', t.text);
    else if (skill) own(t, 'skill', `SKILL ${skill.name}${skill.inferred ? ' (inferred)' : ''}`);
    else if (t.role === 'tool' && GH_BODY.test(t.text)) own(t, 'body', `GH_BODY: ${t.text}`);
    else if (t.role === 'error' && t.text.startsWith(REJECTED)) own(t, 'event', `REJECTED ${t.text.slice(REJECTED.length)}`);
    else run.push(t);
  }
  flush();
  return out;
}

/** A line as a model reads it, `L12.0 USER: …`, or with the range it folds, `L120.0–134.1 TOOLS …`. */
export const lineText = (l: Line): string => `${l.ids[0]}${l.ids.length > 1 ? `–${l.ids.at(-1)!.slice(1)}` : ''} ${l.text}`;
