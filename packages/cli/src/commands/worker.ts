import net from 'node:net';
import os from 'node:os';
import { Command } from 'commander';
import { z } from 'zod';
import { WorkerFile } from '@svall/protocol';
import { writeDurable } from '@svall/svalld/handover/durable';
import { realRun } from '@svall/svalld/linux/service';
import { serveAsWorker, svalldUnitName, unitDirOf } from '@svall/svalld/linux/setup';
import { resolvePaths } from '@svall/svalld/paths';
import { PRIVATE } from '@svall/svalld/profile';
import { releaseVersion } from '@svall/svalld/release';
import { ownRuntime } from '@svall/svalld/runtime';
import { setupFleetHome } from '@svall/svalld/setup';
import { DEFAULT_PREFIX } from '../../../../scripts/install-release.mjs';
import { Client } from '../client.js';
import type { Target } from '../target.js';
import { daemonRuns } from './setup.js';

// stdin to link.sock and the socket back to stdout, until either side ends
function proxy(sock: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(sock);
    socket.once('error', (e) => reject(new Error(`${sock}: ${e.message}`)));
    socket.once('connect', () => {
      process.stdin.pipe(socket);
      socket.pipe(process.stdout);
      socket.once('close', () => {
        process.stdin.unpipe(socket);
        process.stdin.destroy();
        resolve();
      });
    });
  });
}

async function readAll(input: NodeJS.ReadableStream): Promise<string> {
  let text = '';
  for await (const chunk of input) text += String(chunk);
  return text;
}

/** What the home runs on a worker it links to: the link itself, and the enrolment that names the home. */
export function workerCommands(target: () => Target): Command {
  const cmd = new Command('worker').description('this machine as a worker of a home\'s fleet');
  cmd.command('link').description('carry the home\'s link to this machine\'s svalld on stdin and stdout; the home runs it over ssh')
    .action(() => proxy(resolvePaths(target().home).linkSock));
  cmd.command('enroll').description('serve the fleet of the home named, with the token read from stdin; on Linux its daemon restarts as a worker')
    .requiredOption('--home-machine <id>', 'the home\'s machine id')
    .requiredOption('--home-name <name>', 'the home\'s name')
    .requiredOption('--fleet-id <id>', 'the fleet\'s id')
    .action(async (o: { homeMachine: string; homeName: string; fleetId: string }) => {
      const t = target();
      const file = WorkerFile.safeParse({ homeMachineId: o.homeMachine, fleetId: o.fleetId, token: (await readAll(process.stdin)).trim(), homeName: o.homeName });
      if (!file.success) throw new Error(`worker.json not written: ${z.prettifyError(file.error)}`);
      // a companion's systemd runs each fleet it serves, which may not have a home there yet
      const linux = process.platform === 'linux' && t.managed;
      if (linux) setupFleetHome({ home: t.home, port: t.name === PRIVATE ? undefined : 0 });
      writeDurable(resolvePaths(t.home).workerFile, file.data, { mode: 0o600 });
      if (!linux) return;
      const done = await serveAsWorker({ runtime: ownRuntime(), homedir: os.homedir(), prefix: DEFAULT_PREFIX, unitDir: unitDirOf(os.homedir()), fleet: t.name, home: t.home, run: realRun });
      for (const line of done) process.stdout.write(`${line}\n`);
      if (!await daemonRuns(releaseVersion(), () => Client.connect(t.home))) {
        throw new Error(`${svalldUnitName(t.name)} did not answer after its restart; svall doctor says why`);
      }
    });
  return cmd;
}
