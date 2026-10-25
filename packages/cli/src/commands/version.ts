import { Command } from 'commander';
import { AUTHORITY_SCHEMA_VERSION, PROTOCOL_VERSION, STATE_SCHEMA_VERSION, TRANSFER_SCHEMA_VERSION } from '@svall/protocol';
import { machineId, machineIdFailure } from '@svall/svalld/machine';
import { resolvePaths } from '@svall/svalld/paths';
import { releaseSigned, releaseVersion } from '@svall/svalld/release';
import { isWorker } from '@svall/svalld/worker/mode';
import { printResult } from '../format.js';

// a controller registers a far machine by the id its --json names, so only the human view goes on without one
function thisMachine(json: boolean): string {
  try {
    return machineId();
  } catch (e) {
    if (json) throw new Error(machineIdFailure(e), { cause: e });
    return `unknown: ${machineIdFailure(e)}`;
  }
}

/** `worker`: the fleet `home` names serves a home's fleet, as worker.json there says. */
export function versionCommand(json: () => boolean, home: () => string): Command {
  return new Command('version')
    .description('the release, the versions a handover has to agree on, and the runtime running them')
    .action(() => {
      const v = {
        release: releaseVersion(),
        signed: releaseSigned(),
        machineId: thisMachine(json()),
        protocol: PROTOCOL_VERSION,
        stateSchema: STATE_SCHEMA_VERSION,
        transferSchema: TRANSFER_SCHEMA_VERSION,
        authoritySchema: AUTHORITY_SCHEMA_VERSION,
        runtime: { node: process.version, platform: process.platform, arch: process.arch },
        ...(isWorker(resolvePaths(home())) && { worker: true as const }),
      };
      printResult(v, json(), () => [
        `release          ${v.release} (${v.signed ? 'signed' : 'unsigned'})`,
        `machine          ${v.machineId}`,
        `protocol         ${v.protocol}`,
        `state schema     ${v.stateSchema}`,
        `transfer schema  ${v.transferSchema}`,
        `authority schema ${v.authoritySchema}`,
        `runtime          node ${v.runtime.node} ${v.runtime.platform}-${v.runtime.arch}`,
      ].join('\n'));
    });
}
