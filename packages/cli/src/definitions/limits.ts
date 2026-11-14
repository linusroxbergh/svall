import { Command, Option } from 'commander';
import type { Target } from '../target.js';
import { lazy } from './lazy.js';

const setFlags = (cmd: Command): Command => cmd
  .option('--cpus <n>', 'the cores the fleet may use')
  .option('--memory <amount>', 'the memory it may use, such as 8G')
  .option('--none', 'no limit');

/** `--limits` and `--no-limits` of a command that connects a machine. */
export const connectFlags = (cmd: Command): Command => cmd
  .addOption(new Option('--limits <cores,memory>', 'what the fleet may use of the machine, such as 11,93G, set without asking'))
  .addOption(new Option('--no-limits', 'leave the fleet all of the machine, without asking'));

/** `svall fleet limits`: what this fleet may use of this machine, read and set here. */
export function fleetLimits(target: () => Target, json: () => boolean): Command {
  const run = lazy(() => import('../commands/limits.js').then((m) => m.fleetLimitsActions(target, json)));
  const cmd = new Command('limits').description('the cores and memory this fleet may use of this Linux machine').action(run('show'));
  setFlags(cmd.command('set').description('set them on the fleet\'s unit as it runs; nothing restarts')).action(run('set'));
  return cmd;
}

/** `svall host limits <name>`: the same of any Linux machine of the fleet, through its home's daemon; `onHome` runs it on
 *  the home where that is another machine, and answers false where it is this one. */
export function hostLimits(target: () => Target, json: () => boolean, onHome: (name: string, flags: string[]) => Promise<boolean>): Command {
  const run = lazy(() => import('../commands/limits.js').then((m) => m.hostLimitsActions(target, json, onHome)));
  return setFlags(new Command('limits').description('the cores and memory the fleet may use of a Linux machine, shown, or set with --cpus, --memory or --none')
    .argument('<name>', 'the machine, as svall host list names it, or its id'))
    .addOption(new Option('--relayed', 'run for a Mac, ending with its connection').hideHelp())
    .action(run('limits'));
}
