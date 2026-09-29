import os from 'node:os';
import { Command } from 'commander';
import { FleetId, MachineId } from '@archipelago/protocol';
import { ProvisionRefused, provisionFleet } from '@archipelago/archid/linux/provision';
import { realRun } from '@archipelago/archid/linux/service';
import { unitDirOf } from '@archipelago/archid/linux/setup';
import { DEFAULT_PREFIX } from '../../../../scripts/install-release.mjs';
import { printResult } from '../format.js';
import type { Target } from '../target.js';
import { currentRunFrom } from '../version.js';

/** The exit code of a refusal: a fleet home that holds another fleet in use, which only the user can move aside. */
export const REFUSED = 3;

/** `archi fleet provision`: the companion's own copy of a fleet whose gateway it is, as `archi host enable` asks for it. */
export function provisionCommand(
  target: () => Target, json: () => boolean, platform: NodeJS.Platform = process.platform, provision: typeof provisionFleet = provisionFleet,
): Command {
  return new Command('provision')
    .description('give this machine its copy of a fleet it is the gateway of; archi host enable runs it over ssh')
    .requiredOption('--id <fleet>', 'the fleet id')
    .requiredOption('--gateway <machine>', 'the id of the machine that is the fleet\'s gateway')
    .action(async (o: { id: string; gateway: string }) => {
      const fleetId = FleetId.safeParse(o.id);
      if (!fleetId.success) throw new Error(`${o.id} is not a fleet id`);
      const gateway = MachineId.safeParse(o.gateway);
      if (!gateway.success) throw new Error(`${o.gateway} is not a machine id`);
      if (platform !== 'linux') throw new Error('archi fleet provision runs on a Linux companion, whose systemd runs the fleet');
      const t = target();
      if (!t.managed) throw new Error(`${t.home} is not a profile's home, so no unit runs it`);
      const tmuxVersion = await realRun('tmux', ['-V']).then((r) => r.stdout.trim(), () => undefined);
      let r: Awaited<ReturnType<typeof provisionFleet>>;
      try {
        r = await provision({
          ...currentRunFrom(),
          homedir: os.homedir(), prefix: DEFAULT_PREFIX, unitDir: unitDirOf(os.homedir()),
          profile: t.name, home: t.home, fleetId: fleetId.data, gatewayMachineId: gateway.data, run: realRun, tmuxVersion,
        });
      } catch (e) {
        if (!(e instanceof ProvisionRefused)) throw e;
        process.stderr.write(`archi: ${e.message}\n`);
        process.exitCode = REFUSED;
        return;
      }
      printResult(r, json(), () => `${r.home}: ${r.outcome}, run by ${r.unit}`);
    });
}
