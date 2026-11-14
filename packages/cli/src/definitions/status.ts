import { Command } from 'commander';
import type { Client } from '../client.js';
import { lazy } from './lazy.js';

export function statusCommand(connect: () => Promise<Client>, json: () => boolean, home: () => string): Command {
  const run = lazy(() => import('../commands/status.js').then((m) => m.statusActions(connect, json, home)));
  return new Command('status').description('show every island and robot').action(run('status'));
}
