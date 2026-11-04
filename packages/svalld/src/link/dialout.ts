import fs from 'node:fs';
import type { WorkerFile } from '@svall/protocol';
import type { Logger } from '../log.js';
import { isDialSocket, type Paths } from '../paths.js';
import { shq } from '../text.js';
import { readWorkerFile } from '../worker/mode.js';
import { HEARTBEAT_MS } from './home.js';
import { SshError, SshMaster } from './ssh.js';

const FIRST_RETRY_MS = 1_000;
const LAST_RETRY_MS = 60_000;
// a beat this late was held up by sleep, after which the master's connection is likely dead while its process still answers
const SLEPT_MS = 2 * HEARTBEAT_MS;

// $1 the socket on the home: its folder made for this account alone, and the socket an earlier tunnel left at the path
// removed, as sshd binds no path that is there; anything else there stays
const CLEAR = 'umask 077 && mkdir -p "$(dirname "$1")" && { [ ! -e "$1" ] || [ -S "$1" ] || { echo "$1 is not a socket" >&2; exit 1; }; } && rm -f -- "$1"';

type Tunnel = { socket: string; cancel: (signal?: AbortSignal) => Promise<void> };
type Held = { master: SshMaster; tunnel?: Tunnel };

/**
 * A worker's dial to its home: one ssh master to worker.json's `homeSsh`, carrying a forward of `homeSocket` there onto
 * this link.sock, which the home's link connects to. It keeps the tunnel up; the home's link keeps the stream.
 */
export class HomeDial {
  private held?: Held;
  private beat?: NodeJS.Timeout;
  private retry?: NodeJS.Timeout;
  private retryMs = FIRST_RETRY_MS;
  private lastWhy?: string;
  private failed?: SshError;
  private last = 0;
  private stopped = false;
  private readonly abort = new AbortController();
  private queued = false;
  private fresh = false;
  private running: Promise<void> = Promise.resolve();

  /** `linked`: whether the home's link over this tunnel is up. */
  constructor(private o: { paths: Paths; log: Logger; me: string; linked: () => boolean }) {}

  start(): void {
    this.last = Date.now();
    this.beat = setInterval(() => this.tick(), HEARTBEAT_MS);
    this.dial();
  }

  /** The master the tunnel rides on, while it is up. */
  master(): SshMaster | undefined {
    return this.held?.master;
  }

  /** Why the last dial failed, while no dial has gone through since. */
  failure(): SshError | undefined {
    return this.failed;
  }

  /** Makes the tunnel again: on the master while it answers, else, or with `fresh`, over a new one. */
  restore(fresh = false): void {
    this.failed = undefined;
    this.dial(fresh);
  }

  /** Looks at the tunnel now, as each beat does: a link lost over a healthy one needs no new bind. */
  check(): void {
    const { held } = this;
    if (!held?.tunnel || this.retry || this.queued) return;
    this.verify(held, held.tunnel).catch((e: Error) => this.o.log.error(`the tunnel to the home was not checked: ${e.message}`));
  }

  /** Cancels the forward and closes the master. */
  async stop(): Promise<void> {
    this.halt();
    await this.running;
    await this.held?.tunnel?.cancel().catch(() => undefined);
    await this.drop();
  }

  private halt(): void {
    this.stopped = true;
    this.abort.abort();
    clearInterval(this.beat);
    clearTimeout(this.retry);
  }

  private dial(fresh = false): void {
    if (this.stopped) return;
    this.fresh ||= fresh;
    if (this.queued) return;
    this.queued = true;
    this.running = this.running.then(() => {
      this.queued = false;
      const f = this.fresh;
      this.fresh = false;
      return this.attempt(f);
    });
  }

  private tick(): void {
    const now = Date.now();
    const slept = now - this.last > SLEPT_MS;
    this.last = now;
    if (!fs.existsSync(this.o.paths.workerFile)) {
      this.o.log.info(`${this.o.paths.workerFile} is gone, so this machine dials no home`);
      void this.stop();
      return;
    }
    if (slept) {
      if (!this.waits()) this.restore(true);
      return;
    }
    this.check();
  }

  // only a link that was live says it closed, so a socket gone before one came up is seen here or never
  private async verify(held: Held, tunnel: Tunnel): Promise<void> {
    const current = () => this.held === held && held.tunnel === tunnel;
    const { signal } = this.abort;
    if (!await held.master.check(signal)) {
      if (current()) this.restore(true);
      return;
    }
    if (this.o.linked() || !current()) return;
    const r = await held.master.run(['test', '-S', shq(tunnel.socket)], { signal });
    // 255 is ssh's own failure, which the next beat's check tells
    if (r.code === 1 && current() && !this.o.linked()) this.restore();
  }

  private async attempt(fresh: boolean): Promise<void> {
    clearTimeout(this.retry);
    this.retry = undefined;
    if (this.stopped) return;
    let worker: WorkerFile;
    // read at each dial for where to dial; the token the link compares is held from this daemon's start
    try {
      worker = readWorkerFile(this.o.paths);
    } catch (e) {
      if (fs.existsSync(this.o.paths.workerFile)) {
        this.failed = new SshError('other', (e as Error).message);
        return this.lost((e as Error).message);
      }
      this.o.log.info(`${this.o.paths.workerFile} is gone, so this machine dials no home`);
      this.halt();
      return this.drop();
    }
    const { homeSsh, homeSocket } = worker;
    if (!homeSsh || !homeSocket) {
      this.o.log.info(`${this.o.paths.workerFile} names no home to dial`);
      this.halt();
      return this.drop();
    }
    const { signal } = this.abort;
    try {
      if (!isDialSocket(homeSocket, this.o.me)) throw new Error(`${homeSocket} is not this machine's socket on ${worker.homeName}`);
      if (fresh || this.held?.master.destination !== homeSsh || !(await this.held.master.check(signal))) {
        await this.drop();
        this.held = { master: await SshMaster.open({ destination: homeSsh, signal }) };
      } else {
        // the master answers a forward it holds already without binding it again, so the one it holds goes first
        await this.held.tunnel?.cancel(signal);
        this.held.tunnel = undefined;
      }
      const held = this.held;
      const r = await held.master.run(['sh', '-c', shq(CLEAR), 'svall-dial', shq(homeSocket)], { signal });
      if (r.code !== 0) throw new Error(`${homeSocket} on ${worker.homeName} could not be cleared: ${r.stderr.trim() || `exit ${r.code ?? r.signal}`}`);
      const { cancel } = await held.master.reverseSocket(homeSocket, this.o.paths.linkSock, signal);
      held.tunnel = { socket: homeSocket, cancel };
    } catch (e) {
      await this.drop();
      this.failed = e instanceof SshError ? e : new SshError('other', (e as Error).message);
      return this.lost((e as Error).message);
    }
    this.failed = undefined;
    this.retryMs = FIRST_RETRY_MS;
    this.lastWhy = undefined;
    this.o.log.info(`dialed ${worker.homeName} at ${homeSsh}`);
  }

  // a key or a host key waits for a person, and a login refused every minute can get the account banned
  private waits(): boolean {
    return this.failed?.kind === 'auth' || this.failed?.kind === 'host_key';
  }

  private lost(why: string): void {
    if (this.stopped) return;
    const waits = this.waits();
    if (why !== this.lastWhy) this.o.log.error(`the dial to the home failed: ${why}${waits ? '' : '; trying again'}`);
    this.lastWhy = why;
    if (waits) return;
    this.retry = setTimeout(() => this.dial(), this.retryMs);
    this.retryMs = Math.min(this.retryMs * 2, LAST_RETRY_MS);
  }

  private async drop(): Promise<void> {
    const held = this.held;
    this.held = undefined;
    await held?.master.close().catch((e: Error) => this.o.log.error(`the ssh master to the home did not close: ${e.message}`));
  }
}
