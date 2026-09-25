/** A string as one shell word, whatever it holds. */
export const shq = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`;

/** The text on a single line, its runs of whitespace squeezed to one space. */
export const oneLine = (s: string): string => s.replace(/\s+/g, ' ').trim();
