/** A string as one shell word, whatever it holds. */
export const shq = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`;

/** The string a single-quoted shell word stands for; any other word as it is. */
export const unshq = (s: string): string =>
  (s.startsWith("'") && s.endsWith("'") ? s.slice(1, -1).replace(/'\\''/g, "'") : s);

/** The text on a single line, its runs of whitespace squeezed to one space. */
export const oneLine = (s: string): string => s.replace(/\s+/g, ' ').trim();
