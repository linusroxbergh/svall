import fs from 'node:fs';
import WebSocket from 'ws';
import { loadConfig } from '@svall/svalld/config';
import { ProtocolMismatch } from '@svall/svalld/fleets';
import { svallHome, resolvePaths } from '@svall/svalld/paths';
import { SHIM, profileLabel } from '@svall/svalld/profile';
import { variant } from '@svall/svalld/runtime';
import { PROTOCOL_VERSION, serverWait, type Event, type MethodName, type Params, type Response, type Result } from '@svall/protocol';
import { resolveTarget, type Target } from './target.js';

// a wedged daemon must not hang the control loop, which shells out to svall and expects it to return.
const CALL_TIMEOUT = 30_000;
const CONNECT_TIMEOUT = 10_000;

class ApiError extends Error {
  constructor(public code: string, message: string) { super(message); }
}

export { ProtocolMismatch };

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
    const port = Number(fs.readFileSync(paths.port, 'utf8'));
    const token = fs.readFileSync(paths.token, 'utf8').trim();
    const host = loadConfig(paths.config).host;
    const ws = new WebSocket(`ws://${host}:${port}`);
    try {
      await deadline(new Promise<void>((resolve, reject) => {
        ws.once('open', () => resolve());
        ws.once('error', (e) => reject(new Error(`svalld not reachable on ${host}:${port}: ${e.message}`)));
      }), CONNECT_TIMEOUT, `svalld did not accept a connection on ${host}:${port} within ${CONNECT_TIMEOUT}ms`);
      ws.send(JSON.stringify({ token }));
      await deadline(new Promise<void>((resolve, reject) => {
        ws.once('message', (raw) => {
          let msg: { result?: { ok?: boolean; protocol?: number } };
          try { msg = JSON.parse(raw.toString()); } catch { msg = {}; }
          if (!msg.result?.ok) { reject(new Error('svalld rejected the token')); return; }
          const theirs = msg.result.protocol;
          if (theirs !== PROTOCOL_VERSION) {
            // a daemon from before the handshake carried a version sends none
            const speaks = theirs === undefined ? 'predates the protocol check' : `speaks protocol ${theirs}`;
            reject(new ProtocolMismatch(`the running svalld ${speaks} and this svall speaks ${PROTOCOL_VERSION}: ${variant === 'release' ? 'quit and reopen Svall' : 'run `pnpm desktop:install`'}, or ${restartHint(resolveTarget({ env: home }))}`));
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

  call<M extends MethodName>(method: M, params: Params<M>): Promise<Result<M>> {
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
