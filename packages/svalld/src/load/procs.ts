import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);

export type LiveProc = { pid: number; ppid: number; start: number; cpuNs: number; mem: number; resp?: number; path: string; args: string; robot?: string; home?: string };

// ps rows carry no start time, so a zero start matches any
export const sameStart = (a: LiveProc, b: LiveProc): boolean => a.start === 0 || b.start === 0 || a.start === b.start;

/** The helper's `procs` output; undefined when it is empty (an older helper) or not that JSON. */
export function parseHelper(out: string): LiveProc[] | undefined {
  try {
    const rows = (JSON.parse(out) as { procs?: ({ cpu: number } & Omit<LiveProc, 'cpuNs'>)[] }).procs;
    if (!Array.isArray(rows)) return undefined;
    return rows.map(({ cpu, ...p }) => ({ ...p, cpuNs: cpu }));
  } catch { return undefined; }
}

// procps puts the days before a time past one, as 2-01:00:00
const cpuNs = (time: string): number => {
  const [, days = '0', clock] = /^(?:(\d+)-)?(.*)$/.exec(time)!;
  return Math.round((Number(days) * 86_400 + clock.split(':').reduce((s, part) => s * 60 + Number(part), 0)) * 1e9);
};

/** `ps -axww -o pid=,ppid=,time=,rss=,args=`. */
export function parsePs(out: string): LiveProc[] {
  const procs: LiveProc[] = [];
  for (const line of out.split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(\d+)\s+(.+)$/.exec(line);
    if (!m) continue;
    procs.push({ pid: Number(m[1]), ppid: Number(m[2]), start: 0, cpuNs: cpuNs(m[3]), mem: Number(m[4]) * 1024, path: m[5].split(/\s/)[0], args: m[5] });
  }
  return procs;
}

const MAX_BUFFER = 64 * 1024 * 1024;

/** The user's processes: from the helper when it runs and answers, else from ps. */
export async function readProcs(helper: string | undefined): Promise<LiveProc[]> {
  if (helper) {
    try {
      const parsed = parseHelper((await exec(helper, ['procs'], { encoding: 'utf8', maxBuffer: MAX_BUFFER, timeout: 10_000 })).stdout);
      if (parsed) return parsed;
    } catch { /* missing or failing helper: ps */ }
  }
  return parsePs((await exec('ps', ['-axww', '-o', 'pid=,ppid=,time=,rss=,args='], { encoding: 'utf8', maxBuffer: MAX_BUFFER, timeout: 10_000 })).stdout);
}
