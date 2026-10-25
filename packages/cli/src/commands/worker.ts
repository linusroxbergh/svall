import net from 'node:net';
import { Command } from 'commander';
import { z } from 'zod';
import { WorkerFile } from '@svall/protocol';
import { writeDurable } from '@svall/svalld/handover/durable';
import { resolvePaths } from '@svall/svalld/paths';

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
export function workerCommands(home: () => string): Command {
  const cmd = new Command('worker').description('this machine as a worker of a home\'s fleet');
  cmd.command('link').description('carry the home\'s link to this machine\'s svalld on stdin and stdout; the home runs it over ssh')
    .action(() => proxy(resolvePaths(home()).linkSock));
  cmd.command('enroll').description('serve the fleet of the home named, with the token read from stdin')
    .requiredOption('--home-machine <id>', 'the home\'s machine id')
    .requiredOption('--home-name <name>', 'the home\'s name')
    .requiredOption('--fleet-id <id>', 'the fleet\'s id')
    .action(async (o: { homeMachine: string; homeName: string; fleetId: string }) => {
      const file = WorkerFile.safeParse({ homeMachineId: o.homeMachine, fleetId: o.fleetId, token: (await readAll(process.stdin)).trim(), homeName: o.homeName });
      if (!file.success) throw new Error(`worker.json not written: ${z.prettifyError(file.error)}`);
      writeDurable(resolvePaths(home()).workerFile, file.data, { mode: 0o600 });
    });
  return cmd;
}
