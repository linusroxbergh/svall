import fs from 'node:fs';
import os from 'node:os';

// O_EXLOCK (macOS) takes flock(LOCK_EX) as the file opens; the kernel drops it once its holder's process is gone, however it ended
export const LOCK_FLAGS = fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_NONBLOCK | 0x20;

type Options = { file?: string; load?: () => number; cores?: number; pollMs?: number; log?: (line: string) => void };
type Hold = { fd: Promise<number>; count: number };

// vitest imports a global setup once per project, all in one process, and a second open there would wait on the first
const holds = ((globalThis as { svallTmuxLocks?: Map<string, Hold> }).svallTmuxLocks ??= new Map<string, Hold>());

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function every30s(log: (line: string) => void): (line: string) => void {
  let next = 0;
  return (line) => { if (Date.now() >= next) { next = Date.now() + 30_000; log(`svall tests: ${line}`); } };
}

async function acquire(file: string, o: Options): Promise<number> {
  const { load = () => os.loadavg()[0], cores = os.availableParallelism(), pollMs = 1000, log = (l) => process.stderr.write(`${l}\n`) } = o;
  const waitLock = every30s(log);
  let fd: number | undefined;
  while (fd === undefined) {
    try { fd = fs.openSync(file, LOCK_FLAGS, 0o666); } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EAGAIN') throw e;
      let who = '';
      try { const h = JSON.parse(fs.readFileSync(file, 'utf8')); who = `, held by pid ${h.pid} in ${h.cwd} since ${h.since}`; } catch { /* still being written */ }
      waitLock(`waiting for the tmux test lock${who} (SVALL_NO_TEST_LOCK=1 runs without it)`);
      await sleep(pollMs);
    }
  }
  fs.ftruncateSync(fd);
  fs.writeSync(fd, JSON.stringify({ pid: process.pid, cwd: process.cwd(), since: new Date().toTimeString().slice(0, 8) }));
  const waitLoad = every30s(log);
  for (let l = load(); l > cores; l = load()) {
    waitLoad(`waiting while the 1-minute load average, ${l.toFixed(1)}, is above the ${cores} cores`);
    await sleep(pollMs);
  }
  return fd;
}

/**
 * Takes the machine's one lock for test runs that start tmux servers or ptys, then waits while the 1-minute load is above the
 * core count. The lock holds until every taker in this process has released it.
 */
export async function takeTmuxLock(o: Options = {}): Promise<() => void> {
  const file = o.file ?? '/tmp/svall-tmux-tests.lock';
  const hold = holds.get(file) ?? { fd: acquire(file, o), count: 0 };
  holds.set(file, hold);
  hold.count++;
  const fd = await hold.fd.catch((e) => { holds.delete(file); throw e; });
  return () => { if (--hold.count === 0) { holds.delete(file); fs.closeSync(fd); } };
}

export default async function setup(): Promise<(() => void) | undefined> {
  if (process.platform !== 'darwin' || process.env.SVALL_NO_TEST_LOCK === '1') return undefined;
  return takeTmuxLock();
}
