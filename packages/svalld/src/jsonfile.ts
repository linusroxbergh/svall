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
