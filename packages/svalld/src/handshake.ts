import fs from 'node:fs';
import WebSocket from 'ws';
import { HelloReply, MAX_REQUEST_BYTES, PROTOCOL_VERSION } from '@svall/protocol/wire';
import { peekConfig } from './config.js';
import { resolvePaths } from './paths.js';
import { variant } from './runtime.js';

// the daemon and this build disagree on the protocol: waiting will not fix it
export class ProtocolMismatch extends Error {}

const deadline = <T>(p: Promise<T>, ms: number, message: string): Promise<T> => {
  let timer: NodeJS.Timeout;
  return Promise.race([
    p.finally(() => clearTimeout(timer)),
    new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(message)), ms); }),
  ]);
};

/** A socket to the daemon at `url` that took `token`; given `mismatch`, one that speaks another protocol is refused with what it says. */
export async function handshake({ url, token, timeoutMs, maxPayload = MAX_REQUEST_BYTES, mismatch, homeWord }: {
  url: string; token: string; timeoutMs: number; maxPayload?: number; mismatch?: (theirs: number) => string; homeWord?: string;
}): Promise<WebSocket> {
  const ws = new WebSocket(url, { maxPayload });
  try {
    await deadline(new Promise<void>((resolve, reject) => {
      ws.once('open', () => resolve());
      ws.once('error', (e) => reject(new Error(`Svall's background service is not reachable on ${url}: ${e.message}`)));
    }), timeoutMs, `Svall's background service did not accept a connection on ${url} within ${timeoutMs}ms`);
    ws.send(JSON.stringify({ token, home: homeWord }));
    await deadline(new Promise<void>((resolve, reject) => {
      ws.once('message', (raw) => {
        let msg: unknown;
        try { msg = JSON.parse(raw.toString()); } catch { msg = undefined; }
        const r = HelloReply.safeParse(msg);
        if (!r.success) reject(new Error("Svall's background service refused the token"));
        else if (mismatch && r.data.result.protocol !== PROTOCOL_VERSION) reject(new ProtocolMismatch(mismatch(r.data.result.protocol)));
        else resolve();
      });
      ws.once('close', (code) => reject(new Error(`Svall's background service closed the connection (${code})`)));
    }), timeoutMs, `Svall's background service did not answer the handshake within ${timeoutMs}ms`);
  } catch (e) {
    // a socket left open keeps a caller that handles the error from exiting
    ws.terminate();
    throw e;
  }
  return ws;
}

/** The daemon at `home`, once it takes its token and, unless `anyProtocol`, speaks this protocol; `restart` adds a way out of a mismatch. */
export function handshakeHome(home: string, timeoutMs: number, o: { anyProtocol?: boolean; restart?: string } = {}): Promise<WebSocket> {
  const paths = resolvePaths(home);
  const port = Number(fs.readFileSync(paths.port, 'utf8'));
  const fix = variant === 'release' ? 'quit and reopen Svall' : 'run `pnpm desktop:install`';
  // a run relayed to the home names it as the Mac that drives it does, and so do the daemon's words for its calls
  return handshake({
    url: `ws://${peekConfig(paths).host}:${port}`, token: fs.readFileSync(paths.token, 'utf8').trim(), timeoutMs, homeWord: process.env.SVALL_HOME_WORD,
    ...(!o.anyProtocol && {
      mismatch: (theirs: number) => `Svall's background service for ${home} speaks protocol ${theirs} and this build speaks ${PROTOCOL_VERSION}: ${fix}${o.restart ? `, or ${o.restart}` : ''}`,
    }),
  });
}
