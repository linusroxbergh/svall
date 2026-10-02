import crypto from 'node:crypto';
import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import { WebSocketServer, type WebSocket } from 'ws';
import { Hello, LOGIN_REFUSED, PROTOCOL_VERSION, Request, type Event, type HelloReply } from '@svall/protocol';
import type { Fleet } from '../fleet.js';
import type { Fleets } from '../fleets.js';
import type { Logger } from '../log.js';
import type { Mobile } from '../mobile.js';
import type { Phones } from '../phones.js';
import type { PushStore } from '../push/store.js';
import type { CodexPaths } from '../codex/install.js';
import type { ClaudePaths } from '../paths.js';
import { mobileDist } from '../runtime.js';
import type { Store } from '../store.js';
import type { TerminalHub, Viewer } from '../terminals.js';
import type { FetchUsage } from '../usage/usage.js';
import type { Workspace } from '../workspace/workspace.js';
import { dispatch, type Ctx } from './methods.js';
import { serveBundle } from './static.js';

type Opts = {
  host: string; port: number; token: string;
  store: Store; fleet: Fleet; fleets: Fleets; terminals: TerminalHub; workspace: Workspace; usage: FetchUsage; mobileControl: Mobile; log: Logger;
  push: PushStore; vapidPublicKey: string; phones: Phones; claude: ClaudePaths; codex?: CodexPaths; docs?: string; agentProfiles?: string;
  origins?: string[]; logins?: () => string[]; dist?: string; key?: () => string; fleetName?: () => string | undefined; heartbeatMs?: number;
};

const MAX_PAYLOAD = 8 * 1024 * 1024;
const AUTH_TIMEOUT = 5000;
const HEARTBEAT_MS = 30_000;
// how often a refused phone may send the daemon to ask tailscale who owns this Mac
const LOOK_MS = 10_000;
// what a worker may do with one POST: answer the prompt a notification carried
const RPC_METHODS = new Set(['char.answer']);
const MAX_RPC_BODY = 64 * 1024;
// the packaged app and the Vite dev server
const APP_ORIGINS = new Set(['svall://app', 'http://localhost:5173', 'http://127.0.0.1:5173']);
// tailscale serve sets this on every request it proxies, and strips any the client sent itself
const IDENTITY_HEADER = 'tailscale-user-login';
const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);

function tokenMatches(given: string, token: string): boolean {
  const a = crypto.createHash('sha256').update(given).digest();
  const b = crypto.createHash('sha256').update(token).digest();
  return crypto.timingSafeEqual(a, b);
}

/** The url with the phone key the proxy prepends taken off, or undefined when its first segment is not the key. */
export function stripKey(url: string, key: string): string | undefined {
  const q = url.indexOf('?');
  const path = q === -1 ? url : url.slice(0, q);
  const end = path.indexOf('/', 1);
  const given = Buffer.from(path.slice(1, end === -1 ? undefined : end));
  const want = Buffer.from(key);
  if (given.length !== want.length || !crypto.timingSafeEqual(given, want)) return undefined;
  return (end === -1 ? '/' : path.slice(end)) + (q === -1 ? '' : url.slice(q));
}

/**
 * The page svalld served itself is allowed: on loopback, or on the tailnet name when the proxy brought the request.
 * Any other name could be a page whose own name was made to resolve to this Mac.
 */
export function originAllowed(req: IncomingMessage, extra: string[] = [], proxied = false): boolean {
  const origin = req.headers.origin;
  if (!origin) return true;
  if (APP_ORIGINS.has(origin) || extra.includes(origin)) return true;
  try { const u = new URL(origin); return u.host === req.headers.host && (proxied || LOOPBACK.has(u.hostname)); } catch { return false; }
}

/** The tailnet login the proxy vouches for, when the fleet accepts it. An empty list accepts no one. */
export function identityOf(req: IncomingMessage, logins: string[] = []): string | undefined {
  const login = req.headers[IDENTITY_HEADER];
  if (typeof login !== 'string' || !login) return undefined;
  return logins.includes(login) ? login : undefined;
}

export function startApi(opts: Opts): Promise<{ port: number; close(): Promise<void> }> {
  const { host, port, token, store, fleet, fleets, terminals, workspace, usage, mobileControl, log, push, vapidPublicKey, phones, claude, codex, docs, agentProfiles } = opts;
  const logins = opts.logins ?? (() => []);
  const origins = opts.origins ?? [];
  const dist = opts.dist ?? mobileDist;
  // a page can retry forever, so each origin or login is named once rather than once per attempt
  const refused = new Set<string>();
  // the desktop panel is the one surface that asks who is on the phone page, so the answer goes only there
  const desktops = new Set<Viewer>();
  // a phone socket came in by the key, and turning the link on or off turns the key over: each has to come in again
  const phoneSockets = new Set<WebSocket>();
  const mobile: Mobile = {
    get: () => mobileControl.get(),
    set: async (enabled) => {
      const status = await mobileControl.set(enabled);
      for (const ws of phoneSockets) ws.close(4401, 'phone link changed');
      return status;
    },
  };
  const base: Omit<Ctx, 'viewer' | 'signal'> = { store, fleet, fleets, terminals, workspace, usage, mobile, push, vapidPublicKey, claude, codex, docs, agentProfiles };
  const unwatchPhones = phones.onChange((list) => {
    for (const v of desktops) v.send({ event: 'mobile.phones', data: { phones: list } });
  });
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_PAYLOAD });
  // a phone that drops off the network sends no FIN: a socket that misses a whole beat without a pong is ended
  const answered = new WeakSet<WebSocket>();
  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (!answered.delete(ws)) { ws.terminate(); continue; }
      ws.ping();
    }
  }, opts.heartbeatMs ?? HEARTBEAT_MS);

  // Anything on the machine reaches the port, so a socket there says the token — unless its path opens
  // with the key only tailscaled was handed, which proves the login header came from the proxy.
  const behindKey = (req: IncomingMessage) => { const key = opts.key?.(); return key ? stripKey(req.url ?? '/', key) : undefined; };
  // a request through the key proves tailscale is up, so a refused one asks it again who owns this Mac: it may not have
  // answered when the daemon started, or the Mac may be signed in as someone else since
  let lookedAt = -Infinity;
  const phoneLogin = (req: IncomingMessage) => {
    const login = identityOf(req, logins());
    if (!login && Date.now() - lookedAt >= LOOK_MS) { lookedAt = Date.now(); void mobileControl.get().catch(() => {}); }
    return login;
  };

  const server = http.createServer((req, res) => {
    const stripped = behindKey(req);
    if (stripped) req.url = stripped;
    if (req.method === 'POST' && req.url === '/rpc') {
      // a client that drops mid-body rejects the read
      rpc(req, res, stripped ? phoneLogin(req) : undefined).catch((e: Error) => {
        log.error(`rpc: ${e.message}`);
        if (!res.headersSent) res.writeHead(400).end();
      });
      return;
    }
    serveBundle(req, res, dist, opts.fleetName?.());
  });

  // a worker answering a notification has no socket; it posts one call, vouched for the way a phone socket is
  async function rpc(req: IncomingMessage, res: ServerResponse, login: string | undefined): Promise<void> {
    if (!login) { res.writeHead(401).end(); return; }
    if (!originAllowed(req, origins, true)) { res.writeHead(403).end(); return; }
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req as AsyncIterable<Buffer>) {
      size += chunk.length;
      if (size > MAX_RPC_BODY) { res.writeHead(413).end(); return; }
      chunks.push(chunk);
    }
    let parsed: unknown;
    try { parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { res.writeHead(400).end(); return; }
    const r = Request.safeParse(parsed);
    if (!r.success || !RPC_METHODS.has(r.data.method)) { res.writeHead(400).end(); return; }
    const viewer: Viewer = { kind: 'phone', login, send: () => {}, backlog: () => 0 };
    const out = await dispatch(r.data, { ...base, viewer });
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' }).end(JSON.stringify(out));
  }
  server.on('upgrade', (req, socket, head) => {
    const proxied = behindKey(req) !== undefined;
    if (!originAllowed(req, origins, proxied)) {
      const origin = req.headers.origin ?? '';
      if (!refused.has(origin)) { refused.add(origin); log.error(`api: refused a socket from origin ${origin}`); }
      socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
      socket.destroy();
      return;
    }
    const login = proxied ? phoneLogin(req) : undefined;
    // a phone page holds no token, so one the proxy brought from a login the fleet does not take is told so at once
    if (proxied && !login) {
      const who = String(req.headers[IDENTITY_HEADER] ?? '');
      if (!refused.has(who)) { refused.add(who); log.error(`api: refused a phone socket from tailnet login ${who || '(none)'}`); }
      wss.handleUpgrade(req, socket, head, (ws: WebSocket) => { ws.on('error', () => {}); ws.close(LOGIN_REFUSED, 'tailnet login not accepted'); });
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws: WebSocket) => connect(ws, login));
  });

  function connect(ws: WebSocket, login?: string): void {
    answered.add(ws);
    ws.on('pong', () => answered.add(ws));
    let unsub: (() => void) | undefined;
    let left: (() => void) | undefined;
    const aborter = new AbortController();
    const viewer: Viewer = {
      kind: login ? 'phone' : 'app', login,
      send: (ev: Event) => { if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(ev)); },
      backlog: () => ws.bufferedAmount,
    };
    const admit = () => {
      unsub = store.subscribe((ops) => viewer.send({ event: 'state.patch', data: { ops } }));
      if (login) { left = phones.add(login); phoneSockets.add(ws); } else desktops.add(viewer);
      ws.send(JSON.stringify({ id: 0, result: { ok: true, protocol: PROTOCOL_VERSION } } satisfies HelloReply));
    };

    // the proxy has already proved who this is; a socket without that identity still has to say the token
    let authed = Boolean(login);
    const authTimer = authed ? undefined : setTimeout(() => ws.close(4401, 'unauthorized'), AUTH_TIMEOUT);
    if (login) { log.info('api: phone socket'); admit(); }

    ws.on('message', async (raw) => {
      let msg: unknown;
      try { msg = JSON.parse(raw.toString()); } catch { ws.close(4400, 'bad json'); return; }
      if (!authed) {
        const hello = Hello.safeParse(msg);
        if (!hello.success || !tokenMatches(hello.data.token, token)) { ws.close(4401, 'unauthorized'); return; }
        authed = true;
        clearTimeout(authTimer);
        admit();
        return;
      }
      const req = Request.safeParse(msg);
      if (!req.success) { ws.close(4400, 'bad request'); return; }
      const res = await dispatch(req.data, { ...base, viewer, signal: aborter.signal });
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(res));
    });

    ws.on('close', () => { clearTimeout(authTimer); aborter.abort(); unsub?.(); left?.(); desktops.delete(viewer); phoneSockets.delete(ws); terminals.closeAll(viewer); workspace.unwatchAll(viewer); });
    ws.on('error', (e) => log.error(`ws: ${String(e)}`));
  }

  return new Promise((resolve, reject) => {
    const failed = (e: Error) => { unwatchPhones(); clearInterval(heartbeat); reject(e); };
    server.once('error', failed);
    server.listen(port, host, () => {
      const addr = server.address();
      const bound = typeof addr === 'object' && addr ? addr.port : port;
      log.info(`api listening on ${host}:${bound}`);
      server.off('error', failed);
      server.on('error', (e) => log.error(`api: ${String(e)}`));
      resolve({
        port: bound,
        close: () => new Promise((r) => {
          unwatchPhones();
          clearInterval(heartbeat);
          for (const c of wss.clients) c.terminate();
          wss.close();
          server.closeAllConnections();
          server.close(() => r());
        }),
      });
    });
  });
}
