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

/** Replaces `file` through a temporary name, so an interrupted write cannot truncate what is there.
 *  `perProcess` puts this process's id in that name, for a file two processes may write at once. */
export function writeAtomic(file: string, text: string, o: { mode?: number; perProcess?: boolean } = {}): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = o.perProcess ? `${file}.tmp-${process.pid}` : `${file}.tmp`;
  fs.writeFileSync(tmp, text, o.mode === undefined ? undefined : { mode: o.mode });
  fs.renameSync(tmp, file);
}

export const writeJsonAtomic = (file: string, value: unknown, o: { mode?: number; perProcess?: boolean } = {}): void =>
  writeAtomic(file, JSON.stringify(value, null, 2), o);
