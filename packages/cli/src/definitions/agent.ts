import { Command } from 'commander';
import type { Target } from '../target.js';
import { lazy } from './lazy.js';

export function agentCommand(target: () => Target, json: () => boolean): Command {
  const run = lazy(() => import('../commands/agent.js').then((m) => m.agentActions(target, json)));
  return new Command('agent')
    .description('show or set the main agent: what the scribe, mission control and svall robot new --run run by default')
    .argument('[name]', 'claude, codex or opencode')
    .action(run('agent'));
}
