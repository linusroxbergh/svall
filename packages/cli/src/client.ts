import fs from 'node:fs';
import WebSocket from 'ws';
import { handshake } from '@svall/svalld/fleets';
import { svallHome, resolvePaths } from '@svall/svalld/paths';
import { SHIM, profileLabel } from '@svall/svalld/profile';
import { ApiError, serverWait, type Event, type MethodName, type Params, type Response, type Result } from '@svall/protocol';
import { resolveTarget, type Target } from './target.js';

// a wedged daemon must not hang the control loop, which shells out to svall and expects it to return.
const CALL_TIMEOUT = 30_000;
const CONNECT_TIMEOUT = 10_000;

/** How to restart a fleet's daemon: through its launchd agent, when it has one. */
export const restartHint = (t: Target): string => (t.managed
  ? `restart it with \`launchctl kickstart -k gui/$(id -u)/${profileLabel(t.name)}\``
  : `restart the svalld serving ${t.home}`);

/** The doctor that checks a fleet; an ad-hoc home is found again through the same $SVALL_HOME. */
const doctorHint = (t: Target): string => (t.managed ? `${SHIM} -p ${t.name} doctor` : `${SHIM} doctor`);

export class Client {
  private next = 1;
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();

  private constructor(private ws: WebSocket) {
    ws.on('message', (raw) => {
      let msg: Response | Event;
      try { msg = JSON.parse(raw.toString()) as Response | Event; } catch { return; }
      if ('event' in msg) return;
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      clearTimeout(p.timer);
      if ('error' in msg) p.reject(new ApiError(msg.error.code, msg.error.message));
      else p.resolve(msg.result);
    });
    const fail = () => {
      for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new Error('svalld connection closed')); }
      this.pending.clear();
    };
    ws.on('close', fail);
    ws.on('error', fail);
  }

  static async connect(home: string = svallHome()): Promise<Client> {
    const paths = resolvePaths(home);
    if (!fs.existsSync(paths.port) || !fs.existsSync(paths.token)) {
      throw new Error(`svalld is not running (no ${paths.port}): it runs while Svall is open on this fleet; \`${doctorHint(resolveTarget({ env: home }))}\` says more`);
    }
    return new Client(await handshake(home, CONNECT_TIMEOUT, restartHint(resolveTarget({ env: home }))));
  }

  call<M extends MethodName>(method: M, params: Params<M>): Promise<Result<M>> {
    // a socket that closed since drops what is sent on it without a word
    if (this.ws.readyState !== WebSocket.OPEN) return Promise.reject(new Error('svalld connection closed'));
    const id = this.next++;
    const ms = serverWait(method, params) + CALL_TIMEOUT;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`svalld did not answer ${method} within ${ms}ms`));
      }, ms);
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  close(): void {
    this.ws.close();
  }
}
