import fs from 'node:fs';
import net from 'node:net';
import type { OwnerRecord } from '@svall/protocol';
import type { DurableOptions } from '../handover/durable.js';
import { boundary } from '../handover/failpoints.js';
import { silentLogger, type Logger } from '../log.js';
import { FleetAuthority, OWNER_PARAMS, gatewayPaths, isOwnerOp, type AuthorityError } from './authority.js';

/** A request line the authority will not read past, however it is framed. */
export const MAX_LINE = 1024 * 1024;

export type AuthorityRequest = { id: number | string; op: string; params: unknown };
export type AuthorityResponse =
  | { id: number | string; result: { record: OwnerRecord } }
  | { id: number | string; error: { code: string; message: string; data?: Record<string, unknown> } };

export type AuthorityServer = {
  socketPath: string;
  /** What the server is bound to: the socket path, never a port. */
  address: string | net.AddressInfo | null;
  close(): Promise<void>;
};

export type AuthorityServerOptions = { prefix: string; log?: Logger; durable?: DurableOptions };

/** The authority as a local service: one JSON object per line, on a socket only this user can open. */
export async function startAuthorityServer({ prefix, log = silentLogger, durable }: AuthorityServerOptions): Promise<AuthorityServer> {
  const paths = gatewayPaths(prefix);
  fs.mkdirSync(paths.dir, { recursive: true, mode: 0o700 });
  await clearStaleSocket(paths.socket);

  const authority = new FleetAuthority(prefix, durable ? { durable } : {});
  const open = new Set<net.Socket>();
  const server = net.createServer((socket) => {
    open.add(socket);
    socket.on('close', () => open.delete(socket));
    socket.on('error', () => socket.destroy());
    serveConnection(socket, authority, log);
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(paths.socket, () => {
      server.off('error', reject);
      resolve();
    });
  });
  fs.chmodSync(paths.socket, 0o600);
  server.on('error', (err) => log.error(`gateway authority: ${String(err)}`));
  log.info(`gateway authority listening on ${paths.socket}`);

  return {
    socketPath: paths.socket,
    address: server.address(),
    close: () => new Promise<void>((resolve) => {
      for (const socket of open) socket.destroy();
      server.close(() => resolve());
    }),
  };
}

function serveConnection(socket: net.Socket, authority: FleetAuthority, log: Logger): void {
  let buffer = '';
  // the replies on one connection keep the order its requests arrived in
  let queue: Promise<void> = Promise.resolve();
  socket.setEncoding('utf8');
  socket.on('data', (chunk: string) => {
    buffer += chunk;
    for (let nl = buffer.indexOf('\n'); nl >= 0; nl = buffer.indexOf('\n')) {
      const line = buffer.slice(0, nl);
      buffer = buffer.slice(nl + 1);
      const request = parseRequest(line);
      if (!request) {
        log.error('gateway authority: closing a connection that sent a line it could not answer');
        socket.destroy();
        return;
      }
      queue = queue.then(async () => {
        const response = await answer(authority, request, log);
        const send = () => { if (!socket.destroyed) socket.write(`${JSON.stringify(response)}\n`); };
        if (request.op === 'owner.commit') boundary('gateway.commit.respond', send);
        else send();
      }).catch((err: unknown) => log.error(`gateway authority: request ${request.id} was not answered: ${String(err)}`));
    }
    if (buffer.length > MAX_LINE) {
      log.error(`gateway authority: closing a connection that sent more than ${MAX_LINE} bytes without a newline`);
      socket.destroy();
    }
  });
}

// a line whose reply could not be addressed is the only one that costs the connection
function parseRequest(line: string): AuthorityRequest | undefined {
  if (line.length > MAX_LINE) return undefined;
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (!raw || typeof raw !== 'object') return undefined;
  const { id, op, params } = raw as Record<string, unknown>;
  if (typeof id !== 'number' && typeof id !== 'string') return undefined;
  return { id, op: typeof op === 'string' ? op : '', params };
}

async function answer(authority: FleetAuthority, request: AuthorityRequest, log: Logger): Promise<AuthorityResponse> {
  const refuse = (error: AuthorityError): AuthorityResponse => ({ id: request.id, error });
  if (!isOwnerOp(request.op)) return refuse({ code: 'invalid_request', message: `unknown operation ${request.op}` });
  const params = OWNER_PARAMS[request.op].safeParse(request.params);
  if (!params.success) return refuse({ code: 'invalid_request', message: `${request.op}: ${params.error.issues.map((i) => `${i.path.join('.')} ${i.message}`).join('; ')}` });
  try {
    const result = await authority.apply(request.op, params.data);
    return 'error' in result ? refuse(result.error) : { id: request.id, result: { record: result.record } };
  } catch (err) {
    log.error(`gateway authority: ${request.op} did not complete: ${String(err)}`);
    return refuse({ code: 'internal', message: String(err) });
  }
}

// a socket file no listener answers is what a killed gateway leaves behind; a live one is not ours to take
async function clearStaleSocket(socketPath: string): Promise<void> {
  if (!fs.existsSync(socketPath)) return;
  const live = await new Promise<boolean>((resolve) => {
    const probe = net.connect(socketPath);
    const settle = (answer: boolean) => {
      probe.destroy();
      resolve(answer);
    };
    probe.once('connect', () => settle(true));
    probe.once('error', () => settle(false));
  });
  if (live) throw new Error(`a gateway authority is already listening on ${socketPath}`);
  fs.rmSync(socketPath, { force: true });
}
