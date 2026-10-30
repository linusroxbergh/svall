import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { Duplex } from 'node:stream';
import { setTimeout as sleep } from 'node:timers/promises';
import { sha256Hex } from '../hash.js';
import { runProcess, type RunResult } from './process.js';

// what ssh in batch mode says where it would have asked for a password or a passphrase, or about a host key
const SSH_AUTH = /permission denied|too many authentication failures|no supported authentication/i;
const SSH_HOST_KEY = /host key verification failed|remote host identification has changed/i;
// what Tailscale SSH in check mode prints while it waits for a check in the browser, until the timeout kills ssh
const SSH_APPROVAL = /tailscale ssh requires an additional check|login\.tailscale\.com\/a\//i;

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
  [SSH_AUTH, 'auth'],
  // a close during authentication names the user or says preauth; every other close is the transport's
  [/connection closed by (authenticating|invalid) user|\[preauth\]/i, 'auth'],
  // batch mode never takes Tailscale's browser check
  [SSH_APPROVAL, 'auth'],
  [SSH_HOST_KEY, 'host_key'],
  [/connection refused|connection timed out|operation timed out|could not resolve|name or service not known|no route to host|network is unreachable/i, 'unreachable'],
  // a master that died takes its socket with it: every command on it fails until one is opened again
  [/control socket|connection closed|closed by remote host|connection reset|broken pipe/i, 'unreachable'],
];

export function classifySsh(stderr: string): SshErrorKind {
  return PATTERNS.find(([pattern]) => pattern.test(stderr))?.[1] ?? 'other';
}

/**
 * A far command's exit: ssh's own failure (255), an `svall` the far shell could not run (126, 127), else `otherwise`. A mux
 * client whose master went away exits 255 silently or dies of a signal; that is the transport.
 */
export function classifyExit(r: Pick<RunResult, 'code' | 'signal' | 'stderr'>, otherwise: SshErrorKind): SshErrorKind {
  if (r.code === null || r.signal !== null) return 'unreachable';
  if (r.code === 255) return r.stderr.trim() ? classifySsh(r.stderr) : 'unreachable';
  if (r.code === 126 || r.code === 127) return 'version';
  return otherwise;
}

/**
 * The host every command on a master names: with no master, an `.invalid` name (RFC 6761) resolves nowhere, whatever the
 * search domains, so ssh never falls back to an unchecked connection of its own.
 */
const REMOTE_HOST = 'svall-remote.invalid';

// a session would hand the master the forwards a `Host *` block of the user's config names, and run its RemoteCommand
const SESSION = ['-o', 'ClearAllForwardings=yes', '-o', 'RemoteCommand=none'];

function defaultSocketDir(tmp: string = process.env.TMPDIR ?? os.tmpdir()): string {
  return path.join(tmp, `svall-${process.getuid?.() ?? 0}`);
}

/**
 * mkdir sets the mode only on a directory it creates, so one already there, or a symlink someone left in its place, is read
 * back before a socket goes in it.
 */
function ownSocketDir(dir: string): string {
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
// The pid in front keeps each process on a master of its own, and names whose master it is once that process is gone
const socketFor = (dir: string, destination: string): string =>
  path.join(dir, `${process.pid}-${sha256Hex(destination).slice(0, 12)}`);

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
    // in a session of its own, so a terminal's Ctrl-C reaches only this process, which ends it on exit.
    // The user's ssh config for the destination neither forwards the agent or X11 to any session on it nor binds its forwards
    const child = spawn('ssh', [
      '-M', '-S', this.socket, '-N', '-o', 'BatchMode=yes', '-o', 'ControlPersist=no',
      '-o', 'ForwardAgent=no', '-o', 'ForwardX11=no', '-o', 'ClearAllForwardings=yes',
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
      // a master still waiting may have said what for, as one waiting on a Tailscale check does
      if (Date.now() >= end) {
        const kind = classifySsh(stderr);
        throw this.fail(kind === 'other' ? 'unreachable' : kind, `ssh did not open a control master to ${this.destination} within ${OPEN_TIMEOUT}ms${stderr.trim() ? `: ${stderr.trim()}` : ''}`);
      }
      await sleep(POLL);
    }
  }

  private fail(kind: SshErrorKind, message: string): SshError {
    this.release();
    // an ssh in a terminal can answer what batch mode could not: a passphrase, a password, or Tailscale's check
    return new SshError(kind, kind === 'auth' ? `${message}; run ssh ${this.destination} once in a terminal, then try again` : message);
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
   * The one `--` in `argv` sends every remote argument on verbatim (ssh.c `opt_terminated`); a second would reach the far
   * shell as a word. That shell gets the argv as one line, so anything but a literal flag goes through `shq` first.
   */
  run(argv: string[], o: { timeoutMs?: number; signal?: AbortSignal; maxOutputBytes?: number; input?: string | Uint8Array } = {}): Promise<RunResult> {
    return runProcess('ssh', this.argv(SESSION, argv), { ...o, timeoutMs: o.timeoutMs ?? RUN_TIMEOUT });
  }

  /** Runs a command on the far machine with its stdin and stdout as one stream; ending the stream ends ssh. */
  stream(argv: string[]): { stream: Duplex; exited: Promise<Pick<RunResult, 'code' | 'signal' | 'stderr'>> } {
    const child = spawn('ssh', this.argv(SESSION, argv), { stdio: ['pipe', 'pipe', 'pipe'], detached: true });
    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => { stderr = (stderr + chunk.toString()).slice(-4096); });
    const stream = Duplex.from({ readable: child.stdout, writable: child.stdin });
    stream.on('close', () => child.kill());
    child.on('error', (err) => stream.destroy(err));
    const exited = new Promise<Pick<RunResult, 'code' | 'signal' | 'stderr'>>((resolve) => {
      child.on('close', (code, signal) => resolve({ code, signal, stderr }));
    });
    return { stream, exited };
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
    // with no config read, it asks the master for this forward alone, not those a `Host *` block names
    const r = await runProcess('ssh', this.argv(['-F', 'none', '-O', command, '-L', spec], []), { timeoutMs: CONTROL_TIMEOUT });
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
