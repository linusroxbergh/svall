import { Command } from 'commander';
import type { Client } from '../client.js';
import { contextOptions } from './context.js';
import { lazy } from './lazy.js';

export function islandCommands(connect: () => Promise<Client>, json: () => boolean): Command {
  const run = lazy(() => import('../commands/island.js').then((m) => m.islandActions(connect, json)));
  const cmd = new Command('island').description('manage islands');

  cmd.command('list').description('list every island').action(run('list'));

  contextOptions(cmd.command('create <name>').description('make an island')
    .option('--at <x,y>').option('--size <w,h>').option('--description <d>'))
    .action(run('create'));

  contextOptions(cmd.command('update <id>').description("change an island's name, description, place, size, context or instructions")
    .option('--name <n>').option('--description <d>').option('--at <x,y>').option('--size <w,h>'))
    .action(run('update'));

  cmd.command('arrange').description('resize every island to its crew and pack the fleet together')
    .option('--aspect <n>', 'width over height of the window to fill')
    .action(run('arrange'));

  cmd.command('show <id>').description('print the brief the agent gets').action(run('show'));

  cmd.command('delete <id>').description('delete an empty island and its docs').action(run('delete'));

  return cmd;
}
