import { spawn, type ChildProcess } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { runProcess, type RunResult } from './process.js';

const CONTROL_TIMEOUT = 10_000;
const OPEN_TIMEOUT = 20_000;
const RUN_TIMEOUT = 30_000;
const POLL = 100;

export type SshErrorKind = 'auth' | 'host_key' | 'unreachable' | 'version' | 'daemon_down' | 'other';

export class SshError extends Error {
  constructor(readonly kind: SshErrorKind, message: string) { super(message); }
}

// the one reading of what ssh writes to stderr; everything that classifies a failure comes here
const PATTERNS: [RegExp, SshErrorKind][] = [
  [/permission denied|too many authentication failures|no supported authentication/i, 'auth'],
  // a close during authentication names the user or says preauth; every other close is the transport's
  [/connection closed by (authenticating|invalid) user|\[preauth\]/i, 'auth'],
  [/host key verification failed|remote host identification has changed/i, 'host_key'],
  [/connection refused|connection timed out|operation timed out|could not resolve|name or service not known|no route to host|network is unreachable/i, 'unreachable'],
  // a master that died takes its socket with it: every command on it fails until one is opened again
  [/control socket|connection closed|closed by remote host|connection reset|broken pipe/i, 'unreachable'],
];

export function classifySsh(stderr: string): SshErrorKind {
  return PATTERNS.find(([pattern]) => pattern.test(stderr))?.[1] ?? 'other';
}

/**
 * A far command's exit: ssh's own failure (255), an `svall` the far shell could not run (126, 127),
 * else `otherwise`. A mux client whose master went away, or whose run was killed, exits 255 with
 * nothing said or dies of a signal; that is the transport.
 */
export function classifyExit(r: Pick<RunResult, 'code' | 'signal' | 'stderr'>, otherwise: SshErrorKind): SshErrorKind {
  if (r.code === null || r.signal !== null) return 'unreachable';
  if (r.code === 255) return r.stderr.trim() ? classifySsh(r.stderr) : 'unreachable';
  if (r.code === 126 || r.code === 127) return 'version';
  return otherwise;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => { setTimeout(r, ms); });

/**
 * The host every command on a master names. ssh reaches the far machine only through the master's
 * socket; with no master, an `.invalid` name (RFC 6761) resolves nowhere, whatever the search domains,
 * so nothing falls back to a connection of its own that no one checked reaches the machine meant.
 */
export const REMOTE_HOST = 'svall-remote.invalid';

/** This user's folder for sockets in a temp directory. */
export function defaultSocketDir(tmp: string = process.env.TMPDIR ?? os.tmpdir()): string {
  return path.join(tmp, `svall-${process.getuid?.() ?? 0}`);
}

/**
 * A directory in a world-writable temp that only this user can reach. mkdir sets the mode on a
 * directory it creates, so one that was already there — or a symlink someone else left in its
 * place — has to be read back before a socket is put in it.
 */
export function ownSocketDir(dir: string): string {
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  } catch (err) {
    throw new SshError('other', `${dir} could not be made: ${(err as Error).message}`);
  }
  const stat = fs.lstatSync(dir);
  const uid = process.getuid?.();
  if (!stat.isDirectory()) throw new SshError('other', `${dir} is not a directory; move whatever is there out of the way`);
  if (uid !== undefined && stat.uid !== uid) throw new SshError('other', `${dir} belongs to uid ${stat.uid}, not to you`);
  if (stat.mode & 0o077) throw new SshError('other', `${dir} is open to other users (mode ${(stat.mode & 0o777).toString(8)}); a control socket may not live there`);
  return dir;
}

// a control socket path has to stay under the Unix socket limit, so the destination is hashed short.
// The pid keeps each process on a master of its own: one process letting go never ends another's
const socketFor = (dir: string, destination: string): string =>
  path.join(dir, crypto.createHash('sha256').update(`${process.pid}\0${destination}`).digest('hex').slice(0, 12));

/** One master per socket path, so two callers in this process reaching the same destination share the connection. */
const masters = new Map<string, Promise<SshMaster>>();

/** Every master this process spawned and has not let go of. */
const spawned = new Set<ChildProcess>();
let closesOnSignal = false;

/**
 * A process told to stop ends every master it spawned, then exits as the signal would have ended it;
 * otherwise the `ssh -M -N` it started outlives it.
 */
export function closeMastersOnSignal(): void {
  if (closesOnSignal) return;
  closesOnSignal = true;
  for (const [signal, code] of [['SIGTERM', 143], ['SIGINT', 130], ['SIGHUP', 129], ['SIGQUIT', 131]] as const) {
    process.once(signal, () => {
      for (const child of spawned) child.kill();
      process.exit(code);
    });
  }
}

/** An ssh ControlMaster: one authenticated connection that every later command rides on. */
export class SshMaster {
  private refs = 0;
  private child?: ChildProcess;
  private atExit?: () => void;

  private constructor(readonly destination: string, readonly socket: string) {}

  static async open(o: { destination: string; socketDir?: string }): Promise<SshMaster> {
    const socket = socketFor(ownSocketDir(o.socketDir ?? defaultSocketDir()), o.destination);
    const held = masters.get(socket);
    if (held) {
      // a master can die mid-session; the one in hand is only shared while it still answers
      const master = await held.catch(() => undefined);
      if (master && await master.check()) {
        master.refs++;
        return master;
      }
      if (masters.get(socket) === held) masters.delete(socket);
      master?.release();
    }
    const opening = SshMaster.start(o.destination, socket).catch((err: unknown) => { masters.delete(socket); throw err; });
    masters.set(socket, opening);
    const master = await opening;
    master.refs++;
    return master;
  }

  private static start(destination: string, socket: string): Promise<SshMaster> {
    // whatever is on this socket was not spawned by this process, so it is never adopted
    fs.rmSync(socket, { force: true });
    return new SshMaster(destination, socket).spawn();
  }

  private async spawn(): Promise<SshMaster> {
    // in a session of its own, so a terminal's Ctrl-C reaches only this process, which ends it on exit
    const child = spawn('ssh', [
      '-M', '-S', this.socket, '-N', '-o', 'BatchMode=yes', '-o', 'ControlPersist=no',
      '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=3', '-o', 'ConnectTimeout=10', '--', this.destination,
    ], { stdio: ['ignore', 'ignore', 'pipe'], detached: true });
    let stderr = '';
    let gone = false;
    child.stderr.on('data', (chunk: Buffer) => { stderr = (stderr + chunk.toString()).slice(-4096); });
    child.on('close', () => { gone = true; spawned.delete(child); });
    child.on('error', (err) => { gone = true; spawned.delete(child); stderr = `${stderr}\n${err.message}`; });
    // the master outlives every command on it, but never this process
    child.unref();
    (child.stderr as unknown as net.Socket).unref();
    this.child = child;
    spawned.add(child);
    this.atExit = () => child.kill();
    process.once('exit', this.atExit);

    const end = Date.now() + OPEN_TIMEOUT;
    for (;;) {
      if (await this.check()) return this;
      // a master that could not be spawned, or died without a word, is the transport's failure
      if (gone) throw this.fail(child.pid === undefined || !stderr.trim() ? 'unreachable' : classifySsh(stderr), `ssh could not reach ${this.destination}: ${stderr.trim() || 'the control master exited'}`);
      if (Date.now() >= end) throw this.fail('unreachable', `ssh did not open a control master to ${this.destination} within ${OPEN_TIMEOUT}ms`);
      await sleep(POLL);
    }
  }

  private fail(kind: SshErrorKind, message: string): SshError {
    this.release();
    return new SshError(kind, message);
  }

  private release(): void {
    if (this.atExit) process.removeListener('exit', this.atExit);
    this.atExit = undefined;
    this.child?.kill();
    if (this.child) spawned.delete(this.child);
  }

  private argv(control: string[], remote: string[]): string[] {
    return ['-S', this.socket, '-o', 'BatchMode=yes', ...control, '--', REMOTE_HOST, ...remote];
  }

  async check(): Promise<boolean> {
    const r = await runProcess('ssh', this.argv(['-O', 'check'], []), { timeoutMs: CONTROL_TIMEOUT });
    return r.code === 0;
  }

  /**
   * Runs a command on the far machine. ssh re-enters its own option parsing after the destination
   * only when no `--` preceded it (ssh.c `opt_terminated`), so the one `--` in `argv` makes the
   * destination data and sends every remote argument on verbatim — a second one would arrive at the
   * far shell as a word. That shell is handed the argv as a single line, so anything but a literal
   * flag goes through `shq` first.
   */
  run(argv: string[], o: { timeoutMs?: number; signal?: AbortSignal; maxOutputBytes?: number; input?: string | Uint8Array } = {}): Promise<RunResult> {
    return runProcess('ssh', this.argv([], argv), { ...o, timeoutMs: o.timeoutMs ?? RUN_TIMEOUT });
  }

  /**
   * A local port onto a port on the far machine's loopback. ssh does not report back which port the
   * kernel picked for it, so the port is picked here first; another process can take it in between.
   */
  async forward(remotePort: number): Promise<{ localPort: number; cancel: () => Promise<void> }> {
    const localPort = await freePort();
    await this.tunnel('forward', localPort, remotePort);
    return { localPort, cancel: () => this.cancelForward(localPort, remotePort) };
  }

  cancelForward(localPort: number, remotePort: number): Promise<void> {
    return this.tunnel('cancel', localPort, remotePort);
  }

  private async tunnel(command: 'forward' | 'cancel', localPort: number, remotePort: number): Promise<void> {
    const spec = `127.0.0.1:${localPort}:127.0.0.1:${remotePort}`;
    const r = await runProcess('ssh', this.argv(['-O', command, '-L', spec], []), { timeoutMs: CONTROL_TIMEOUT });
    if (r.code !== 0) throw new SshError(classifySsh(r.stderr), `ssh could not ${command} ${spec} on ${this.destination}: ${r.stderr.trim()}`);
  }

  /** Lets go of this master; the last holder shuts it down. */
  async close(): Promise<void> {
    if (this.refs > 0 && --this.refs > 0) return;
    masters.delete(this.socket);
    await runProcess('ssh', this.argv(['-O', 'exit'], []), { timeoutMs: CONTROL_TIMEOUT });
    this.release();
  }
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address() as net.AddressInfo;
      probe.close(() => resolve(port));
    });
  });
}
