import { Command } from 'commander';
import type { Client } from '../client.js';
import { lazy } from './lazy.js';

export function browserCommands(connect: () => Promise<Client>, json: () => boolean): Command {
  const run = lazy(() => import('../commands/browser.js').then((m) => m.browserActions(connect, json)));
  const cmd = new Command('browser').description("a robot's browser tabs");

  cmd.command('open').description('open a url in a new tab').argument('<url>').option('--robot <id>').action(run('open'));

  cmd.command('list').description('list the tabs, the active one starred').option('--robot <id>').action(run('list'));

  cmd.command('close').description('close a tab').argument('<tab>').option('--robot <id>').action(run('close'));

  return cmd;
}
