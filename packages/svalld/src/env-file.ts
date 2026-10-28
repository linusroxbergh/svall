import fs from 'node:fs';
import { writeDurable } from './durable.js';

/** Why `value` cannot go into a fleet's .env as it is: the reader would give back anything else changed; none when it can. */
export const envValueFault = (value: string): string | undefined => (/[\r\n]/.test(value) || value !== value.trim() || /^(["']).*\1$/.test(value)
  ? 'the value cannot be stored in .env: it must be one line, without leading or trailing spaces, and not wrapped in quotes' : undefined);

/** Writes `NAME=value` into the fleet's .env `file`, mode 600, in place of an earlier line for the name and keeping the others. */
export function writeEnvVar(file: string, name: string, value: string): void {
  const old = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  const lines = old.split('\n').filter((l, i, all) => l !== '' || i < all.length - 1);
  const mine = new RegExp(`^\\s*(?:export\\s+)?${name}\\s*=`);
  const at = lines.findIndex((l) => mine.test(l));
  const kept = lines.filter((l) => !mine.test(l));
  kept.splice(at < 0 ? kept.length : at, 0, `${name}=${value}`);
  writeDurable(file, Buffer.from(`${kept.join('\n')}\n`), { mode: 0o600 });
}
