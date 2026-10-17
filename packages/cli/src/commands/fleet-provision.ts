import os from 'node:os';
import { Command } from 'commander';
import { FleetId, MachineId } from '@svall/protocol';
import { ProvisionRefused, provisionFleet } from '@svall/svalld/linux/provision';
import { realRun } from '@svall/svalld/linux/service';
import { unitDirOf } from '@svall/svalld/linux/setup';
import { ownRuntime } from '@svall/svalld/runtime';
import { DEFAULT_PREFIX } from '../../../../scripts/install-release.mjs';
import { REFUSED } from '../controller/host.js';
import { printResult } from '../format.js';
import type { Target } from '../target.js';

/** `svall fleet provision`: the companion's own copy of a fleet whose gateway it is, as `svall host enable` asks for it. */
export function provisionCommand(
  target: () => Target, json: () => boolean, platform: NodeJS.Platform = process.platform, provision: typeof provisionFleet = provisionFleet,
): Command {
  return new Command('provision')
    .description('give this machine its copy of a fleet it is the gateway of; svall host enable runs it over ssh')
    .requiredOption('--id <fleet>', 'the fleet id')
    .requiredOption('--gateway <machine>', 'the id of the machine that is the fleet\'s gateway')
    .action(async (o: { id: string; gateway: string }) => {
      const fleetId = FleetId.safeParse(o.id);
      if (!fleetId.success) throw new Error(`${o.id} is not a fleet id`);
      const gateway = MachineId.safeParse(o.gateway);
      if (!gateway.success) throw new Error(`${o.gateway} is not a machine id`);
      if (platform !== 'linux') throw new Error('svall fleet provision runs on a Linux companion, whose systemd runs the fleet');
      const t = target();
      if (!t.managed) throw new Error(`${t.home} is not a profile's home, so no unit runs it`);
      let r: Awaited<ReturnType<typeof provisionFleet>>;
      try {
        r = await provision({
          runtime: ownRuntime(),
          homedir: os.homedir(), prefix: DEFAULT_PREFIX, unitDir: unitDirOf(os.homedir()),
          profile: t.name, home: t.home, fleetId: fleetId.data, gatewayMachineId: gateway.data, run: realRun,
        });
      } catch (e) {
        if (!(e instanceof ProvisionRefused)) throw e;
        process.stderr.write(`svall: ${e.message}\n`);
        process.exitCode = REFUSED;
        return;
      }
      printResult(r, json(), () => `${r.home}: ${r.outcome}, run by ${r.unit}`);
    });
}
