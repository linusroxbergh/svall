import { Command } from 'commander';
import { MachineId, MachineRecord } from '@svall/protocol';
import { readFleetConfig } from '@svall/svalld/config';
import { dialSocket, resolvePaths, socketTooLong } from '@svall/svalld/paths';
import { issueToken } from '@svall/svalld/placement/workers';
import { isWorker } from '@svall/svalld/worker/mode';
import { Client } from '../client.js';
import { MachineRegistry } from '../controller/registry.js';
import { printResult } from '../format.js';
import type { Target } from '../target.js';
import { withClient } from './fleet.js';

type Facts = { name: string; platform: string; arch: string; home: string; svallBase: string };

/**
 * A worker that dials this home: its record in this machine's registry, which the home links by, and a new token, the
 * newest of which the home holds. Answers what that worker's `svall worker enroll` takes, the token only as JSON.
 */
async function enrollWorker(t: Target, id: string, o: Facts): Promise<{ homeMachineId: MachineId; homeName: string; fleetId: string; socket: string; token: string }> {
  const paths = resolvePaths(t.home);
  if (isWorker(paths)) throw new Error(`${t.home} is a worker's fleet home; run this on the fleet's home`);
  const fleetId = readFleetConfig(paths).id;
  const machine = MachineId.parse(id);
  const record = MachineRecord.parse({ ...o, dial: 'worker' });
  const socket = dialSocket(paths, machine);
  const long = socketTooLong(socket);
  if (long) throw new Error(`${long.message}, so no worker can dial into ${t.home}; use an account whose home is ${long.over} bytes shorter`);
  if (socket.includes(':')) throw new Error(`${socket} holds a colon, which ssh reads as a forward's separator, so no worker can dial into ${t.home}`);
  const registry = MachineRegistry.load();
  registry.put(machine, record);
  registry.save();
  const token = issueToken(paths, machine);
  // a daemon not running links it as it starts
  await withClient(() => Client.connect(t.home), (c) => c.call('machines.refresh', {})).catch(() => undefined);
  return { homeMachineId: registry.localId, homeName: registry.localMachine().name, fleetId, socket, token };
}

/** What the fleet's home runs for a worker that opens the link itself. */
export function homeCommands(target: () => Target, json: () => boolean): Command {
  const cmd = new Command('home').description("this machine as its fleet's home");
  cmd.command('enroll-worker').description('take a machine as a worker that dials in: its record, and a new token printed once with --json')
    .argument('<machine-id>', "the worker's machine id")
    .requiredOption('--name <name>', 'the name the fleet knows it by')
    .requiredOption('--platform <platform>', 'darwin or linux')
    .requiredOption('--arch <arch>', 'its architecture, as node names it')
    .requiredOption('--home <path>', "its account's home")
    .requiredOption('--svall-base <path>', 'where svall is installed there')
    .action(async (id: string, o: Facts) => {
      if (!json()) throw new Error('home enroll-worker prints a new token for svall worker enroll to read; run it with --json');
      printResult(await enrollWorker(target(), id, o), true);
    });
  return cmd;
}
