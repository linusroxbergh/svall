import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import type { TransferRoot } from '@svall/protocol';
import { CONTROL, GIT_DIR_KEEP_RULES, GIT_KEEP_RULES } from '@svall/svalld/handover/inventory';
import { relativeProblem } from '@svall/svalld/handover/replicas';
import { isRelease, releaseRoot } from '@svall/svalld/release';
import { runProcess } from './process.js';
import { REMOTE_HOST } from './ssh.js';

/** The oldest rsync this engine drives: protected arguments, `--info=progress2` and `--mkpath` all hold from here. */
export const MIN_RSYNC = [3, 2, 3] as const;

const PROBE_TIMEOUT = 10_000;
const KILL_GRACE = 2000;
const STDERR_MAX = 64 * 1024;

/** The rsync this controller ships: in a release's bin/, or the pinned build under vendor/ in a checkout. */
export function bundledRsync(): string {
  const root = releaseRoot();
  if (isRelease()) return path.join(root, 'bin', 'rsync');
  const pins = JSON.parse(fs.readFileSync(path.join(root, 'scripts', 'release', 'pins.json'), 'utf8')) as { rsync: { version: string } };
  return path.join(root, 'vendor', 'rsync', `${pins.rsync.version}-${process.arch}`, 'rsync');
}

export type RsyncProbe = { ok: true; exe: string; version: string } | { ok: false; exe: string; reason: string };

const older = (a: readonly number[], b: readonly number[]): boolean => {
  for (let i = 0; i < b.length; i++) if (a[i] !== b[i]) return a[i] < b[i];
  return false;
};

/** What an rsync's `--version` says about driving it: its version, or why it cannot be. macOS ships openrsync, which cannot. */
export function rsyncVersion(out: string): { version: string } | { reason: string } {
  if (/openrsync/.test(out)) return { reason: 'is openrsync, which cannot protect remote arguments or report byte progress' };
  const m = /^rsync\s+version\s+v?(\d+)\.(\d+)\.(\d+)/.exec(out);
  if (!m) return { reason: `answered --version with ${JSON.stringify(out.split('\n')[0].slice(0, 80))}` };
  const version = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (older(version, MIN_RSYNC)) return { reason: `is rsync ${version.join('.')}; a handover needs ${MIN_RSYNC.join('.')} or newer` };
  return { version: version.join('.') };
}

/** Whether `exe` is an rsync this engine can drive. */
export async function probeRsync(exe: string): Promise<RsyncProbe> {
  let out: string;
  try {
    out = (await runProcess(exe, ['--version'], { timeoutMs: PROBE_TIMEOUT })).stdout;
  } catch (err) {
    return { ok: false, exe, reason: `${exe} could not run: ${(err as Error).message}` };
  }
  const read = rsyncVersion(out);
  return 'version' in read ? { ok: true, exe, version: read.version } : { ok: false, exe, reason: `${exe} ${read.reason}` };
}

/**
 * The local rsync a transfer runs, refused unless it can protect remote arguments. A Linux machine, which a published
 * companion ships no rsync for, drives its own when that one is new enough.
 */
export async function resolveRsync(exe: string = bundledRsync(), platform: NodeJS.Platform = process.platform, system = 'rsync'): Promise<string> {
  const probe = await probeRsync(exe);
  if (probe.ok) return exe;
  if (platform !== 'linux') throw new Error(probe.reason);
  const own = await probeRsync(system);
  if (!own.ok) throw new Error(`${probe.reason}; and ${own.reason}`);
  return system;
}

// rsync splits its -e value on spaces itself: a quoted span keeps them, and a doubled quote is one quote
const rshWord = (word: string): string => `'${word.split("'").join("''")}'`;

/**
 * The `-e` for a transfer over the master on `socket`. rsync appends the host and its server command,
 * so the one `--` lands right before the host, as `SshMaster.run` puts it.
 */
export function remoteShell(socket: string): string {
  if (CONTROL.test(socket)) throw new Error(`the control socket ${JSON.stringify(socket)} holds a control character`);
  return ['ssh', '-S', rshWord(socket), '-o', 'BatchMode=yes', '--'].join(' ');
}

/**
 * A path on the far machine, as rsync's server reads it: it expands `*`, `?` and `[` in any name holding
 * one, so those names are escaped. An escaped name matches only what exists; one that does not keeps its backslashes.
 */
export function remoteSpec(p: string): string {
  const names = p.split('/').map((name) => (/[*?[]/.test(name) ? name.replace(/[*?[\\]/g, '\\$&') : name));
  return `${REMOTE_HOST}:${names.join('/')}`;
}

/** Whether a far path holds a name rsync's server would expand. */
export const expands = (p: string): boolean => /[*?[]/.test(p);

/**
 * The filter file for a root: first the folders the destination keeps as they are, which rsync neither sends nor
 * deletes, then Git's records kept whatever the excludes say, and in a Git directory carried on its own Git's entries
 * at its top as well, then each exclude; the same reading the root's claim was proven under.
 */
export function filterRules(excludes: readonly string[], kind?: TransferRoot['kind'], keep: readonly string[] = []): string {
  const bad = excludes.find((x) => x === '' || CONTROL.test(x));
  if (bad !== undefined) throw new Error(`the exclude ${JSON.stringify(bad)} cannot be written as an rsync rule`);
  const odd = keep.find((k) => relativeProblem(k) || /[*?[]/.test(k));
  if (odd !== undefined) throw new Error(`the kept folder ${JSON.stringify(odd)} cannot be written as an rsync rule`);
  const kept = kind === 'gitdir' ? [...GIT_KEEP_RULES, ...GIT_DIR_KEEP_RULES] : GIT_KEEP_RULES;
  return [...keep.map((k) => `- /${k}/`), ...kept, ...excludes.map((x) => `- ${x}`)].map((line) => `${line}\n`).join('');
}

/** One rsync run: a copy, or the checksum comparison that verifies one. */
export type RsyncJob = {
  rsh: string;
  source: string;
  target: string;
  filterFile?: string;
  // a NUL-separated list of the only paths under the source to copy
  filesFrom?: string;
  delete: boolean;
  mkpath: boolean;
  dryRun: boolean;
  // a copy that compares content rather than size and whole-second mtime
  checksum?: boolean;
};

// no -o/-g: owners and groups are the machine's own. Specials and devices are what the manifest skips
const BASE = ['-rlpt', '--no-specials', '--no-devices', '-s', '-8', '--itemize-changes', '--no-human-readable'];

export function rsyncArgv(job: RsyncJob): string[] {
  return [
    ...BASE,
    ...(job.dryRun ? ['--dry-run', '--checksum'] : [...(job.checksum ? ['--checksum'] : []), '--info=progress2']),
    ...(job.delete ? ['--delete'] : []),
    ...(job.mkpath ? ['--mkpath'] : []),
    ...(job.filterFile ? [`--exclude-from=${job.filterFile}`] : []),
    ...(job.filesFrom ? ['--from0', `--files-from=${job.filesFrom}`] : []),
    '-e', job.rsh,
    '--', job.source, job.target,
  ];
}

export type RsyncLine =
  | { kind: 'item'; change: string; name: string }
  | { kind: 'progress'; bytes: number; done?: number; total?: number }
  | { kind: 'other'; text: string };

// `YXcstpoguax`, a space, the name; a `*` update carries a message such as `deleting` instead
const ITEM = /^([<>ch.][fdLDS][.+ ?a-zA-Z]{9}) (.+)$/;
const MESSAGE = /^\*(\S+) +(.+)$/;
const PROGRESS = /^\s*(\d[\d,]*)\s+\d+%\s+\S+\s+\S+(?:\s+\(xfr#\d+, (?:to|ir)-chk=(\d+)\/(\d+)\))?\s*$/;

/** A link whose only itemized change is its mode: a Linux link is always 0777 and cannot be chmodded, so no pass settles it. */
export const linkModeOnly = (change: string): boolean => /^\.L[. ]{3}p[. ]{5}$/.test(change);

/** What one line of `--itemize-changes --info=progress2` output says. */
export function parseLine(line: string): RsyncLine {
  const item = ITEM.exec(line);
  if (item) return { kind: 'item', change: item[1], name: item[2] };
  const message = MESSAGE.exec(line);
  if (message) return { kind: 'item', change: `*${message[1]}`, name: message[2] };
  const progress = PROGRESS.exec(line);
  if (progress) {
    const bytes = Number(progress[1].replaceAll(',', ''));
    if (progress[2] === undefined) return { kind: 'progress', bytes };
    const total = Number(progress[3]);
    return { kind: 'progress', bytes, done: total - Number(progress[2]), total };
  }
  return { kind: 'other', text: line };
}

export type RsyncResult = { code: number | null; signal: NodeJS.Signals | null; stderr: string };
export type RunRsync = (exe: string, argv: string[], o: { signal?: AbortSignal; onLine: (line: string) => void }) => Promise<RsyncResult>;

/**
 * Runs rsync with an argv array, handing on each stdout line as it ends; progress ends its lines with a
 * carriage return. rsync reads RSYNC_* settings that could turn argument protection off or convert
 * names, so none reaches it. A cancel sends SIGTERM, which rsync cleans up after, then SIGKILL; a
 * terminal's Ctrl-C never does, as rsync and its ssh run in a session of their own.
 */
export const runRsync: RunRsync = (exe, argv, o) => new Promise((resolve, reject) => {
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('RSYNC_')));
  const child = spawn(exe, argv, { env, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
  const decoder = new StringDecoder('utf8');
  let pending = '';
  let stderr = '';
  const take = (text: string) => {
    const lines = (pending + text).split(/[\r\n]/);
    pending = lines.pop() ?? '';
    for (const line of lines) if (line) o.onLine(line);
  };
  child.stdout.on('data', (chunk: Buffer) => take(decoder.write(chunk)));
  child.stderr.on('data', (chunk: Buffer) => { stderr = (stderr + chunk.toString('utf8')).slice(-STDERR_MAX); });

  let killer: NodeJS.Timeout | undefined;
  const stop = () => {
    child.kill('SIGTERM');
    killer = setTimeout(() => child.kill('SIGKILL'), KILL_GRACE);
    killer.unref();
  };
  if (o.signal?.aborted) stop();
  else o.signal?.addEventListener('abort', stop, { once: true });
  const done = () => {
    if (killer) clearTimeout(killer);
    o.signal?.removeEventListener('abort', stop);
  };
  child.on('error', (err) => { done(); reject(err); });
  child.on('close', (code, signal) => {
    done();
    take(`${decoder.end()}\n`);
    resolve({ code, signal, stderr });
  });
});

/**
 * What an exit says: 24 is a source file that vanished under the copy; a closed stream, a timeout or
 * ssh's own 255 is the link.
 */
export function exitKind(r: RsyncResult): 'ok' | 'vanished' | 'disconnected' | 'failed' {
  if (r.code === 0) return 'ok';
  if (r.code === 24) return 'vanished';
  if (r.code !== null && [10, 12, 30, 35, 255].includes(r.code)) return 'disconnected';
  return 'failed';
}
