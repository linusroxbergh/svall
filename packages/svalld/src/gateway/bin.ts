import os from 'node:os';
import path from 'node:path';
import { createLogger, type Logger } from '../log.js';
import { startAuthorityServer, type AuthorityServer } from './server.js';

/** Where the gateway keeps its records on the machine it runs on. */
export const gatewayPrefix = (env: NodeJS.ProcessEnv = process.env): string =>
  env.SVALL_GATEWAY_PREFIX ?? path.join(os.homedir(), '.local', 'share', 'svall');

export const startGatewayFromEnv = (env: NodeJS.ProcessEnv = process.env, log: Logger = createLogger()): Promise<AuthorityServer> =>
  startAuthorityServer({ prefix: gatewayPrefix(env), log });

/** What a signal does: the socket goes before the process does, and a close that fails still ends it. */
export const shutdown = (server: Pick<AuthorityServer, 'close'>, exit: (code: number) => void, log: Logger) => (): void => {
  server.close().then(() => exit(0), (err: unknown) => {
    log.error(`gateway authority: the socket would not close: ${String(err)}`);
    exit(1);
  });
};

/** What the service unit runs: the socket, and a stop that closes it before the process goes. */
export async function main(log: Logger = createLogger()): Promise<AuthorityServer> {
  const server = await startGatewayFromEnv(process.env, log);
  const stop = shutdown(server, (code) => process.exit(code), log);
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
  return server;
}
