import { execFile } from 'node:child_process';
import { open } from 'node:fs/promises';
import { promisify } from 'node:util';
import { FEEDBACK_DIAGNOSTICS_MAX, FEEDBACK_LOG_LINES, maskHome, type SystemInfo } from '@svall/protocol';

/** The macOS version, or undefined where sw_vers cannot say. */
export async function macos(): Promise<string | undefined> {
  try { return (await promisify(execFile)('sw_vers', ['-productVersion'])).stdout.trim() || undefined; } catch { return undefined; }
}

const TAIL_BYTES = 256 * 1024;

// the log grows for as long as the daemon runs, so only its end is read
async function logTail(file: string): Promise<string[]> {
  const fh = await open(file, 'r');
  try {
    const { size } = await fh.stat();
    const start = Math.max(0, size - TAIL_BYTES);
    const buf = Buffer.alloc(size - start);
    await fh.read(buf, 0, buf.length, start);
    const lines = buf.toString('utf8').split('\n');
    if (start > 0) lines.shift();
    return lines.filter(Boolean).slice(-FEEDBACK_LOG_LINES);
  } finally { await fh.close(); }
}

/** What a feedback report carries: versions, agents and the tail of the daemon log, with the home masked and the oldest log lines dropped to fit. */
export async function diagnostics(o: { info: () => Promise<SystemInfo>; log: string; home: string; macos: () => Promise<string | undefined> }): Promise<string> {
  const [info, mac] = await Promise.all([o.info(), o.macos()]);
  const head = [
    `svall ${info.release} · macOS ${mac ?? '?'} · ${info.arch}`,
    ...(info.git ? [`git ${info.git}`] : []),
    ...info.agentAdapters.map((a) => `${a.kind} ${a.version ?? '?'}${a.hooks === undefined ? '' : a.hooks ? ' · hooks on' : ' · hooks off'}${a.loggedIn === undefined ? '' : a.loggedIn ? ' · logged in' : ' · logged out'}`),
    '', `svalld.log, last ${FEEDBACK_LOG_LINES} lines`,
  ];
  let lines: string[];
  try { lines = await logTail(o.log); } catch { lines = ['(no log)']; }
  const build = (from: number) => maskHome([...head, ...lines.slice(from)].join('\n'), o.home);
  let from = 0;
  while (from < lines.length - 1 && build(from).length > FEEDBACK_DIAGNOSTICS_MAX) from++;
  const text = build(from);
  const cut = text.length - FEEDBACK_DIAGNOSTICS_MAX;
  if (cut <= 0) return text;
  const start = text.lastIndexOf('\n') + 1;
  return text.slice(0, start) + text.slice(start + cut);
}
