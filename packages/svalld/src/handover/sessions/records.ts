import path from 'node:path';
import { SessionError, type SessionFs } from './types.js';

/** The release a CLI names in its `--version` line, whatever it wraps it in. */
export const versionOf = (text: string): string | undefined => /\d+\.\d+\.\d+[0-9A-Za-z.+-]*/.exec(text)?.[0];

const gone = (e: unknown): boolean => (e as NodeJS.ErrnoException).code === 'ENOENT';
const unreadable = (file: string, e: unknown): SessionError => new SessionError('path_unsupported', `${file}: ${(e as NodeJS.ErrnoException).code ?? String(e)}`);

/** The transcript itself: a regular file, never followed through a link. */
export async function transcriptFile(fs: SessionFs, file: string): Promise<void> {
  let entry;
  try { entry = await fs.lstat(file); } catch (e) {
    if (gone(e)) throw new SessionError('transcript_missing', `${file} is not there`);
    throw unreadable(file, e);
  }
  if (entry.isSymbolicLink() || !entry.isFile()) throw new SessionError('incompatible_adapter', `${file} is not a regular file`);
}

/** Every regular file under `home/dir`, relative to `home`; nothing when the folder is absent. A link anywhere refuses the session. */
export async function filesUnder(fs: SessionFs, home: string, dir: string): Promise<string[]> {
  const full = path.posix.join(home, dir);
  let entry;
  try { entry = await fs.lstat(full); } catch (e) {
    if (gone(e)) return [];
    throw unreadable(full, e);
  }
  if (entry.isSymbolicLink()) throw new SessionError('incompatible_adapter', `${full} is a link`);
  if (entry.isFile()) return [dir];
  if (!entry.isDirectory()) throw new SessionError('incompatible_adapter', `${full} is neither a file nor a folder`);
  const out: string[] = [];
  let names: Buffer[];
  try { names = await fs.readdir(full); } catch (e) { throw unreadable(full, e); }
  for (const raw of names) {
    const name = raw.toString('utf8');
    if (!Buffer.from(name, 'utf8').equals(raw) || /[\x00-\x1f\x7f]/.test(name)) {
      throw new SessionError('path_unsupported', `${full} holds a file name a handover cannot carry`);
    }
    out.push(...await filesUnder(fs, home, path.posix.join(dir, name)));
  }
  return out;
}
