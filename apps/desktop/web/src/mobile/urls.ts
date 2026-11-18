// the web links addon's own pattern, so the long-press text links what a tap on the terminal opens
const WEB_URL = /(https?|HTTPS?):[/]{2}[^\s"'!*(){}|\\^<>`]*[^\s"':,.!?{}|\\^~[\]`()<>]/g;

/** A row of the terminal's buffer; a wrapped one carries on the line of the row above. */
export type Row = { text: string; wrapped: boolean };
export type Piece = string | { href: string; text: string };

/** The rows as one text, each URL in it a piece of its own, split at the row ends a wrapped URL crosses. */
export function linkText(rows: Row[]): Piece[] {
  const out: Piece[] = [];
  const plain = (s: string) => {
    if (!s) return;
    if (typeof out.at(-1) === 'string') out[out.length - 1] += s;
    else out.push(s);
  };
  for (let i = 0; i < rows.length;) {
    let end = i + 1;
    while (end < rows.length && rows[end].wrapped) end++;
    const line = rows.slice(i, end).map((r) => r.text);
    const joined = line.join('');
    const urls = [...joined.matchAll(WEB_URL)];
    let start = 0;
    for (const [k, text] of line.entries()) {
      if (k) plain('\n');
      const stop = start + text.length;
      let at = start;
      for (const m of urls) {
        const from = Math.max(m.index, start);
        const to = Math.min(m.index + m[0].length, stop);
        if (from >= to) continue;
        plain(joined.slice(at, from));
        out.push({ href: m[0], text: joined.slice(from, to) });
        at = to;
      }
      plain(joined.slice(at, stop));
      start = stop;
    }
    if (end < rows.length) plain('\n');
    i = end;
  }
  return out;
}
