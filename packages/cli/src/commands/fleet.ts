import os from 'node:os';
import { Command } from 'commander';
import { z } from 'zod';
import { MachineId, MachineRecord, type FleetState } from '@svall/protocol';
import { readFleetConfig } from '@svall/svalld/config';
import { dialSocket, dialSocketTooLong, resolvePaths } from '@svall/svalld/paths';
import { issueToken, tokenFor } from '@svall/svalld/placement/workers';
import { fleetHomes } from '@svall/svalld/uninstall';
import { isWorker } from '@svall/svalld/worker/mode';
import { Client } from '../client.js';
import { MachineRegistry } from '../controller/registry.js';
import { printResult } from '../format.js';
import type { Target } from '../target.js';

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
async function enrollWorker(t: Target, id: string, o: Facts): Promise<{ homeMachineId: MachineId; homeName: string; fleetId: string; socket: string; token: string }> {
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
  return { homeMachineId: registry.localId, homeName: registry.localMachine().name, fleetId, socket, token };
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
  return cmd;
}
