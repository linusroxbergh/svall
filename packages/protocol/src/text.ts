/** `s` cut to `n` characters, its last one an ellipsis when anything was cut. */
export const ellipsis = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** `s` without the run of `chars` it ends in. A regex like /x+$/ backtracks over every run of x, so a long one stalls it. */
export function trimEnd(s: string, chars: string): string {
  let end = s.length;
  while (end > 0 && chars.includes(s[end - 1])) end--;
  return s.slice(0, end);
}
