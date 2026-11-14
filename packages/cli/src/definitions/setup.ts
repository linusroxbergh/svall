import { Command } from 'commander';
import type { Probe } from '../commands/setup.js';
import type { Target } from '../target.js';
import { lazy } from './lazy.js';

export function setupCommand(target: () => Target, json: () => boolean, platform: NodeJS.Platform = process.platform, probe?: Probe): Command {
  const run = lazy(() => import('../commands/setup.js').then((m) => m.setupActions(target, json, probe)));
  if (platform === 'linux') {
    return new Command('setup')
      .description('install hooks, systemd user units and the svall shim')
      .option('--no-launchctl', 'write files only, do not (re)start the systemd unit')
      .option('--check', 'only check what setup needs; change nothing')
      .option('--release <path>', 'install this release tree or archive and run the daemon from it')
      .option('--allow-unsigned', 'install a --release that carries no signature')
      .option('--replace-settings', 'replace the mission-control .claude/settings.json you have edited, keeping a copy')
      .option('--rollback [release]', 'put current back on this release, or on the one before, and restart the daemon')
      .action(run('linux'));
  }
  return new Command('setup')
    .description('install hooks, the launchd agent and the svall shim')
    .option('--no-launchctl', 'write files only; leave launchd alone')
    .option('--check', 'only check what setup needs; change nothing')
    .option('--plan', 'print what setup would do, as the app shows it; change nothing')
    .option('--agents <list>', 'the agents to install hooks for, comma-separated; saved for later runs')
    .option('--found <list>', 'the agents the setup screen showed; those left out of --agents stay off (default: the agents found now)')
    .option('--projects <dir>', 'where new robots start, made if missing; saved as defaultCwd')
    .option('--main-agent <kind>', 'main agent selected during setup')
    .option('--first-project <dir>', 'project for the first island and robot')
    .option('--scribe <on|off>', 'automatic notes selected during onboarding')
    .option('--new-robots <agent|shell>', 'what the app starts for new robots')
    .option('--svall-permissions <on|off>', 'allow robot svall commands')
    .option('--if-needed', 'set up only what is missing or out of date, and restart daemons of another version')
    .option('--login-shell', 'take PATH and where the agents keep their files from the login shell, as an app opened from Finder has none')
    .option('--joining', 'for a Mac that joins a fleet on a server next: no agent CLI needed here, and the app starts no fleet until the join lands')
    .action(run('mac'));
}
