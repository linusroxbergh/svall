// a newline in any value would end the row mid-table, so every cell is one line
const cell = (v: string): string => v.replace(/\s+/g, ' ').trim();

export function table(rows: Record<string, string>[]): string {
  if (rows.length === 0) return '(none)';
  const cols = Object.keys(rows[0]);
  const at = (r: Record<string, string>, c: string) => cell(r[c] ?? '');
  const width = cols.map((c) => Math.max(c.length, ...rows.map((r) => at(r, c).length)));
  const line = (vals: string[]) => vals.map((v, i) => v.padEnd(width[i])).join('  ').trimEnd();
  return [line(cols), ...rows.map((r) => line(cols.map((c) => at(r, c))))].join('\n');
}

export function printResult(value: unknown, json: boolean, plain?: () => string): void {
  if (json) process.stdout.write(JSON.stringify(value, null, 2) + '\n');
  else process.stdout.write((plain ? plain() : String(value)) + '\n');
}
