import { Command } from 'commander';
import type { runUninstall } from '@svall/svalld/uninstall';
import { lazy } from './lazy.js';

export function uninstallCommand(json: () => boolean, uninstall?: typeof runUninstall): Command {
  const run = lazy(() => import('../commands/uninstall.js').then((m) => m.uninstallActions(json, uninstall)));
  return new Command('uninstall')
    .description('remove what svall setup added and stop every fleet; asks before deleting the fleets and the app')
    .option('--purge', 'also delete every fleet, the copies of your own agent files in its mirror-backup with it, and the app, without asking')
    .option('--from-app', 'run by the app itself: leave it open and in place')
    .option('--login-shell', 'take PATH and where the agents keep their files from the login shell, as an app opened from Finder has none')
    .option('--no-launchctl', 'leave the daemons running, only delete the files that start them')
    .action(run('uninstall'));
}
