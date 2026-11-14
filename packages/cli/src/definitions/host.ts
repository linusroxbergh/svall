import { Command, Option } from 'commander';
import type { Target } from '../target.js';
import { lazy } from './lazy.js';
import { hostLimits } from './limits.js';

export function hostCommands(json: () => boolean, target: () => Target, dir?: () => string): Command {
  const run = lazy(() => import('../commands/host.js').then((m) => m.hostActions(json, target, dir)));
  const host = new Command('host').description('the machines robots can run on')
    // the app's Stop is a SIGTERM, which would otherwise leave this command's master running
    .hook('preAction', run('preAction'));

  host.command('add')
    .description('provision a remote Svall host and add it to the registry')
    .argument('<name>', 'what to call the machine here')
    .requiredOption('--ssh <destination>', 'the ssh destination to reach it at')
    .option('--release <archive>', 'install this companion archive instead of the one this release publishes')
    .option('--allow-unsigned', 'install a --release archive that carries no signature')
    .option('--as-home', 'leave it a fleet\'s home, for svall fleet join to follow, not a worker of this fleet')
    .addOption(new Option('--limits <cores,memory>', 'what the fleet may use of the machine, such as 11,93G, set without asking'))
    .addOption(new Option('--no-limits', 'leave the fleet all of the machine, without asking'))
    .addOption(new Option('--relayed', 'run for a Mac, ending with its connection').hideHelp())
    .action(run('add'));

  host.addCommand(hostLimits(target, json, run('limitsOnHome')));

  host.command('list')
    .description('every machine in the registry and its last check')
    .addOption(new Option('--relayed', 'run for a Mac, ending with its connection').hideHelp())
    .action(run('list'));

  host.command('doctor')
    .description('what the machine answers about itself, and what only this controller can check')
    .argument('<name>', 'the machine in the registry')
    .option('--all', 'list every check and each part of your agent setup, not only what needs you')
    .addOption(new Option('--steps', 'with --json, print each step as an NDJSON line as it goes, before the report').hideHelp())
    .addOption(new Option('--relayed', 'run for a Mac, ending with its connection').hideHelp())
    .action(run('doctor'));

  host.command('consent')
    .description('tick or untick one item of your agent setup for the machine, as host doctor --all lists it')
    .argument('<name>', 'the machine in the registry')
    .argument('<item>', 'the agent setup item, such as claude:mcp:linear')
    .argument('<state>', 'on to copy its keys there, off to stop')
    .option('--field <field...>', 'with on, only these keys of it; off takes every key')
    .addOption(new Option('--relayed', 'run for a Mac, ending with its connection').hideHelp())
    .action(run('consent'));

  host.command('upgrade')
    .description('install a new companion release, and go back to the old one if it does not answer')
    .argument('<name>', 'the machine in the registry')
    .option('--release <archive>', 'install this companion archive instead of the one this release publishes')
    .option('--allow-unsigned', 'install a --release archive that carries no signature')
    .option('--rollback [release]', 'put the machine back on this release, or on the one before, and check its daemons answer from it')
    .addOption(new Option('--relayed', 'run for a Mac, ending with its connection').hideHelp())
    .action(run('upgrade'));

  host.command('remove')
    .description('uninstall Svall on the machine and drop its route')
    .argument('<name>', 'the machine in the registry')
    .option('--forget', 'drop the route for a machine that cannot be reached, leaving it untouched')
    .addOption(new Option('--relayed', 'run for a Mac, ending with its connection').hideHelp())
    .action(run('remove'));

  return host;
}
