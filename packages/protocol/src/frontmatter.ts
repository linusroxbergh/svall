// a leading block between two --- lines, each alone on its line but for trailing spaces, with no lines or some between;
// a byte order mark may come first
const BLOCK = /^(\uFEFF?---[ \t]*)\r?\n(?:([\s\S]*?)\r?\n)??(---[ \t]*)(?=\r?\n|$)/;

const inner = (m: RegExpExecArray): string[] => (m[2] === undefined ? [] : m[2].split(/\r?\n/));

// a key's value runs on over the indented lines under it
function runOn(lines: string[], at: number): number {
  let end = at + 1;
  while (end < lines.length && /^\s+\S/.test(lines[end])) end++;
  return end;
}

const unquote = (v: string): string => {
  const d = /^"(.*)"$/.exec(v);
  return d ? d[1].replace(/\\(["\\])/g, '$1') : v.replace(/^'(.*)'$/, '$1');
};

/** Name and description from a leading frontmatter block, each where it first stands; a value over several lines, block and folded ones too, reads as one line. */
export function frontmatter(text: string): { name?: string; description?: string } {
  const m = BLOCK.exec(text);
  if (!m) return {};
  const lines = inner(m);
  const out: { name?: string; description?: string } = {};
  const seen = new Set<string>();
  lines.forEach((line, i) => {
    const kv = /^(name|description):\s*(.*)$/.exec(line);
    if (!kv || seen.has(kv[1])) return;
    seen.add(kv[1]);
    const first = kv[2].trim();
    const parts = [/^[|>][+-]?$/.test(first) ? '' : first, ...lines.slice(i + 1, runOn(lines, i)).map((l) => l.trim())];
    const v = unquote(parts.filter(Boolean).join(' '));
    if (v) out[kv[1] as 'name' | 'description'] = v;
  });
  return out;
}

/** Just past the block's closing --- line, before its line break; 0 when the text opens with no block. */
export const frontmatterEnd = (text: string): number => BLOCK.exec(text)?.[0].length ?? 0;

/** The text after the block and the line break that closes it. */
export function bodyOf(text: string): string {
  const end = frontmatterEnd(text);
  return end ? text.slice(end).replace(/^\r?\n/, '') : text;
}

// a value a YAML reader, or the one above, would take for something else goes in double quotes
const scalar = (v: string): string =>
  v === '' || !/^[\s!&*[\]{}|>@`"'%#,?:-]|: | #|:$|\s$/.test(v) ? v : `"${v.replace(/[\\"]/g, '\\$&')}"`;

/** The text with its description set to `value` on one line; the block is made when there is none, and every other line is kept. */
export function withDescription(text: string, value: string): string {
  const line = `description: ${scalar(value.replace(/[\r\n]+/g, ' '))}`;
  const m = BLOCK.exec(text);
  if (!m) return `---\n${line}\n---\n\n${text}`;
  const nl = m[0].includes('\r\n') ? '\r\n' : '\n';
  const lines = inner(m);
  const at = lines.findIndex((l) => /^description:/.test(l));
  if (at === -1) lines.unshift(line);
  else lines.splice(at, runOn(lines, at) - at, line);
  return `${m[1]}${nl}${lines.join(nl)}${nl}${m[3]}${text.slice(m[0].length)}`;
}
