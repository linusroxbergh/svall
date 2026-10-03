import fs from 'node:fs';
import path from 'node:path';

/** What `file` holds, read through `parse`; a file that cannot be read is moved aside and nothing comes
 *  back. An error `rethrow` accepts is the caller's to answer, and leaves the file where it is. */
export function readJsonOrQuarantine<T>(
  file: string,
  log: (msg: string) => void,
  parse: (raw: unknown) => T,
  rethrow: (e: unknown) => boolean = () => false,
): T | undefined {
  if (!fs.existsSync(file)) return undefined;
  try {
    return parse(JSON.parse(fs.readFileSync(file, 'utf8')));
  } catch (e) {
    if (rethrow(e)) throw e;
    const broken = `${file}.broken-${Date.now()}`;
    fs.renameSync(file, broken);
    log(`${path.basename(file)} unreadable (${String(e)}); moved to ${broken}`);
    return undefined;
  }
}

type WriteOptions = { mode?: number; perProcess?: boolean; mkdir?: boolean };

/** Replaces `file` through a temporary name synced to disk first, so no crash can truncate it. `perProcess` names that
 *  temporary for this process, for a file two may write; `mkdir: false` fails rather than make a folder that is gone. */
export function writeAtomic(file: string, text: string, o: WriteOptions = {}): void {
  if (o.mkdir !== false) fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = o.perProcess ? `${file}.tmp-${process.pid}` : `${file}.tmp`;
  const fd = fs.openSync(tmp, 'w', o.mode);
  try {
    fs.writeFileSync(fd, text);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, file);
}

export const writeJsonAtomic = (file: string, value: unknown, o: WriteOptions = {}): void =>
  writeAtomic(file, JSON.stringify(value, null, 2), o);
