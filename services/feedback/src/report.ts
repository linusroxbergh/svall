export type Report = { kind: 'bug' | 'idea'; text: string; diagnostics?: string };
export type Issue = { title: string; body: string; labels: string[] };

const MAX_TEXT = 10_000;
const MAX_DIAGNOSTICS = 50_000;
const MAX_TITLE = 80;

export function parseReport(body: unknown): Report | { error: string } {
  if (typeof body !== 'object' || body === null) return { error: 'expected a JSON object' };
  const { kind, text, diagnostics } = body as Record<string, unknown>;
  if (kind !== 'bug' && kind !== 'idea') return { error: 'kind must be "bug" or "idea"' };
  if (typeof text !== 'string' || !text.trim()) return { error: 'text is required' };
  if (text.trim().length > MAX_TEXT) return { error: `text is over ${MAX_TEXT} characters` };
  if (diagnostics === undefined) return { kind, text: text.trim() };
  if (typeof diagnostics !== 'string') return { error: 'diagnostics must be a string' };
  if (diagnostics.length > MAX_DIAGNOSTICS) return { error: `diagnostics is over ${MAX_DIAGNOSTICS} characters` };
  return { kind, text: text.trim(), diagnostics };
}

export function issueOf(r: Report): Issue {
  const first = r.text.split('\n', 1)[0]!.trim();
  const title = first.length > MAX_TITLE ? `${first.slice(0, MAX_TITLE - 1)}…` : first;
  let body = r.text;
  if (r.diagnostics !== undefined) {
    body = closeFence(body);
    const longest = Math.max(0, ...(r.diagnostics.match(/`+/g) ?? []).map((run) => run.length));
    const fence = '`'.repeat(Math.max(3, longest + 1));
    body += `\n\n<details><summary>Diagnostics</summary>\n\n${fence}text\n${r.diagnostics}\n${fence}\n\n</details>`;
  }
  return { title, body, labels: [r.kind] };
}

// a fence the text leaves open would swallow the diagnostics block after it
function closeFence(text: string): string {
  let open: string | undefined;
  for (const line of text.split('\n')) {
    const m = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (!m) continue;
    const fence = m[1]!, rest = m[2]!;
    if (!open) { if (fence[0] === '~' || !rest.includes('`')) open = fence; }
    else if (fence[0] === open[0] && fence.length >= open.length && !rest.trim()) open = undefined;
  }
  return open ? `${text}\n${open}` : text;
}
