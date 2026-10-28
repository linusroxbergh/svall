const MAX_ENTRY = 2000;
export const MAX_URLS = 10;
export const LINK = /https?:\/\/[^\s"'<>()[\]{}`\\]+/g;

const clipAt = (s: string, max: number): string => (s.length > max ? s.slice(0, max) + '…' : s);
export const clip = (s: string): string => clipAt(s, MAX_ENTRY);
// a rendered line: an entry, and the `USER: ` or such it is said under
export const clipLine = (s: string): string => clipAt(s, MAX_ENTRY + 6);

export const orSkip = <T>(read: () => T): T | undefined => {
  try { return read(); } catch { return undefined; }
};

export function jsonLines<T>(text: string): T[] {
  const out: T[] = [];
  for (const line of text.split('\n')) {
    if (!line.startsWith('{')) continue;
    try { out.push(JSON.parse(line) as T); } catch { /* partial or junk line */ }
  }
  return out;
}
