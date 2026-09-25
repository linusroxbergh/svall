import fs from 'node:fs';
import { lastWorkdir } from './codex-transcript.js';

// how much of a rollout first seen is read back; after that only what it gains. A completed command
// carries its whole output, so one line can run to hundreds of kilobytes
const FIRST_READ = 4 * 1024 * 1024;

/** How far a rollout has been read, and the newest directory outside the session's that a command ran in. */
export type RolloutMark = { file: string; offset: number; dir?: string };

/** The mark moved to the rollout's last whole line, taking up any command that ran outside `home` on the way. */
export function followRollout(file: string, home: string, mark?: RolloutMark): RolloutMark {
  let fd: number | undefined;
  try {
    const size = fs.statSync(file).size;
    const same = mark?.file === file && mark.offset <= size;
    const start = same ? mark.offset : Math.max(0, size - FIRST_READ);
    fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(size - start);
    const read = fs.readSync(fd, buf, 0, buf.length, start);
    // a line codex is still writing is read again once it ends
    const end = buf.subarray(0, read).lastIndexOf(0x0a) + 1;
    const dir = lastWorkdir(buf.toString('utf8', 0, end), home) ?? (same ? mark.dir : undefined);
    return { file, offset: start + end, ...(dir && { dir }) };
  } catch {
    return mark?.file === file ? mark : { file, offset: 0 };
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}
