import { Command, Option } from 'commander';
import { PANE_KINDS } from '@svall/protocol/enums';
import type { Client } from '../client.js';
import { lazy } from './lazy.js';

const SHOWN = ['show', 'hide'];

export function appCommands(connect: () => Promise<Client>, json: () => boolean): Command {
  const run = lazy(() => import('../commands/app.js').then((m) => m.appActions(connect, json)));
  const cmd = new Command('app').description('what the app window on this fleet shows');

  cmd.command('show').description("show a robot's card, its panes and the window's sides; what is left out stays")
    .argument('[robot]', 'the robot whose card opens')
    .addOption(new Option('--left <pane>', 'the left pane').choices(PANE_KINDS))
    .addOption(new Option('--right <pane>', 'the right pane, or none for the left alone').choices([...PANE_KINDS, 'none']))
    .option('--ratio <share>', "the left pane's share of the card, 0.25 to 0.75")
    .option('--file <path>', "open a file in the robot's Files, as a link in its terminal would")
    .addOption(new Option('--preview', 'show the --file formatted, when it is markdown').hideHelp())
    .addOption(new Option('--tree <state>', "the folders beside Files' editor").choices(SHOWN))
    .addOption(new Option('--card <size>', "the robot's card; closed leaves the robot selected").choices(['half', 'full', 'closed']))
    .addOption(new Option('--sidebar <state>', 'the islands list on the left').choices(SHOWN))
    .addOption(new Option('--side-card <state>', "the selected robot's details on the right").choices(SHOWN))
    .addOption(new Option('--view <view>', 'the map or the board').choices(['map', 'board']))
    .addOption(new Option('--panel <panel>', "the dock's panel, or none").choices(['phone', 'usage', 'load', 'none']))
    .option('--size <w,h>', "the window's size in points, like 1280,820")
    .addOption(new Option('--redact <url>', "with --panel phone, a QR for url in place of the fleet's, and its link and logins hidden").hideHelp())
    .action(run('show'));

  return cmd;
}
