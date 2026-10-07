// A stand-in gateway carrying only the relay contract the spec needs: per-fleet secret and
// generation at the upgrade, a signed identity minted from the Tailscale header, and frames
// multiplexed by request id. Sockets are plain ws:// on loopback; in production tailscale serve
// terminates TLS in front of the gateway and the owner dials wss://.
import crypto from 'node:crypto';
import http from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocket, WebSocketServer } from 'ws';

export type Frame = { t: 'rpc' | 'res' | 'event' | 'term'; id: string; viewer?: string; identity?: Identity; sig?: string; [k: string]: unknown };
export type Identity = { fleet: string; login: string; name?: string; issuedAt: number };

export const OWNER_PATH = '/relay';
export const CLOSE_SUPERSEDED = 4410;
export const CLOSE_BAD_FRAME = 1008;
// four times the 1 MiB terminal burst the spec names: room for a header and backlog, nothing more
export const MAX_FRAME = 4 * 1024 * 1024;

/** A binary frame is a 4-byte header length, that many bytes of JSON header, then the payload. */
export function encodeBinary(header: Frame, payload: Buffer): Buffer {
  const json = Buffer.from(JSON.stringify(header));
  const len = Buffer.allocUnsafe(4);
  len.writeUInt32BE(json.length, 0);
  return Buffer.concat([len, json, payload]);
}

export function decodeBinary(frame: Buffer): { header: Frame; payload: Buffer } {
  if (frame.length < 4) throw new Error('binary frame is shorter than its header length');
  const n = frame.readUInt32BE(0);
  if (n === 0 || 4 + n > frame.length) throw new Error(`binary frame claims a ${n}-byte header it does not carry`);
  return { header: JSON.parse(frame.subarray(4, 4 + n).toString()) as Frame, payload: frame.subarray(4 + n) };
}

/** The frame a peer sent, or undefined when it is malformed and the socket should be closed. */
export function decodeFrame(data: Buffer, isBinary: boolean): { header: Frame; payload?: Buffer } | undefined {
  if (data.length > MAX_FRAME) return undefined;
  try {
    if (isBinary) return decodeBinary(data);
    const header = JSON.parse(data.toString()) as Frame;
    return header && typeof header === 'object' && typeof header.id === 'string' ? { header } : undefined;
  } catch {
    return undefined;
  }
}

export function signIdentity(key: Buffer, id: Identity): string {
  return crypto.createHmac('sha256', key).update(JSON.stringify(id)).digest('base64url');
}

export function verifyIdentity(key: Buffer, id: Identity, sig: string): boolean {
  const want = Buffer.from(signIdentity(key, id));
  const got = Buffer.from(sig);
  return want.length === got.length && crypto.timingSafeEqual(want, got);
}

function secretMatches(given: string, want: string): boolean {
  const a = crypto.createHash('sha256').update(given).digest();
  const b = crypto.createHash('sha256').update(want).digest();
  return crypto.timingSafeEqual(a, b);
}

const header = (req: http.IncomingMessage, name: string): string =>
  (typeof req.headers[name] === 'string' ? req.headers[name] : '') || '';

type Owner = { ws: WebSocket; machine: string; generation: number };

export type Gateway = {
  port: number;
  owner(fleet: string): { machine: string; generation: number } | undefined;
  close(): Promise<void>;
};

export function startGateway(o: { secrets: Record<string, string>; identityKey: Buffer }): Promise<Gateway> {
  const owners = new Map<string, Owner>();
  const viewers = new Map<string, { ws: WebSocket; fleet: string }>();
  const server = http.createServer((_req, res) => res.writeHead(404).end());
  const wss = new WebSocketServer({ noServer: true });

  const reject = (socket: Duplex, status: number, why: string): void => {
    socket.write(`HTTP/1.1 ${status} ${why}\r\nconnection: close\r\ncontent-length: 0\r\n\r\n`);
    socket.destroy();
  };

  function acceptOwner(req: http.IncomingMessage, socket: Duplex, head: Buffer): void {
    const fleet = header(req, 'x-svall-fleet');
    const secret = o.secrets[fleet];
    if (!secret || !secretMatches(header(req, 'x-svall-secret'), secret)) return reject(socket, 401, 'Unauthorized');
    const generation = Number(header(req, 'x-svall-generation'));
    if (!Number.isInteger(generation) || generation < 0) return reject(socket, 400, 'Bad Request');
    const held = owners.get(fleet);
    if (held && generation <= held.generation) return reject(socket, 409, 'Conflict');
    wss.handleUpgrade(req, socket, head, (ws) => {
      held?.ws.close(CLOSE_SUPERSEDED, 'superseded');
      const owner: Owner = { ws, machine: header(req, 'x-svall-machine'), generation };
      owners.set(fleet, owner);
      ws.on('close', () => { if (owners.get(fleet) === owner) owners.delete(fleet); });
      // an owner may only answer viewers of its own fleet, so naming another fleet's viewer id delivers nothing
      const target = (id: string | undefined): WebSocket | undefined => {
        const viewer = viewers.get(id ?? '');
        return viewer && viewer.fleet === fleet ? viewer.ws : undefined;
      };
      ws.on('message', (data: Buffer, isBinary: boolean) => {
        const frame = decodeFrame(data, isBinary);
        if (!frame) return void ws.close(CLOSE_BAD_FRAME, 'malformed frame');
        const to = target(frame.header.viewer);
        if (!to) return;
        if (frame.payload) to.send(encodeBinary(frame.header, frame.payload), { binary: true });
        else to.send(JSON.stringify(frame.header));
      });
    });
  }

  function acceptViewer(req: http.IncomingMessage, socket: Duplex, head: Buffer, fleet: string): void {
    const login = header(req, 'tailscale-user-login');
    if (!login) return reject(socket, 401, 'Unauthorized');
    const owner = owners.get(fleet);
    if (!owner) return reject(socket, 503, 'Service Unavailable');
    wss.handleUpgrade(req, socket, head, (ws) => {
      const viewerId = crypto.randomUUID();
      // the login the proxy vouched for is the only source of identity; a client-sent one never reaches here
      const identity: Identity = { fleet, login, name: header(req, 'tailscale-user-name') || undefined, issuedAt: Date.now() };
      const sig = signIdentity(o.identityKey, identity);
      viewers.set(viewerId, { ws, fleet });
      ws.on('close', () => viewers.delete(viewerId));
      ws.on('message', (data: Buffer, isBinary: boolean) => {
        const frame = decodeFrame(data, isBinary);
        if (!frame) return void ws.close(CLOSE_BAD_FRAME, 'malformed frame');
        const live = owners.get(fleet);
        if (!live) return;
        const vouched = { ...frame.header, viewer: viewerId, identity, sig };
        if (frame.payload) live.ws.send(encodeBinary(vouched, frame.payload), { binary: true });
        else live.ws.send(JSON.stringify(vouched));
      });
    });
  }

  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '/', 'http://gateway');
    if (url.pathname === OWNER_PATH) return acceptOwner(req, socket, head);
    const fleet = /^\/f\/([^/]+)\/socket$/.exec(url.pathname)?.[1];
    if (fleet) return acceptViewer(req, socket, head, decodeURIComponent(fleet));
    reject(socket, 404, 'Not Found');
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({
        port: (server.address() as { port: number }).port,
        owner: (fleet) => {
          const held = owners.get(fleet);
          return held && { machine: held.machine, generation: held.generation };
        },
        close: () => new Promise((done) => {
          for (const v of viewers.values()) v.ws.terminate();
          for (const held of owners.values()) held.ws.terminate();
          wss.close(() => server.close(() => done()));
        }),
      });
    });
  });
}
