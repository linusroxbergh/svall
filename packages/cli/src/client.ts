import fs from 'node:fs';
import WebSocket from 'ws';
import { peekConfig } from '@svall/svalld/config';
import { ProtocolMismatch } from '@svall/svalld/fleets';
import { svallHome, resolvePaths } from '@svall/svalld/paths';
import { SHIM, profileLabel } from '@svall/svalld/profile';
import { variant } from '@svall/svalld/runtime';
import { ApiError, MAX_REQUEST_BYTES, PART_BYTES, PROTOCOL_VERSION, serverWait, type Event, type MethodName, type Params, type Response, type Result } from '@svall/protocol';
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

const deadline = <T>(p: Promise<T>, ms: number, message: string): Promise<T> => {
  let timer: NodeJS.Timeout;
  return Promise.race([
    p.finally(() => clearTimeout(timer)),
    new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(message)), ms); }),
  ]);
};

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
    const port = Number(fs.readFileSync(paths.port, 'utf8'));
    return Client.connectEndpoint({
      url: `ws://${peekConfig(paths).host}:${port}`, token: fs.readFileSync(paths.token, 'utf8').trim(),
      ...(!anyProtocol && { mismatch: (speaks: string) => {
        const fix = variant === 'release' ? 'quit and reopen Svall' : 'run `pnpm desktop:install`';
        return `the svalld of ${home} ${speaks} and this build speaks ${PROTOCOL_VERSION}: ${fix}, or ${restartHint(resolveTarget({ env: home }))}`;
      } }),
    });
  }

  /**
   * A daemon at an endpoint this process was handed: the one here, or the near end of a tunnel. Given
   * `mismatch`, one that speaks another protocol is refused with what it says.
   */
  static async connectEndpoint({ url, token, maxPayload = MAX_REQUEST_BYTES, mismatch }: { url: string; token: string; maxPayload?: number; mismatch?: (speaks: string) => string }): Promise<Client> {
    const ws = new WebSocket(url, { maxPayload });
    try {
      await deadline(new Promise<void>((resolve, reject) => {
        ws.once('open', () => resolve());
        ws.once('error', (e) => reject(new Error(`svalld not reachable on ${url}: ${e.message}`)));
      }), CONNECT_TIMEOUT, `svalld did not accept a connection on ${url} within ${CONNECT_TIMEOUT}ms`);
      ws.send(JSON.stringify({ token }));
      await deadline(new Promise<void>((resolve, reject) => {
        ws.once('message', (raw) => {
          let msg: { result?: { ok?: boolean; protocol?: number } };
          try { msg = JSON.parse(raw.toString()); } catch { msg = {}; }
          if (!msg.result?.ok) { reject(new Error('svalld refused the token')); return; }
          const theirs = msg.result.protocol;
          if (mismatch && theirs !== PROTOCOL_VERSION) {
            // a daemon from before the handshake carried a version sends none
            reject(new ProtocolMismatch(mismatch(theirs === undefined ? 'predates the protocol check' : `speaks protocol ${theirs}`)));
            return;
          }
          resolve();
        });
        ws.once('close', (code) => reject(new Error(`svalld closed the connection (${code})`)));
      }), CONNECT_TIMEOUT, `svalld did not answer the handshake within ${CONNECT_TIMEOUT}ms`);
    } catch (err) {
      // a socket left open keeps a caller that handles the error from exiting
      ws.terminate();
      throw err;
    }
    return new Client(ws);
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
