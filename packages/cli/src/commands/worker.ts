import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { Writable } from 'node:stream';
import { Command } from 'commander';
import { z } from 'zod';
import { MachineRecord, WorkerFile } from '@svall/protocol';
import { VAR_NAME } from '@svall/svalld/claude';
import { initConfig, patchFleetConfig } from '@svall/svalld/config';
import { writeDurable } from '@svall/svalld/durable';
import { envValueFault, writeEnvVar } from '@svall/svalld/env-file';
import { loadFleetAgent, realFleetDeps } from '@svall/svalld/fleets';
import { kickstart } from '@svall/svalld/launchd';
import { realRun } from '@svall/svalld/linux/service';
import { serveAsWorker, svalldUnitName, unitDirOf } from '@svall/svalld/linux/setup';
import { machineId } from '@svall/svalld/machine';
import { isDialSocket, resolvePaths } from '@svall/svalld/paths';
import { PRIVATE, profileLabel } from '@svall/svalld/profile';
import { releaseVersion } from '@svall/svalld/release';
import { ownRuntime } from '@svall/svalld/runtime';
import { setupFleetHome } from '@svall/svalld/setup';
import { tokenFor } from '@svall/svalld/placement/workers';
import { fleetHomes } from '@svall/svalld/uninstall';
import { heldAsHome, isWorker, readWorkerFile } from '@svall/svalld/worker/mode';
import { DEFAULT_PREFIX } from '../../../../scripts/install-release.mjs';
import { Client } from '../client.js';
import { MachineRegistry } from '../controller/registry.js';
import type { Target } from '../target.js';
import { daemonRuns } from './setup.js';

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

async function readSecret(name: string): Promise<string> {
  if (process.stdin.isTTY !== true) return (await readAll(process.stdin)).replace(/\r?\n$/, '');
  const muted = new Writable({ write: (_c, _e, done) => done() });
  process.stderr.write(`value for ${name} (not shown): `);
  const rl = readline.createInterface({ input: process.stdin, output: muted, terminal: true });
  try {
    return await new Promise<string>((resolve) => { rl.once('line', resolve); rl.once('close', () => resolve('')); });
  } finally { rl.close(); process.stderr.write('\n'); }
}

/** `takesFleetId`: for a fleet joining its home, which goes by the home's id from its worker.json on. */
export type Enrol = { homeMachine: string; homeName: string; fleetId: string; homeProfile?: string; homeSsh?: string; homeSocket?: string; homeSvallBase?: string; homePlatform?: string; homeArch?: string; homePath?: string; takesFleetId?: true };
export type EnrolDeps = { platform: NodeJS.Platform; token: () => Promise<string>; daemonUp: (t: Target) => Promise<boolean>; out: (line: string) => void; me: () => string; load: (t: Target) => Promise<void> };

export const realEnrol: EnrolDeps = {
  platform: process.platform,
  token: async () => (await readAll(process.stdin)).trim(),
  daemonUp: (t) => daemonRuns(releaseVersion(), () => Client.connect(t.home)),
  out: (line) => { process.stdout.write(`${line}\n`); },
  me: () => machineId(),
  load: (t) => loadFleetAgent(t, realFleetDeps()),
};

const servedFleet = (paths: ReturnType<typeof resolvePaths>): WorkerFile | undefined => {
  try { return readWorkerFile(paths); } catch { return undefined; }
};

/** worker.json written for the home named, then the fleet's daemon restarted as its worker: by systemd on Linux, by launchd on a Mac. */
export async function enrollHere(t: Target, o: Enrol, d: EnrolDeps = realEnrol): Promise<void> {
  if ((o.homeSsh === undefined) !== (o.homeSocket === undefined)) throw new Error('worker.json not written: --home-ssh and --home-socket go together');
  if (o.homeSsh === undefined && (o.homeSvallBase !== undefined || o.homePlatform !== undefined || o.homeArch !== undefined || o.homePath !== undefined)) throw new Error('worker.json not written: --home-svall-base, --home-platform, --home-arch and --home-path are for a worker that dials its home');
  if (o.homeSsh !== undefined && (o.homeSvallBase === undefined || o.homePlatform === undefined || o.homeArch === undefined || o.homePath === undefined)) throw new Error('worker.json not written: a worker that dials its home takes --home-svall-base, --home-platform, --home-arch and --home-path, as svall fleet enroll-worker there names them');
  const dial = o.homeSsh === undefined ? {} : { homeSsh: o.homeSsh, homeSocket: o.homeSocket, homeSvallBase: o.homeSvallBase };
  const file = WorkerFile.safeParse({ homeMachineId: o.homeMachine, fleetId: o.fleetId, token: await d.token(), homeName: o.homeName, ...dial, ...(o.homeProfile && { homeProfile: o.homeProfile }) });
  if (!file.success) throw new Error(`worker.json not written: ${z.prettifyError(file.error)}`);
  const homeRecord = o.homeSsh === undefined ? undefined : MachineRecord.safeParse({ name: o.homeName, ssh: o.homeSsh, platform: o.homePlatform, arch: o.homeArch, home: o.homePath, svallBase: o.homeSvallBase });
  if (homeRecord && !homeRecord.success) throw new Error(`worker.json not written: ${z.prettifyError(homeRecord.error)}`);
  const paths = resolvePaths(t.home);
  // ssh reads a colon in a forward's socket as its separator
  if (o.homeSsh !== undefined && paths.linkSock.includes(':')) throw new Error(`worker.json not written: ${paths.linkSock} holds a colon, which ssh cannot forward to`);
  const me = d.me();
  if (o.homeSocket !== undefined && !isDialSocket(o.homeSocket, me)) throw new Error(`worker.json not written: ${o.homeSocket} is not this machine's socket; give the one svall fleet enroll-worker names for machine ${me}`);
  const enrolled = isWorker(paths) ? servedFleet(paths) : undefined;
  // the new home would close every robot here it does not know; a worker its home dials is that home's to enrol again, as host add does
  if (enrolled && enrolled.fleetId !== file.data.fleetId && (enrolled.homeSsh || file.data.homeSsh)) throw new Error(`worker.json not written: ${t.home} already serves ${enrolled.homeName} as a worker, whose robots here ${o.homeName} would close; enrol an empty fleet with svall -p <empty fleet> worker enroll`);
  const held = isWorker(paths) ? undefined : heldAsHome(paths, me);
  if (held) throw new Error(`worker.json not written: ${t.home} is a fleet's home and holds ${held}, which the first snapshot from ${o.homeName} would erase; enrol an empty fleet with svall -p <empty fleet> worker enroll`);
  if (d.platform === 'darwin' && t.managed) {
    // the per-user half, the hooks and the shims, is setup's alone
    if (t.name === PRIVATE && !fs.existsSync(t.home)) throw new Error('worker.json not written: no private fleet yet; run svall setup first');
    await d.load(t);
  }
  // a companion's systemd runs each fleet it serves, which may not have a home there yet
  const linux = d.platform === 'linux' && t.managed;
  if (linux) setupFleetHome({ home: t.home, port: t.name === PRIVATE ? undefined : 0 });
  // a file put back after a start as a home finds its epoch gone; an empty one says this is a worker, and its outbox mints a new one
  if (enrolled?.fleetId === file.data.fleetId && !fs.existsSync(paths.epoch)) {
    fs.mkdirSync(path.dirname(paths.epoch), { recursive: true });
    writeDurable(paths.epoch, Buffer.alloc(0));
  }
  // what `svall host upgrade` and `host doctor` of the home read: this fleet's own earlier record gives way to the new
  // route, while one another fleet here reaches the machine by, or wrote before this fleet came, keeps its name and route
  if (homeRecord?.data) {
    const machine = file.data.homeMachineId;
    try {
      const registry = MachineRegistry.load();
      const ours = enrolled?.homeMachineId === machine && !fleetHomes(os.homedir()).some((h) => h !== t.home && tokenFor(resolvePaths(h), machine));
      if (!registry.get(machine) || ours) {
        registry.put(machine, homeRecord.data);
        registry.save();
      }
    } catch (e) { throw new Error(`worker.json not written: ${(e as Error).message}`, { cause: e }); }
  }
  // named after worker.json, so what is refused or cut short before it leaves no home going by the fleet's id, and a retry finishes
  if (o.takesFleetId) fs.mkdirSync(paths.home, { recursive: true, mode: 0o700 });
  writeDurable(paths.workerFile, file.data, { mode: 0o600 });
  if (o.takesFleetId) {
    initConfig(paths);
    patchFleetConfig(paths.fleetConfig, { id: file.data.fleetId });
  }
  if (!t.managed || (d.platform !== 'linux' && d.platform !== 'darwin')) return;
  const done = linux
    ? await serveAsWorker({ runtime: ownRuntime(), homedir: os.homedir(), prefix: DEFAULT_PREFIX, unitDir: unitDirOf(os.homedir()), fleet: t.name, home: t.home, run: realRun })
    : await kickstart([profileLabel(t.name)]);
  for (const line of done) d.out(line);
  if (!await d.daemonUp(t)) {
    throw new Error(`${linux ? svalldUnitName(t.name) : profileLabel(t.name)} did not answer after its restart; svall doctor says why`);
  }
}

/** What the home runs on a worker it links to: the link itself, and the enrolment that names the home. */
export function workerCommands(target: () => Target): Command {
  const cmd = new Command('worker').description('this machine as a worker of a home\'s fleet');
  cmd.command('link').description('carry the home\'s link to this machine\'s svalld on stdin and stdout; the home runs it over ssh')
    .action(() => proxy(resolvePaths(target().home).linkSock));
  cmd.command('enroll').description('serve the fleet of the home named, with the token read from stdin; its daemon restarts as a worker')
    .requiredOption('--home-machine <id>', 'the home\'s machine id')
    .requiredOption('--home-name <name>', 'the home\'s name')
    .requiredOption('--fleet-id <id>', 'the fleet\'s id')
    .option('--home-ssh <destination>', 'the home this machine dials itself, which then needs no ssh to it')
    .option('--home-socket <path>', 'the socket on the home its link is forwarded to, as svall fleet enroll-worker there names it')
    .option('--home-svall-base <path>', 'where svall is installed on the home, as svall fleet enroll-worker there names it')
    .option('--home-platform <platform>', "the home's platform, as svall fleet enroll-worker there names it")
    .option('--home-arch <arch>', "the home's architecture, as svall fleet enroll-worker there names it")
    .option('--home-path <path>', "the home's user folder, as svall fleet enroll-worker there names it")
    .action((o: Enrol) => enrollHere(target(), o));
  cmd.command('env').description('set a variable for this fleet\'s robots on this machine, its value read from stdin')
    .argument('<VAR>', 'the variable\'s name')
    .action(async (name: string) => {
      if (!VAR_NAME.test(name)) throw new Error(`${name} is not a variable name`);
      const value = await readSecret(name);
      if (!value) throw new Error('no value given');
      const fault = envValueFault(value);
      if (fault) throw new Error(fault);
      writeEnvVar(resolvePaths(target().home).env, name, value);
      process.stdout.write(`${name} is set in this fleet's .env on this machine\n`);
    });
  return cmd;
}
