import { Command } from 'commander';
import type { Target } from '../target.js';
import { lazy } from './lazy.js';

export function doctorCommand(target: () => Target, json: () => boolean, platform: NodeJS.Platform = process.platform): Command {
  const run = lazy(() => import('../commands/doctor.js').then((m) => m.doctorActions(target, json, platform)));
  const rebind = "bind machine.json to this machine's hardware, after the hardware changed under it";
  return new Command('doctor').description('check what the fleet needs and show the end of its log; changes nothing unless --rebind').option('--rebind', rebind).action(run('doctor'));
}
