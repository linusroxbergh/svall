import { Command } from 'commander';
import { lazy } from './lazy.js';

export function versionCommand(json: () => boolean, home: () => string): Command {
  const run = lazy(() => import('../commands/version.js').then((m) => m.versionActions(json, home)));
  return new Command('version')
    .description('the release, the versions every machine of a fleet has to agree on, and the runtime running them')
    .action(run('version'));
}
