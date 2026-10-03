import { Command } from 'commander';
import type { Client } from '../client.js';
import { printResult } from '../format.js';
import { withClient } from './fleet.js';

export function scribeCommands(connect: () => Promise<Client>, json: () => boolean): Command {
  const cmd = new Command('scribe').description('write names, notes, island descriptions and links from what each agent is doing');

  cmd.command('sweep').description('refresh the whole fleet now; prints one line per change')
    .option('--names', 'write only names').option('--islands', 'write only island descriptions and links')
    .action(async (o: { names?: boolean; islands?: boolean }) => {
      if (o.names && o.islands) throw new Error('use --names or --islands, not both');
      const r = await withClient(connect, (c) => c.call('scribe.sweep', { names: o.names, islands: o.islands }));
      printResult(r, json(), () => r.lines.join('\n') || 'nothing changed');
    });

  return cmd;
}
