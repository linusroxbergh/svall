// schemes a tab can show; any other `word:` prefix is a phrase, and a search
const SCHEMES = /^(https?|file|data|mailto|about|blob):\S/i;

// a loopback host gets http; a loadable scheme is kept; a host or bracketed IPv6 address with an optional port and path gets https; anything else is a search
export function toUrl(input: string): string {
  const raw = input.trim();
  if (!raw) return '';
  const host = raw.split(/[/?#]/)[0];
  if (/^((?:[\w-]+\.)*localhost|127(?:\.\d+){3}|0\.0\.0\.0|\[::1?\])(:\d+)?$/i.test(host)) return `http://${raw}`;
  if (SCHEMES.test(raw)) return raw;
  if (!/\s/.test(raw) && /^([^\s.:]+(\.[^\s.:]+)+|\[[\da-f:.]+\])(:\d+)?$/i.test(host)) return `https://${raw}`;
  return `https://www.google.com/search?q=${encodeURIComponent(raw)}`;
}
