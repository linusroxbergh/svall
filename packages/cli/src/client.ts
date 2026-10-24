import fs from 'node:fs';
import WebSocket from 'ws';
import { handshake, handshakeHome, ProtocolMismatch } from '@svall/svalld/fleets';
import { svallHome, resolvePaths } from '@svall/svalld/paths';
import { SHIM, profileLabel } from '@svall/svalld/profile';
import { ApiError, PART_BYTES, serverWait, type Event, type MethodName, type Params, type Response, type Result } from '@svall/protocol';
import { resolveTarget, type Target } from './target.js';

// a wedged daemon must not hang the control loop, which shells out to svall and expects it to return.
const CALL_TIMEOUT = 30_000;
const CONNECT_TIMEOUT = 10_000;

export { ApiError, ProtocolMismatch };

/** How to restart a fleet's daemon: through its launchd agent, when it has one. */
export const restartHint = (t: Target): string => (t.managed
  ? `restart it with \`launchctl kickstart -k gui/$(id -u)/${profileLabel(t.name)}\``
  : `restart the svalld serving ${t.home}`);

/** The doctor that checks a fleet; an ad-hoc home is found again through the same $SVALL_HOME. */
const doctorHint = (t: Target): string => (t.managed ? `${SHIM} -p ${t.name} doctor` : `${SHIM} doctor`);

export class Client {
  private next = 1;
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
  private listeners = new Set<(e: Event) => void>();
  /** the machine this client reached another machine's daemon on, when it is not this one's */
  via?: string;

  private constructor(private ws: WebSocket) {
    ws.on('message', (raw) => {
      let msg: Response | Event;
      try { msg = JSON.parse(raw.toString()) as Response | Event; } catch { return; }
      if ('event' in msg) {
        for (const fn of this.listeners) fn(msg);
        return;
      }
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      clearTimeout(p.timer);
      if ('error' in msg) p.reject(new ApiError(msg.error.code, msg.error.message, msg.error.data));
      else p.resolve(msg.result);
    });
    const fail = (err: Error) => {
      for (const p of this.pending.values()) {
        clearTimeout(p.timer);
        p.reject(err);
      }
      this.pending.clear();
    };
    // a request larger than svalld reads, or an answer larger than this client reads, is an answer too large to ask for again
    ws.on('close', (code, reason) => fail(code === 1009
      ? new ApiError('too_large', `svalld closed the connection on a request larger than it reads (${reason.toString() || code})`)
      : new Error('svalld connection closed')));
    ws.on('error', (e) => fail((e as { code?: string }).code === 'WS_ERR_UNSUPPORTED_MESSAGE_LENGTH'
      ? new ApiError('too_large', `svalld answered with more than this client reads: ${e.message}`)
      : new Error('svalld connection closed')));
  }

  /** `anyProtocol`: takes a daemon on another protocol too, for a caller that asks it only what every release answers. */
  static async connect(home: string = svallHome(), { anyProtocol = false } = {}): Promise<Client> {
    const paths = resolvePaths(home);
    if (!fs.existsSync(paths.port) || !fs.existsSync(paths.token)) {
      throw new Error(`svalld is not running (no ${paths.port}): it runs while Svall is open on this fleet; \`${doctorHint(resolveTarget({ env: home }))}\` says more`);
    }
    return new Client(await handshakeHome(home, CONNECT_TIMEOUT, { anyProtocol, restart: restartHint(resolveTarget({ env: home })) }));
  }

  /** A daemon at an endpoint this process was handed: the one here, or the near end of a tunnel. */
  static async connectEndpoint(o: { url: string; token: string; maxPayload?: number }): Promise<Client> {
    return new Client(await handshake({ ...o, timeoutMs: CONNECT_TIMEOUT }));
  }

  /** Whether the socket has closed or is closing, so that nothing sent on it is answered. */
  get closed(): boolean {
    return this.ws.readyState !== WebSocket.OPEN;
  }

  call<M extends MethodName>(method: M, params: Params<M>): Promise<Result<M>> {
    // ws drops a send on a closed socket without a word, so the call fails here as one cut off in flight does
    if (this.closed) return Promise.reject(new Error('svalld connection closed'));
    const id = this.next++;
    const ms = serverWait(method, params) + CALL_TIMEOUT;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`svalld did not answer ${method} within ${ms}ms`));
      }, ms);
      // the socket holds the process while the call can still be answered; the wait alone does not
      timer.unref();
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
      this.send(id, JSON.stringify({ id, method, params }));
    });
  }

  // a request larger than one part goes as its parts, in order, which the daemon joins before it answers
  private send(id: number, frame: string): void {
    const bytes = Buffer.from(frame);
    if (bytes.length <= PART_BYTES) { this.ws.send(frame); return; }
    const count = Math.ceil(bytes.length / PART_BYTES);
    for (let index = 0; index < count; index++) {
      const data = bytes.subarray(index * PART_BYTES, (index + 1) * PART_BYTES).toString('base64');
      this.ws.send(JSON.stringify({ part: { id, index, count, data } }));
    }
  }

  close(): void {
    this.ws.close();
  }

  /** Hands each event the daemon pushes to `fn`, until the returned function is called. */
  onEvent(fn: (e: Event) => void): () => void {
    this.listeners.add(fn);
    return () => { this.listeners.delete(fn); };
  }

  /** Runs once the connection is gone, whichever side closed it. */
  onClose(fn: () => void): void {
    this.ws.once('close', fn);
  }
}
