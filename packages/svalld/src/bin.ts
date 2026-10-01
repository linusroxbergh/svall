import fs from 'node:fs';
import { NewerStateVersion, OlderStateVersion } from '@svall/protocol';
import { InvalidConfig } from './config.js';
import { createLogger } from './log.js';
import { OtherBuildHome, startDaemon, type Daemon } from './main.js';
import { svallHome, resolvePaths } from './paths.js';

const home = svallHome();
fs.mkdirSync(home, { recursive: true });
const paths = resolvePaths(home);
const log = createLogger(paths.log);

process.on('uncaughtException', (e) => log.error(`uncaught: ${e.stack ?? String(e)}`));
process.on('unhandledRejection', (e) => log.error(`unhandled: ${String(e)}`));

// run by hand, the terminal is where the reason is looked for; under launchd, stderr is the log itself
const report = (line: string, detail = line) => {
  log.error(detail);
  if (process.stderr.isTTY) process.stderr.write(`${line}\n`);
};

// changes whenever config.json or state.json is written, the two files a start can be refused for
const stamp = (): string => [paths.config, paths.state].map((file) => {
  try { const s = fs.statSync(file); return `${s.ino}:${s.size}:${s.mtimeMs}`; } catch { return '-'; }
}).join(' ');

// launchd would restart an exiting daemon every ten seconds, so one refused for its config.json or state.json waits for
// either to change. The stamp is taken before the start, so a fix written while it fails is not missed
async function start(): Promise<Daemon> {
  for (;;) {
    const before = stamp();
    try {
      return await startDaemon({ home, log });
    } catch (e) {
      // no file here can fix that; the other build's setup restarts the agent onto its own program
      if (e instanceof OtherBuildHome) {
        report(`${e.message}; svalld waits until that build's setup takes the fleet over`);
        await new Promise(() => setInterval(() => {}, 60_000));
      }
      if (!(e instanceof InvalidConfig || e instanceof NewerStateVersion || e instanceof OlderStateVersion)) throw e;
      report(`${e.message}; svalld starts once it is fixed`);
      while (stamp() === before) await new Promise((r) => setTimeout(r, 1000));
    }
  }
}

const daemon = await start().catch((e: Error) => {
  report(`svalld failed to start: ${e.message}`, `svalld failed to start: ${e.stack ?? String(e)}`);
  process.exit(1);
});
const shutdown = async (sig: string) => { log.info(`received ${sig}`); await daemon.stop(); process.exit(0); };
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
