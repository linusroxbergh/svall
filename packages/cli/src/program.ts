import fs from 'node:fs';
import { Command } from 'commander';
import { agentCommand } from './commands/agent.js';
import { browserCommands } from './commands/browser.js';
import { charCommands } from './commands/char.js';
import { connectCommand } from './commands/connect.js';
import { connectionInfoCommand } from './commands/connection.js';
import { doctorCommand } from './commands/doctor.js';
import { fleetCommands } from './commands/fleet-recover.js';
import { gatewayCommands } from './commands/gateway.js';
import { handoverCommand } from './commands/handover.js';
import { hostCommands } from './commands/host.js';
import { islandCommands } from './commands/island.js';
import { mobileCommand } from './commands/mobile.js';
import { scribeCommands } from './commands/scribe.js';
import { setupCommand } from './commands/setup.js';
import { statusCommand } from './commands/status.js';
import { uninstallCommand } from './commands/uninstall.js';
import { versionCommand } from './commands/version.js';
import { connectFor } from './controller/connection.js';
import { closeMastersOnSignal } from './controller/ssh.js';
import { launch, realDeps } from './launch.js';
import { resolveTarget, targetFor } from './target.js';
import { checkoutVersion } from './version.js';

/** Whether `word` is `name` with one letter added, dropped, changed, or two neighbours swapped. */
export function typo(word: string, name: string): boolean {
  if (word === name || Math.abs(word.length - name.length) > 1) return false;
  let i = 0;
  while (word[i] === name[i]) i++;
  const [a, b] = [word.slice(i), name.slice(i)];
  return a.slice(1) === b.slice(1) || a.slice(1) === b || a === b.slice(1) || (a[0] === b[1] && a[1] === b[0] && a.slice(2) === b.slice(2));
}

export function buildProgram(): Command {
  const program = new Command('archi')
    .description('Archipelago fleet control; with no command it opens the app')
    .option('--json', 'machine-readable output')
    .option('-p, --profile <name>', 'the fleet to work on (default: $ARCHI_HOME, else private)')
    .option('--host <name|local>', 'the machine to reach (default: the one that owns the fleet)')
    // commander's own .version() wants the string up front, which would run git on every command
    .option('-V, --version', 'print the commit this checkout is on, or the release installed')
    .on('option:version', () => {
      process.stdout.write(`${checkoutVersion()}\n`);
      process.exit(0);
    })
    .argument('[profile]', 'open this profile, offering to create it if missing')
    // a root action would otherwise swallow `archi help` and any stray argument after the profile
    .helpCommand(true)
    .allowExcessArguments(false);
  const json = () => Boolean(program.opts().json);
  const target = () => resolveTarget({ profile: program.opts().profile, env: process.env.ARCHI_HOME });
  const home = () => target().home;
  const profileFlag = () => program.opts().profile as string | undefined;
  const connect = () => {
    // a command routed to another machine holds a master there, which must not outlive it
    closeMastersOnSignal();
    return connectFor({ home: home(), host: program.opts().host, profile: profileFlag() });
  };

  program.action(async (profile?: string) => {
    const t = profile === undefined ? target() : targetFor(profile);
    // a mistyped command arrives as a profile name, and must not be offered as a new fleet
    const meant = profile !== undefined && !fs.existsSync(t.home)
      ? [...program.commands.map((c) => c.name()), 'help'].find((c) => typo(profile, c)) : undefined;
    if (meant) throw new Error(`unknown command ${profile}; did you mean ${meant}? (archi -p ${profile} makes a fleet by that name)`);
    await launch(t, realDeps());
  });
  program.addCommand(statusCommand(connect, json, home));
  program.addCommand(islandCommands(connect, json));
  program.addCommand(charCommands(connect, json));
  program.addCommand(scribeCommands(connect, json));
  program.addCommand(browserCommands(connect, json));
  program.addCommand(mobileCommand(connect, json));
  program.addCommand(setupCommand(target, json));
  program.addCommand(agentCommand(target, json));
  program.addCommand(doctorCommand(target, json));
  program.addCommand(hostCommands(json));
  program.addCommand(handoverCommand({ target, profile: profileFlag, json }));
  program.addCommand(gatewayCommands());
  program.addCommand(fleetCommands(home, json, profileFlag, target));
  program.addCommand(uninstallCommand(json));
  program.addCommand(connectCommand(home, profileFlag));
  program.addCommand(connectionInfoCommand(home, json));
  program.addCommand(versionCommand(json));

  return program;
}
