import { Command } from 'commander';
import { lazy } from './lazy.js';

export function connectionInfoCommand(home: () => string, json: () => boolean): Command {
  const run = lazy(() => import('../commands/connection.js').then((m) => m.connectionInfoActions(home, json)));
  return new Command('connection-info')
    .description('what a controller needs to reach this fleet over a tunnel')
    .action(run('connectionInfo'));
}
