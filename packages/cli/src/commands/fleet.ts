import os from 'node:os';
import { Command } from 'commander';
import { z } from 'zod';
import { Enrolment, FleetId, HomeManifest, HomeMoveId, MachineId, MachineRecord, type AdoptAnswer, type FleetState } from '@svall/protocol';
import { readFleetConfig } from '@svall/svalld/config';
import { homeFacts } from '@svall/svalld/fleet/home-freeze';
import { abortAdopt, adoptStatus, installAdopt, packFleet, settleMove, stageAdopt, type AdoptDeps } from '@svall/svalld/fleet/home-move';
import { dialSocket, dialSocketTooLong, resolvePaths } from '@svall/svalld/paths';
import { issueToken, tokenFor } from '@svall/svalld/placement/workers';
import { fleetHomes } from '@svall/svalld/uninstall';
import { installPrefix } from '@svall/svalld/release';
import { machineId } from '@svall/svalld/machine';
import { realDeps as realMobileDeps, resolveTailscale, tailnetSelf } from '@svall/svalld/mobile';
import { isWorker } from '@svall/svalld/worker/mode';
import { Client } from '../client.js';
import { connectForwarded } from '../controller/connection.js';
import { abortBack, enrolmentFor, joinHome, moveHomeBack, moveHomeOut, realHomeDaemon, resumeHome, type MoveDeps } from '../controller/home.js';
import type { HostOutcome, StepEvent } from '../controller/host.js';
import { MachineRegistry } from '../controller/registry.js';
import { SshMaster } from '../controller/ssh.js';
import { printResult } from '../format.js';
import type { Target } from '../target.js';
import { interactiveSsh, stepLine } from './host.js';
import { enrollHere, realEnrol } from './worker.js';

export async function withClient<T>(connect: () => Promise<Client>, f: (c: Client) => Promise<T>): Promise<T> {
  const c = await connect();
  try { return await f(c); } finally { c.close(); }
}

export const withFleet = <T>(connect: () => Promise<Client>, f: (c: Client, state: FleetState) => Promise<T>): Promise<T> =>
  withClient(connect, async (c) => f(c, await c.call('state.get', {})));

type Facts = { name: string; platform: string; arch: string; home: string; svallBase: string };

/**
 * A worker that dials this home: its record in this machine's registry, which the home links by, and a new token, the
 * newest of which the home holds. Answers what that worker's `svall worker enroll` takes, the token only as JSON.
 */
async function enrollWorker(t: Target, id: string, o: Facts): Promise<{ homeMachineId: MachineId; homeName: string; fleetId: string; socket: string; token: string; homeSvallBase: string; homePlatform: string; homeArch: string; homePath: string }> {
  const paths = resolvePaths(t.home);
  if (isWorker(paths)) throw new Error(`${t.home} is a worker's fleet home; run this on the fleet's home`);
  const fleetId = readFleetConfig(paths).id;
  const parsedId = MachineId.safeParse(id);
  if (!parsedId.success) throw new Error(`${id} is not a machine id: ${z.prettifyError(parsedId.error)}`);
  const parsed = MachineRecord.safeParse({ ...o, dial: 'worker' });
  if (!parsed.success) throw new Error(`${id} is not enrolled: ${z.prettifyError(parsed.error)}`);
  const machine = parsedId.data;
  const record = parsed.data;
  const socket = dialSocket(paths, machine);
  const long = dialSocketTooLong(socket, record.platform);
  if (long) throw new Error(`${long.message}, so no worker can dial into ${t.home}; use an account whose home is ${long.over} bytes shorter`);
  if (socket.includes(':')) throw new Error(`${socket} holds a colon, which ssh reads as a forward's separator, so no worker can dial into ${t.home}`);
  const registry = MachineRegistry.load();
  // the record is the account's, so a machine another fleet here reaches over ssh would lose that route
  const route = registry.get(machine)?.record.ssh;
  const sharing = route ? fleetHomes(os.homedir()).find((h) => h !== t.home && tokenFor(resolvePaths(h), machine)) : undefined;
  if (sharing) throw new Error(`the fleet in ${sharing} reaches ${record.name} over ssh at ${route}, which this would end; svall host remove ${record.name} --forget drops that route for every fleet here and leaves the machine as it is`);
  registry.put(machine, record);
  registry.save();
  const token = issueToken(paths, machine);
  // a daemon not running links it as it starts
  await withClient(() => Client.connect(t.home), (c) => c.call('machines.refresh', {})).catch(() => undefined);
  const here = registry.localMachine();
  return { homeMachineId: registry.localId, homeName: here.name, fleetId, socket, token, homeSvallBase: installPrefix(), homePlatform: here.platform, homeArch: here.arch, homePath: here.home };
}

const readStdin = async (): Promise<string> => {
  let text = '';
  for await (const chunk of process.stdin) text += String(chunk);
  return text;
};

const adoptDeps = (t: Target): AdoptDeps => ({ paths: resolvePaths(t.home), me: machineId(), daemon: realHomeDaemon(t) });

const flowReporter = (json: boolean) => (json
  ? (e: StepEvent) => { process.stdout.write(`${JSON.stringify(e)}\n`); }
  : (e: StepEvent) => { if (e.status !== 'start') process.stdout.write(`${stepLine(e)}\n`); });

function moveDeps(t: Target, json: boolean): MoveDeps {
  return {
    emit: flowReporter(json), openMaster: (destination) => SshMaster.open({ destination }), registry: MachineRegistry.load(), target: t, me: machineId(), daemon: realHomeDaemon(t),
    client: () => Client.connect(t.home),
    farClient: async (master, entry, fleetHome, fleetId) => (await connectForwarded(master, entry, { fleetId: FleetId.parse(fleetId), fleetHome })).client,
  };
}

function finishFlow(out: HostOutcome, json: boolean, done: string): void {
  if (json) process.stdout.write(`${JSON.stringify({ outcome: out })}\n`);
  else process.stdout.write(`${out.result === 'ready' ? done : out.actions.join('\n')}\n`);
  if (out.result !== 'ready') process.exitCode = 1;
}

/** A home move's commands: those the far machine runs for a driver over ssh, and `home`, the driver. */
function homeMoveCommands(cmd: Command, target: () => Target, json: () => boolean): void {
  const idOf = (id: string): HomeMoveId => {
    const parsed = HomeMoveId.safeParse(id);
    if (!parsed.success) throw new Error(`${id} is not a home move's id`);
    return parsed.data;
  };
  const answer = (a: AdoptAnswer): void => printResult(a, true);
  cmd.command('facts').description('what this machine says of itself to a home move\'s check').action(async () => {
    const t = target();
    const paths = resolvePaths(t.home);
    const worker = isWorker(paths);
    printResult(await homeFacts(paths, { me: machineId(), role: worker ? 'worker' : 'home', fleetId: readFleetConfig(paths).id }), json());
  });
  cmd.command('adopt').description('take the fleet from the home it leaves: --stage reads its archive from stdin; alone, stops, installs and starts this machine as its home')
    .argument('<id>', 'the move\'s id')
    .option('--stage', 'stage the archive on stdin, in base64')
    .option('--sha256 <sha>', 'the archive\'s sha256')
    .option('--home-ssh <destination>', 'the destination the old home dials this machine at')
    .action(async (raw: string, o: { stage?: boolean; sha256?: string; homeSsh?: string }) => {
      const t = target();
      const id = idOf(raw);
      const d = adoptDeps(t);
      // an ssh that goes away leaves this to finish
      process.on('SIGHUP', () => undefined);
      process.stdout.on('error', () => undefined);
      if (o.stage) {
        if (!o.sha256) throw new Error('--stage takes --sha256');
        return answer(await stageAdopt(d, id, o.sha256, Buffer.from(await readStdin(), 'base64')));
      }
      const registry = MachineRegistry.load();
      answer(await installAdopt(d, id, enrolmentFor(d.paths, d.me, { ...(o.homeSsh && { ssh: o.homeSsh }), home: { ...registry.localMachine(), svallBase: installPrefix() } })));
    });
  cmd.command('status').description('what this machine says of a home move; a move it never heard of it refuses for good').argument('<id>', 'the move\'s id')
    .action(async (raw: string) => answer(await adoptStatus(adoptDeps(target()), idOf(raw))));
  cmd.command('abort').description('call a home move off here, for good, unless it has gone through').argument('<id>', 'the move\'s id')
    .action(async (raw: string) => answer(await abortAdopt(adoptDeps(target()), idOf(raw))));
  cmd.command('export').description('the fleet\'s archive as JSON, in base64, for the machine it moves to').argument('<id>', 'the move\'s id')
    .requiredOption('--manifest <json>', 'what the archive says of itself')
    .action(async (raw: string, o: { manifest: string }) => {
      const m = HomeManifest.parse(JSON.parse(o.manifest));
      if (m.id !== idOf(raw)) throw new Error('the manifest is of another move');
      const { bytes, sha256 } = await packFleet(resolvePaths(target().home), m);
      printResult({ sha256, archive: bytes.toString('base64') }, true);
    });
  cmd.command('settle').description('told how a move ended, by the machine this one has no route to: adopted joins it, with the enrolment on stdin; not-adopted thaws').argument('<id>', 'the move\'s id')
    .requiredOption('--outcome <outcome>', 'adopted or not-adopted')
    .action(async (raw: string, o: { outcome: string }) => {
      const t = target();
      const id = idOf(raw);
      const told = o.outcome === 'adopted' ? { status: 'adopted' as const, enrol: Enrolment.parse(JSON.parse(await readStdin())) } : { status: 'not-adopted' as const };
      printResult(await settleMove(resolvePaths(t.home), id, told, {
        join: (enrol) => withClient(() => Client.connect(t.home), (c) => c.call('fleet.homeMove', { op: 'join', id, enrol })),
        thaw: () => withClient(() => Client.connect(t.home), (c) => c.call('fleet.thaw', { id })),
        start: () => realHomeDaemon(t).start(),
      }), true);
    });
  const home = cmd.command('home').description('where the fleet runs').action(async () => {
    const t = target();
    const h = await withClient(() => Client.connect(t.home), (c) => c.call('fleet.home', {}));
    printResult(h, json(), () => (h.mine ? `the fleet runs here, on ${h.name}` : `the fleet runs on ${h.name}, and this machine is its worker`));
  });
  home.command('set').description('move the fleet to <machine>, or back here with local: its islands, notes, settings and phone pairing; robots stay where they run')
    .argument('<machine>', 'a worker of this fleet, or local')
    .action(async (machine: string) => {
      const t = target();
      const d = moveDeps(t, json());
      const out = await (machine === 'local' ? moveHomeBack(d) : moveHomeOut(machine, d));
      finishFlow(out, json(), machine === 'local' ? 'The fleet runs on this machine. Open the phone from its new QR code once.' : `The fleet runs on ${machine}. Open the phone from its new QR code once.`);
    });
  home.command('retry').description('go on with the move this machine waits on, from what stays staged').action(async () => {
    const t = target();
    finishFlow(await resumeHome(moveDeps(t, json())), json(), 'The move has gone through. Open the phone from its new QR code once.');
  });
  home.command('abort').description('call off the move this machine waits on, once the machine that holds it says it was not taken').action(async () => {
    const t = target();
    const back = await abortBack(moveDeps(t, json()));
    if (back) return printResult(back, json(), () => (back.status === 'not-adopted' ? `the move is off${back.told ? ', and the old home takes writes again' : '; the old home thaws once this machine reaches it'}` : 'the move has gone through here'));
    const m = await withClient(() => Client.connect(t.home), (c) => c.call('fleet.homeMove', { op: 'abort' }));
    printResult(m, json(), () => (m.moving ? `${m.moving.name} has not let go of it: ${m.moving.answer ?? 'no answer'}` : 'the move is off, and this home takes writes again'));
  });
}

/** What a fleet's home runs for the fleet as a whole: taking a worker that opens the link itself. */
export function fleetCommands(target: () => Target, json: () => boolean): Command {
  const cmd = new Command('fleet').description("the fleet this machine is the home of");
  cmd.command('enroll-worker').description('take a machine as a worker that dials in: its record, and a new token printed once with --json')
    .argument('<machine-id>', "the worker's machine id")
    .requiredOption('--name <name>', 'the name the fleet knows it by')
    .requiredOption('--platform <platform>', 'darwin or linux')
    .requiredOption('--arch <arch>', 'its architecture, as node names it')
    .requiredOption('--home <path>', "its account's home")
    .requiredOption('--svall-base <path>', 'where svall is installed there')
    .action(async (id: string, o: Facts) => {
      if (!json()) throw new Error('fleet enroll-worker prints a new token for svall worker enroll to read; run it with --json');
      printResult(await enrollWorker(target(), id, o), true);
    });
  cmd.command('join').description('make this fleet, empty, a worker of the fleet whose home is at <ssh>; the home never dials this machine')
    .argument('<ssh>', "the home's ssh destination")
    .option('--name <name>', 'the name the fleet knows this machine by; this machine\'s own, by default')
    .option('--home-profile <name>', 'the fleet there, when it is not the private one')
    .action(async (ssh: string, o: { name?: string; homeProfile?: string }) => {
      const t = target();
      const emit = json() ? (e: StepEvent) => { process.stdout.write(`${JSON.stringify(e)}\n`); } : (e: StepEvent) => { if (e.status !== 'start') process.stdout.write(`${stepLine(e)}\n`); };
      const out = await joinHome({ ssh, ...o }, {
        emit, openMaster: (destination) => SshMaster.open({ destination }), interactiveSsh, registry: MachineRegistry.load(), target: t, me: machineId(), svallBase: installPrefix(),
        tailnet: async () => { const m = realMobileDeps(); await tailnetSelf(m, await resolveTailscale(m)); },
        enrol: (e, token) => enrollHere(t, e, { ...realEnrol, token: () => Promise.resolve(token), out: (line) => { if (!json()) process.stdout.write(`${line}\n`); } }),
        state: () => withClient(() => Client.connect(t.home), (c) => c.call('state.get', {})),
      });
      if (json()) process.stdout.write(`${JSON.stringify({ outcome: out })}\n`);
      else process.stdout.write(`${out.result === 'ready' ? 'This fleet runs on the server now, and this machine is its worker.' : out.actions.join('\n')}\n`);
      if (out.result !== 'ready') process.exitCode = 1;
    });
  homeMoveCommands(cmd, target, json);
  return cmd;
}
