import path from 'node:path';
import { Command, Option } from 'commander';
import { RETRO_SPANS } from '@svall/protocol/enums';
import { expandHome } from '@svall/svalld/paths';
import type { Client } from '../client.js';
import { lazy } from './lazy.js';

const collect = (v: string, all: string[] = []): string[] => [...all, v];
const collectPath = (v: string, all: string[] = []): string[] => [...all, path.resolve(expandHome(v))];

export function retroCommands(connect: () => Promise<Client>, json: () => boolean, fleetHome: () => string): Command {
  const run = lazy(() => import('../commands/retro.js').then((m) => m.retroActions(connect, json, fleetHome)));
  const cmd = new Command('retro').description('read what the agents did and propose changes to skills, reviews and instructions');

  cmd.command('plan').description('read the stores and print the scope, the cards to make and each preset\'s tokens and cost; sends nothing to a model')
    .addOption(new Option('--span <span>', 'since the last retro, or the last 7 or 30 days').choices(RETRO_SPANS).default('last'))
    .option('--exclude-repo <path>', 'leave out a repo (saved)', collectPath)
    .option('--exclude-island <name>', 'leave out an island by name or id (saved)', collect)
    .option('--pick <repo>', 'read the sessions no fleet recorded in this repo (saved)', collectPath)
    .action(run('plan'));

  cmd.command('run <plan>').description('card the plan\'s sessions and judge them with a preset, within the budget; svalld carries on if this exits')
    .option('--preset <name>', 'the preset to read and judge with (default: balanced where the plan has it, else its first)')
    .option('--budget <tokens>', 'the most tokens the run may spend (default: the preset\'s cap)')
    .action(run('run'));

  cmd.command('wait [run]').description('follow a run until it ends; exits 1 when it failed or was interrupted')
    .action(run('wait'));

  cmd.command('status [run]').description('the stage of the newest run, or of the one named')
    .action(run('status'));

  cmd.command('findings [run]').description('print a run\'s summary: how the span went and the top findings, numbered')
    .action(run('findings'));

  cmd.command('show <n> [run]').description('print finding n of a run\'s report: why it matters, what was seen, the change, the verdict')
    .action(run('show'));

  cmd.command('mark <action> <findings...>').description('fix, dismiss or later findings by their number in the last findings, or by id')
    .addOption(new Option('--reason <reason>', 'why a dismissed finding is dismissed').choices(['wrong', 'not-worth-it']))
    .action(run('mark'));

  cmd.command('apply <finding>').description('apply a finding\'s diff to its file outside git, after the user said yes; keeps a backup')
    .action(run('apply'));

  cmd.command('config').description('show or change what the retro leaves out and the models it uses (fleet.json retro)')
    .option('--exclude-repo <path>', 'leave out a repo', collectPath)
    .option('--exclude-island <name>', 'leave out an island', collect)
    .option('--include-repo <path>', 'stop leaving out a repo', collectPath)
    .option('--include-island <name>', 'stop leaving out an island', collect)
    .addOption(new Option('--agent <cli>', 'the CLI the model options are for').choices(['claude', 'codex', 'opencode']).default('claude'))
    .option('--read-model <model>', 'the model that cards the sessions')
    .option('--judge-model <model>', 'the model that synthesizes the findings')
    .option('--verify-model <model>', 'the model that checks each finding against its evidence')
    .option('--review-skills <names>', 'skills to read as reviews, comma-separated, beside those named for one')
    .action(run('config'));

  return cmd;
}
