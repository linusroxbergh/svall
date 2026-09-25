import fs from 'node:fs';
import { createLogger } from './log.js';
import { startDaemon } from './main.js';
import { archiHome, resolvePaths } from './paths.js';

const home = archiHome();
fs.mkdirSync(home, { recursive: true });
const log = createLogger(resolvePaths(home).log);

process.on('uncaughtException', (e) => log.error(`uncaught: ${e.stack ?? String(e)}`));
process.on('unhandledRejection', (e) => log.error(`unhandled: ${String(e)}`));

const daemon = await startDaemon({ home, log }).catch((e: Error) => {
  log.error(`archid failed to start: ${e.stack ?? String(e)}`);
  process.exit(1);
});
const shutdown = async (sig: string) => { log.info(`received ${sig}`); await daemon.stop(); process.exit(0); };
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
