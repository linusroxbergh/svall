import fs from 'node:fs';
import path from 'node:path';
import { writeAtomic } from './jsonfile.js';

export const readOrUndefined = (file: string): string | undefined => {
  try { return fs.readFileSync(file, 'utf8'); } catch { return undefined; }
};

export type JsonSettings = { file: string; text?: string; settings: Record<string, unknown> };

/** Whether two JSON values hold the same. */
export const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

export function readJsonSettings(file: string): JsonSettings {
  if (!fs.existsSync(file)) return { file, settings: {} };
  const text = fs.readFileSync(file, 'utf8');
  try {
    return { file, text, settings: JSON.parse(text) };
  } catch (e) {
    throw new Error(`${file} is not valid JSON (${(e as Error).message}), so nothing was changed; fix it and run again`);
  }
}

/** Throws when `next` changes a file that links into a folder that cannot be written, such as home-manager's store. */
export function requireWritable(current: JsonSettings, next: Record<string, unknown>): void {
  if (current.text === undefined || same(current.settings, next)) return;
  const real = fs.realpathSync(current.file);
  try {
    fs.accessSync(path.dirname(real), fs.constants.W_OK);
  } catch {
    throw new Error(`${current.file} links to ${real}, whose folder is not writable; make the change in ${real} or replace the link with a regular file, then run again`);
  }
}

// an unchanged file is left as it is, so repeated runs leave no pile of backups
export function writeJsonSettings(current: JsonSettings, next: Record<string, unknown>, what: string): string[] {
  if (same(current.settings, next)) return [];
  requireWritable(current, next);
  const done: string[] = [];
  // a linked file (stow, home-manager) is written where it points, with the mode it had
  let file = current.file;
  let mode: number | undefined;
  if (current.text !== undefined) {
    file = fs.realpathSync(current.file);
    mode = fs.statSync(file).mode & 0o777;
    const backup = `${current.file}.bak-${Date.now()}`;
    fs.writeFileSync(backup, current.text, { mode });
    fs.chmodSync(backup, mode);
    done.push(`backup -> ${backup}`);
  }
  fs.mkdirSync(path.dirname(current.file), { recursive: true });
  writeAtomic(file, JSON.stringify(next, null, 2) + '\n', { mode, perProcess: true });
  // the umask narrows the mode a file is created with, so the one it had is set again
  if (mode !== undefined) fs.chmodSync(file, mode);
  done.push(`${what} -> ${current.file}`);
  return done;
}
