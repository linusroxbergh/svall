import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { z } from 'zod';
import { HandoverChoices, type HandoverEvent } from '@svall/protocol';
import { defaultSocketDir, ownSocketDir } from './ssh.js';

// the longest Unix socket path macOS takes, 104 bytes with its NUL; Linux takes more
const SOCKET_MAX = 103;
// a client that never ends a line is not heard any further
const MAX_LINE = 1024 * 1024;
const LINGER_MS = 2000;

/** Where a fleet's handover helper listens, and what it keeps beside the controller journal. */
export type HelperPaths = { dir: string; socket: string; events: string; log: string; lock: string };

export function helperPaths(fleetHome: string, tmp?: string): HelperPaths {
  const dir = path.join(fleetHome, 'controller');
  const near = path.join(dir, 'handover.sock');
  // a path too long for a socket is hashed from the fleet home, so every process finds the same one
  const socket = Buffer.byteLength(near) <= SOCKET_MAX
    ? near
    : path.join(defaultSocketDir(tmp), `handover-${crypto.createHash('sha256').update(path.resolve(fleetHome)).digest('hex').slice(0, 16)}.sock`);
  return { dir, socket, events: path.join(dir, 'events.ndjson'), log: path.join(dir, 'handover.log'), lock: path.join(dir, 'handover.lock') };
}

/** Whether a helper answers on `socket`; `stale` is a socket file nobody listens on. */
export function probe(socket: string): Promise<'live' | 'stale' | 'none'> {
  return new Promise((resolve) => {
    const s = net.connect(socket);
    s.once('connect', () => { s.destroy(); resolve('live'); });
    s.once('error', (e: NodeJS.ErrnoException) => resolve(e.code === 'ENOENT' ? 'none' : 'stale'));
  });
}

function pidIn(file: string): number | undefined {
  try {
    const n = Number(fs.readFileSync(file, 'utf8').trim());
    return Number.isInteger(n) && n > 0 ? n : undefined;
  } catch {
    return undefined;
  }
}

/** The process that holds this fleet's handover lock. */
export const readPid = (paths: HelperPaths): number | undefined => pidIn(paths.lock);

const errno = (e: unknown): string | undefined => (e as NodeJS.ErrnoException).code;

const writtenAt = (file: string): number | undefined => {
  try {
    return fs.statSync(file).mtimeMs;
  } catch {
    return undefined;
  }
};

/** When a process started, to the second and never later than it did; undefined when ps cannot say. */
function startedAt(pid: number): number | undefined {
  const r = spawnSync('ps', ['-o', 'lstart=', '-p', String(pid)], { encoding: 'utf8', env: { ...process.env, LC_ALL: 'C' } });
  const at = Date.parse(r.stdout?.trim() ?? '');
  return r.status === 0 && Number.isFinite(at) ? at : undefined;
}

/**
 * Whether the process that wrote a lock at `at` still holds it: one runs under its pid, and it started before
 * the lock was written. One started since, after a reboot or a kill, has only been given the same pid.
 */
function holds(pid: number, at: number): boolean {
  try {
    process.kill(pid, 0);
  } catch (e) {
    if (errno(e) !== 'EPERM') return false;
  }
  const started = startedAt(pid);
  return started === undefined || started <= at;
}

/** The running process that holds this fleet's handover lock, if one does. */
export function lockHolder(paths: HelperPaths): number | undefined {
  const pid = readPid(paths);
  const at = writtenAt(paths.lock);
  return pid !== undefined && at !== undefined && holds(pid, at) ? pid : undefined;
}

/** Another helper runs this fleet's handover, and there is one controller at a time. */
export class Live extends Error {
  constructor(readonly pid?: number) {
    super(`a handover of this fleet is already running here${pid ? ` (pid ${pid})` : ''}; follow it with \`svall handover attach\``);
    this.name = 'Live';
  }
}

/** What a client may ask of the helper: an answer to its decision or new rest choices, or a cancel. */
export type Control = { choose: HandoverChoices } | { cancel: true };
const ControlLine = z.union([z.object({ choose: HandoverChoices }), z.object({ cancel: z.literal(true) })]);

function parseControl(line: string): Control | undefined {
  try {
    const r = ControlLine.safeParse(JSON.parse(line));
    return r.success ? r.data : undefined;
  } catch {
    return undefined;
  }
}

function readLines(socket: net.Socket, onLine: (line: string) => void): void {
  let buf = '';
  socket.setEncoding('utf8');
  socket.on('data', (chunk: string) => {
    buf += chunk;
    for (let at = buf.indexOf('\n'); at >= 0; at = buf.indexOf('\n')) {
      const line = buf.slice(0, at);
      buf = buf.slice(at + 1);
      if (line.trim()) onLine(line);
    }
    if (buf.length > MAX_LINE) socket.destroy();
  });
}

/**
 * Takes this fleet's handover lock, `handover.lock`, holding this process's pid: linked into place whole, so it
 * is never read empty. A lock whose holder is gone, this process's own pid given again included, is moved aside
 * before it is removed, so a lock taken meanwhile is never the one removed. Returns what lets it go.
 */
export function takeLock(paths: HelperPaths): () => void {
  fs.mkdirSync(paths.dir, { recursive: true, mode: 0o700 });
  fs.chmodSync(paths.dir, 0o700);
  const own = (suffix: string): string => `${paths.lock}.${suffix}-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
  const mine = own('new');
  fs.writeFileSync(mine, `${process.pid}\n`, { mode: 0o600 });
  try {
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        fs.linkSync(mine, paths.lock);
        return () => { if (readPid(paths) === process.pid) fs.rmSync(paths.lock, { force: true }); };
      } catch (e) {
        if (errno(e) !== 'EEXIST') throw e;
      }
      const holder = readPid(paths);
      const at = writtenAt(paths.lock);
      if (at === undefined) continue;
      if (holder !== undefined && holds(holder, at)) throw new Live(holder);
      const aside = own('gone');
      try { fs.renameSync(paths.lock, aside); } catch (e) {
        if (errno(e) === 'ENOENT') continue;
        throw e;
      }
      const moved = pidIn(aside);
      const movedAt = writtenAt(aside);
      if (moved !== undefined && moved !== holder && movedAt !== undefined && holds(moved, movedAt)) {
        // a helper took the lock after it was read: it goes back, unless yet another has taken the place
        try { fs.linkSync(aside, paths.lock); } catch { /* that one holds it now */ }
        fs.rmSync(aside, { force: true });
        throw new Live(moved);
      }
      fs.rmSync(aside, { force: true });
    }
    throw new Error(`${paths.lock} could not be taken; if no svall handover runs here, remove it`);
  } finally {
    fs.rmSync(mine, { force: true });
  }
}

// only the lock's holder removes a stale socket, so a socket another helper has just bound is never the one removed
async function listen(server: net.Server, paths: HelperPaths): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(paths.socket, () => { server.off('error', reject); resolve(); });
      });
      return;
    } catch (e) {
      if (errno(e) !== 'EADDRINUSE') throw e;
      if ((await probe(paths.socket)) === 'live') throw new Live(readPid(paths));
      if (readPid(paths) !== process.pid) throw new Live(readPid(paths));
      let socket = false;
      try { socket = fs.lstatSync(paths.socket).isSocket(); } catch (err) { if (errno(err) !== 'ENOENT') throw err; }
      if (attempt > 1 || (!socket && fs.existsSync(paths.socket))) throw new Error(`${paths.socket} is in the way of the handover's control socket; move it aside`);
      fs.rmSync(paths.socket, { force: true });
    }
  }
}

/**
 * The live end of one handover run: it holds the fleet's control socket, the single-controller lock, and keeps
 * every event it records in the events file and for each client, which is sent the run so far when it joins.
 */
export class HelperServer {
  private lines: string[] = [];
  private clients = new Set<net.Socket>();
  private control?: (c: Control, from: net.Socket) => void;
  private server = net.createServer((socket) => this.join(socket));

  private constructor(readonly paths: HelperPaths, private scrub: (line: string) => string, private unlock: () => void) {}

  /** Takes the lock and the socket, and starts the events file afresh; throws `Live` while another helper holds them. */
  static async open(paths: HelperPaths, o: { scrub(line: string): string }): Promise<HelperServer> {
    const unlock = takeLock(paths);
    try {
      if (path.dirname(paths.socket) !== paths.dir) ownSocketDir(path.dirname(paths.socket));
      const helper = new HelperServer(paths, o.scrub, unlock);
      await listen(helper.server, paths);
      fs.chmodSync(paths.socket, 0o600);
      fs.writeFileSync(paths.events, '', { mode: 0o600 });
      fs.chmodSync(paths.events, 0o600);
      return helper;
    } catch (e) {
      unlock();
      throw e;
    }
  }

  onControl(fn: (c: Control, from: net.Socket) => void): void {
    this.control = fn;
  }

  /** One event of the run, as every reader gets it: scrubbed, appended to the file and sent to each client. */
  record(e: HandoverEvent): string {
    const line = this.scrub(JSON.stringify(e));
    this.lines.push(line);
    try {
      fs.appendFileSync(this.paths.events, `${line}\n`, { mode: 0o600 });
    } catch { /* the file is for a later reader; the run goes on without it */ }
    for (const c of this.clients) c.write(`${line}\n`);
    return line;
  }

  /** Tells one client how the run ended for it, and lets it go; the others go on watching. */
  release(client: net.Socket, e: HandoverEvent): void {
    this.clients.delete(client);
    client.end(`${this.scrub(JSON.stringify(e))}\n`);
  }

  /** Lets every client go and gives up the socket and the lock with it. */
  async close(): Promise<void> {
    for (const c of this.clients) {
      c.end();
      setTimeout(() => c.destroy(), LINGER_MS).unref();
    }
    this.clients.clear();
    await new Promise<void>((resolve) => { this.server.close(() => resolve()); });
    this.unlock();
  }

  private join(socket: net.Socket): void {
    socket.on('error', () => { this.clients.delete(socket); socket.destroy(); });
    socket.on('close', () => this.clients.delete(socket));
    for (const line of this.lines) socket.write(`${line}\n`);
    this.clients.add(socket);
    readLines(socket, (line) => {
      const c = parseControl(line);
      if (c && this.clients.has(socket)) this.control?.(c, socket);
    });
  }
}

/** A client of a live helper: each line it sends, and a way to send it control lines. */
export async function connectHelper(socket: string, onLine: (line: string) => void): Promise<{ send(line: string): void; close(): void; closed: Promise<void> }> {
  const s = net.connect(socket);
  await new Promise<void>((resolve, reject) => {
    s.once('error', reject);
    s.once('connect', () => { s.off('error', reject); resolve(); });
  });
  const closed = new Promise<void>((resolve) => { s.on('close', () => resolve()); });
  s.on('error', () => s.destroy());
  readLines(s, onLine);
  return { send: (line) => { if (!s.destroyed) s.write(`${line}\n`); }, close: () => s.end(), closed };
}
