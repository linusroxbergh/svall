import { execFile } from 'node:child_process';
import fs from 'node:fs';
import { promisify } from 'node:util';
import { FEEDBACK_DIAGNOSTICS_MAX, FEEDBACK_LOG_LINES, maskHome, type SystemInfo } from '@svall/protocol';

/** The macOS version, or undefined where sw_vers cannot say. */
export async function macos(): Promise<string | undefined> {
  try { return (await promisify(execFile)('sw_vers', ['-productVersion'])).stdout.trim() || undefined; } catch { return undefined; }
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
  try { lines = fs.readFileSync(o.log, 'utf8').split('\n').filter(Boolean).slice(-FEEDBACK_LOG_LINES); } catch { lines = ['(no log)']; }
  const build = (from: number) => maskHome([...head, ...lines.slice(from)].join('\n'), o.home);
  let from = 0;
  while (from < lines.length - 1 && build(from).length > FEEDBACK_DIAGNOSTICS_MAX) from++;
  return build(from);
}
