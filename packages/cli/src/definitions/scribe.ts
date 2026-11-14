import { Command } from 'commander';
import type { Client } from '../client.js';
import { lazy } from './lazy.js';

export function scribeCommands(connect: () => Promise<Client>, json: () => boolean): Command {
  const run = lazy(() => import('../commands/scribe.js').then((m) => m.scribeActions(connect, json)));
  const cmd = new Command('scribe').description('write names, notes, island descriptions and links from what each agent is doing');

  cmd.command('sweep').description('refresh the whole fleet now; prints one line per change')
    .option('--names', 'write only names').option('--islands', 'write only island descriptions and links')
    .action(run('sweep'));

  return cmd;
}
