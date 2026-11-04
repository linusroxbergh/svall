import fs from 'node:fs';
import path from 'node:path';
import { NewerStateVersion, OlderStateVersion } from '@svall/protocol';
import { InvalidConfig } from './config.js';
import { createLogger } from './log.js';
import { configDir, machineId, machineIdFailure } from './machine.js';
import { AlreadyRunning, OtherBuildHome, startDaemon, type Daemon } from './main.js';
import { svallHome, resolvePaths } from './paths.js';
import { heldAsHome, isWorker } from './worker/mode.js';

const home = svallHome();
fs.mkdirSync(home, { recursive: true });
const paths = resolvePaths(home);
const log = createLogger(paths.log);
// a Mac's launchd agent runs every fleet the same way, so worker.json alone makes it a worker, but for a fleet's home
const asWorker = (): true | undefined => {
  if (process.argv.includes('--worker')) return true;
  if (!isWorker(paths)) return undefined;
  // only a worker's outbox writes it, so what this holds is a worker's, even with no link yet
  if (fs.existsSync(paths.epoch)) return true;
  let me: string;
  try { me = machineId(); } catch (e) { throw new InvalidConfig(machineIdFailure(e), { cause: e }); }
  let held: string | undefined;
  try { held = heldAsHome(paths, me); } catch (e) { throw new InvalidConfig((e as Error).message, { cause: e }); }
  if (held) throw new InvalidConfig(`${paths.workerFile} makes this fleet home a worker, but it holds ${held} as a fleet's home, which the first snapshot would erase; remove the file, or enrol an empty fleet`);
  return true;
};

process.on('uncaughtException', (e) => log.error(`uncaught: ${e.stack ?? String(e)}`));
process.on('unhandledRejection', (e) => log.error(`unhandled: ${String(e)}`));

// run by hand, the terminal is where the reason is looked for; under launchd, stderr is the log itself
const report = (line: string, detail = line) => {
  log.error(detail);
  if (process.stderr.isTTY) process.stderr.write(`${line}\n`);
};

// changes whenever a config file or state.json is written, the files a start can be refused for
const stamp = (): string => [paths.fleetConfig, paths.nodeConfig, paths.legacyConfig, `${paths.legacyConfig}.bak`, paths.state, paths.workerFile, paths.workersFile, path.join(configDir(), 'machine.json')].map((file) => {
  try { const s = fs.statSync(file); return `${s.ino}:${s.size}:${s.mtimeMs}`; } catch { return '-'; }
}).join(' ');

// the app would start an exiting daemon again every ten seconds while its window is open, so one refused for its config
// or state.json waits for one of them to change. The stamp is taken before the start, so a fix written while it fails is not missed
async function start(): Promise<Daemon> {
  for (;;) {
    const before = stamp();
    try {
      return await startDaemon({ home, log, worker: asWorker() });
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
  // the log is the running daemon's, so a refused second one says why only where it was started
  if (e instanceof AlreadyRunning) process.stderr.write(`${e.message}\n`);
  else report(`svalld failed to start: ${e.message}`, `svalld failed to start: ${e.stack ?? String(e)}`);
  process.exit(1);
});
const shutdown = async (sig: string) => { log.info(`received ${sig}`); await daemon.stop(); process.exit(0); };
// the app quit and the fleet has stopped; launchd starts the daemon again only when the app asks
daemon.fleet.once('stopped', () => void shutdown('fleet.stop'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
