import { Invalid } from '../errors.js';

// how far from where its header says a hunk may have moved
const SLACK = 20;

type Hunk = { at: number; old: string[]; next: string[] };

function hunks(diff: string, label: string): Hunk[] {
  const out: Hunk[] = [];
  let h: Hunk | undefined;
  for (const line of diff.replace(/\r\n/g, '\n').split('\n')) {
    const head = /^@@ -(\d+)(?:,\d+)? \+\d+(?:,\d+)? @@/.exec(line);
    if (head) { h = { at: Math.max(0, Number(head[1]) - 1), old: [], next: [] }; out.push(h); continue; }
    if (!h || line.startsWith('\\')) continue;
    if (line.startsWith(' ') || line === '') { h.old.push(line.slice(1)); h.next.push(line.slice(1)); }
    else if (line.startsWith('-')) h.old.push(line.slice(1));
    else if (line.startsWith('+')) h.next.push(line.slice(1));
  }
  // a blank line the judge left after its last hunk is no context
  for (const x of out) while (x.old.at(-1) === '' && x.next.at(-1) === '' && x.old.length > 1) { x.old.pop(); x.next.pop(); }
  if (!out.length) throw new Invalid(`the change for ${label} is not a unified diff`);
  return out;
}

/** `text` with a unified diff applied: each hunk's context must match exactly, near where its header puts it. */
export function applyUnified(text: string, diff: string, label: string): string {
  const ends = text.endsWith('\n');
  const lines = (ends ? text.slice(0, -1) : text).split('\n');
  let shift = 0;
  for (const h of hunks(diff, label)) {
    const fits = (i: number) => i >= 0 && i + h.old.length <= lines.length && h.old.every((l, k) => lines[i + k] === l);
    const near = h.at + shift;
    const at = [0, ...Array.from({ length: SLACK }, (_, k) => [k + 1, -(k + 1)]).flat()].map((d) => near + d).find(fits);
    if (at === undefined) throw new Invalid(`the diff no longer fits ${label}`);
    lines.splice(at, h.old.length, ...h.next);
    shift = at - h.at + h.next.length - h.old.length;
  }
  return lines.join('\n') + (ends ? '\n' : '');
}
