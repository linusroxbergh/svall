import fs from 'node:fs';
import type { WorkerFile } from '@svall/protocol';
import type { Logger } from '../log.js';
import type { Paths } from '../paths.js';
import { shq } from '../text.js';
import { readWorkerFile } from '../worker/mode.js';
import { HEARTBEAT_MS } from './home.js';
import { SshMaster } from './ssh.js';

const FIRST_RETRY_MS = 1_000;
const LAST_RETRY_MS = 60_000;
// a beat this late was held up by sleep, after which the master's connection is likely dead while its process still answers
const SLEPT_MS = 2 * HEARTBEAT_MS;

// $1 the socket on the home: its folder made for this account alone, and what an earlier tunnel left at the path removed,
// as sshd binds no path that is there
const CLEAR = 'umask 077 && mkdir -p "$(dirname "$1")" && rm -f -- "$1"';

/**
 * A worker's dial to its home: one ssh master to worker.json's `homeSsh`, carrying a forward of `homeSocket` there onto
 * this link.sock, which the home's link connects to. It keeps the tunnel up; the home's link keeps the stream.
 */
export class HomeDial {
  private held?: { master: SshMaster; cancel?: () => Promise<void> };
  private beat?: NodeJS.Timeout;
  private retry?: NodeJS.Timeout;
  private retryMs = FIRST_RETRY_MS;
  private lastWhy?: string;
  private last = Date.now();
  private stopped = false;
  private queued = false;
  private fresh = false;
  private running: Promise<void> = Promise.resolve();

  constructor(private o: { paths: Paths; log: Logger }) {}

  start(): void {
    this.beat = setInterval(() => this.tick(), HEARTBEAT_MS);
    this.dial();
  }

  /** The master the tunnel rides on, while it is up. */
  master(): SshMaster | undefined {
    return this.held?.master;
  }

  /** Makes the tunnel again: on the master while it answers, else, or with `fresh`, over a new one. */
  restore(fresh = false): void {
    this.dial(fresh);
  }

  /** Cancels the forward and closes the master. */
  async stop(): Promise<void> {
    this.halt();
    await this.running;
    await this.held?.cancel?.().catch(() => undefined);
    await this.drop();
  }

  private halt(): void {
    this.stopped = true;
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
    if (slept) return this.restore(true);
    const held = this.held;
    if (!held || this.retry || this.queued) return;
    void held.master.check().then((up) => { if (!up && this.held === held) this.restore(true); });
  }

  private async attempt(fresh: boolean): Promise<void> {
    clearTimeout(this.retry);
    this.retry = undefined;
    if (this.stopped) return;
    let worker: WorkerFile;
    // read at each dial: an enrolment since names the home, its destination and its socket afresh
    try {
      worker = readWorkerFile(this.o.paths);
    } catch (e) {
      if (fs.existsSync(this.o.paths.workerFile)) return this.lost((e as Error).message);
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
    try {
      if (fresh || this.held?.master.destination !== homeSsh || !(await this.held.master.check())) {
        await this.drop();
        this.held = { master: await SshMaster.open({ destination: homeSsh }) };
      } else {
        // the master answers a forward it holds already without binding it again, so the one it holds goes first
        await this.held.cancel?.();
        this.held.cancel = undefined;
      }
      const held = this.held;
      const r = await held.master.run(['sh', '-c', shq(CLEAR), 'svall-dial', shq(homeSocket)]);
      if (r.code !== 0) throw new Error(`${homeSocket} on ${worker.homeName} could not be cleared: ${r.stderr.trim() || `exit ${r.code ?? r.signal}`}`);
      held.cancel = (await held.master.reverseSocket(homeSocket, this.o.paths.linkSock)).cancel;
    } catch (e) {
      await this.drop();
      return this.lost((e as Error).message);
    }
    this.retryMs = FIRST_RETRY_MS;
    this.lastWhy = undefined;
    this.o.log.info(`dialed ${worker.homeName} at ${homeSsh}`);
  }

  private lost(why: string): void {
    if (this.stopped) return;
    if (why !== this.lastWhy) this.o.log.error(`the dial to the home failed: ${why}; trying again`);
    this.lastWhy = why;
    this.retry = setTimeout(() => this.dial(), this.retryMs);
    this.retryMs = Math.min(this.retryMs * 2, LAST_RETRY_MS);
  }

  private async drop(): Promise<void> {
    const held = this.held;
    this.held = undefined;
    await held?.master.close().catch((e: Error) => this.o.log.error(`the ssh master to the home did not close: ${e.message}`));
  }
}
