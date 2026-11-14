import { Command } from 'commander';
import type { Target } from '../target.js';
import { lazy } from './lazy.js';
import { connectFlags, fleetLimits } from './limits.js';

/** What a fleet's home runs for the fleet as a whole: taking a worker that opens the link itself. */
export function fleetCommands(target: () => Target, json: () => boolean): Command {
  const run = lazy(() => import('../commands/fleet.js').then((m) => m.fleetActions(target, json)));
  const cmd = new Command('fleet').description("the fleet this machine is the home of");
  cmd.command('enroll-worker').description('take a machine as a worker that dials in: its record, and a new token printed once with --json')
    .argument('<machine-id>', "the worker's machine id")
    .requiredOption('--name <name>', 'the name the fleet knows it by')
    .requiredOption('--platform <platform>', 'darwin or linux')
    .requiredOption('--arch <arch>', 'its architecture, as node names it')
    .requiredOption('--home <path>', "its account's home")
    .requiredOption('--svall-base <path>', 'where svall is installed there')
    .option('--keep-token', 'answer with the token this home holds for it, where it holds one')
    .action(run('enrollWorker'));
  cmd.addCommand(fleetLimits(target, json));
  connectFlags(cmd.command('join').description('make this fleet, empty, a worker of the fleet whose home is at <ssh>; the home never dials this machine')
    .argument('<ssh>', "the home's ssh destination")
    .option('--name <name>', 'the name the fleet knows this machine by; this machine\'s own, by default')
    .option('--home-profile <name>', 'the fleet there, when it is not the private one'))
    .action(run('join'));

  // a home move's commands: those the far machine runs for a driver over ssh, and `home`, the driver
  cmd.command('facts').description('what this machine says of itself to a home move\'s check').action(run('facts'));
  // the driver runs it over ssh, the install with its key on stdin once the old home is marked; nothing a person types takes the fleet
  cmd.command('adopt', { hidden: true }).description('take the fleet from the home it leaves: --stage reads its archive from stdin; alone, reads the key of the move\'s driver from stdin, then stops, installs and starts this machine as its home')
    .argument('<id>', 'the move\'s id')
    .option('--stage', 'stage the archive on stdin, in base64')
    .option('--sha256 <sha>', 'the archive\'s sha256')
    .option('--home-ssh <destination>', 'the destination the old home dials this machine at')
    .action(run('adopt'));
  const asks = (c: Command): Command => c.argument('<id>', 'the move\'s id').option('--asker <machine-id>', 'the home that asks, which only its worker can tell the move was not taken').option('--fleet <fleet-id>', 'the fleet it asks of');
  asks(cmd.command('status').description('what this machine says of a home move; to the home it serves, a move it never heard of it refuses for good'))
    .action(run('status'));
  asks(cmd.command('abort').description('call a home move off here, for good, unless it has gone through'))
    .action(run('abort'));
  cmd.command('export').description('the fleet\'s archive as JSON, in base64, for the machine it moves to; reads what the archive says of itself from stdin').argument('<id>', 'the move\'s id')
    .action(run('export'));
  // the machine that took the fleet tells the old home over ssh, with its driver's key on stdin; nothing a person types ends the wait
  cmd.command('settle', { hidden: true }).argument('<id>', 'the move\'s id')
    .requiredOption('--outcome <outcome>', 'adopted or not-adopted')
    .action(run('settle'));
  const home = cmd.command('home').description('where the fleet runs').action(run('home'));
  home.command('set').description('move the fleet to <machine>, or back here with local: its islands, notes, settings and phone pairing; robots stay where they run')
    .argument('<machine>', 'a worker of this fleet, or local')
    .option('--interrupt-after <duration>', 'interrupt what a robot of mission control runs after this long, 0 at once; without it, one at work stops the move before anything moves')
    .action(run('homeSet'));
  home.command('retry').description('go on with the move this machine waits on, from what stays staged').action(run('homeRetry'));
  home.command('abort').description('call off the move this machine waits on, once the machine that holds it says it was not taken').action(run('homeAbort'));
  home.command('crew-back').description('bring back mission control\'s robots a move that stopped left away from the home')
    .option('--interrupt-after <duration>', 'interrupt what they run after this long, 0 at once; without it, one at work stays there and says so')
    .action(run('crewBack'));
  return cmd;
}
