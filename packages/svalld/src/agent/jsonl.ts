// what one entry of a rendered transcript may run to, and how many links one turn may carry
const MAX_ENTRY = 2000;
export const MAX_URLS = 10;
export const LINK = /https?:\/\/[^\s"'<>()[\]{}`\\]+/g;

const clipAt = (s: string, max: number): string => (s.length > max ? s.slice(0, max) + '…' : s);
export const clip = (s: string): string => clipAt(s, MAX_ENTRY);
// a rendered line: an entry, and the `USER: ` or such it is said under
export const clipLine = (s: string): string => clipAt(s, MAX_ENTRY + 6);

/** What one line reads as, or nothing for a line of a shape the reader does not know, as for a junk one. */
export const orSkip = <T>(read: () => T): T | undefined => {
  try { return read(); } catch { return undefined; }
};

/** The JSON objects a transcript holds, one to a line; a partial or junk line is skipped. */
export function jsonLines<T>(text: string): T[] {
  const out: T[] = [];
  for (const line of text.split('\n')) {
    if (!line.startsWith('{')) continue;
    try { out.push(JSON.parse(line) as T); } catch { /* partial or junk line */ }
  }
  return out;
}
