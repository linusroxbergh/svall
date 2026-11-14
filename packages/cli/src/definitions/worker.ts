import { Command } from 'commander';
import type { Target } from '../target.js';
import { lazy } from './lazy.js';

export function workerCommands(target: () => Target): Command {
  const run = lazy(() => import('../commands/worker.js').then((m) => m.workerActions(target)));
  const cmd = new Command('worker').description('this machine as a worker of a home\'s fleet');
  cmd.command('link').description('carry the home\'s link to this machine\'s svalld on stdin and stdout; the home runs it over ssh')
    .action(run('link'));
  cmd.command('enroll').description('serve the fleet of the home named, with the token read from stdin; its daemon restarts as a worker')
    .requiredOption('--home-machine <id>', 'the home\'s machine id')
    .requiredOption('--home-name <name>', 'the home\'s name')
    .requiredOption('--fleet-id <id>', 'the fleet\'s id')
    .option('--home-ssh <destination>', 'the home this machine dials itself, which then needs no ssh to it')
    .option('--home-socket <path>', 'the socket on the home its link is forwarded to, as svall fleet enroll-worker there names it')
    .option('--home-svall-base <path>', 'where svall is installed on the home, as svall fleet enroll-worker there names it')
    .option('--home-platform <platform>', "the home's platform, as svall fleet enroll-worker there names it")
    .option('--home-arch <arch>', "the home's architecture, as svall fleet enroll-worker there names it")
    .option('--home-path <path>', "the home's user folder, as svall fleet enroll-worker there names it")
    .action(run('enroll'));
  cmd.command('env').description('set a variable for this fleet\'s robots on this machine, its value read from stdin')
    .argument('<VAR>', 'the variable\'s name')
    .action(run('env'));
  return cmd;
}
