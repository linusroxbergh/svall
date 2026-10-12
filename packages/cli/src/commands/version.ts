import { Command } from 'commander';
import { AUTHORITY_SCHEMA_VERSION, PROTOCOL_VERSION, STATE_SCHEMA_VERSION, TRANSFER_SCHEMA_VERSION } from '@svall/protocol';
import { machineId, machineIdFailure } from '@svall/svalld/machine';
import { releaseVersion } from '@svall/svalld/release';
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

export function versionCommand(json: () => boolean): Command {
  return new Command('version')
    .description('the release, the versions a handover has to agree on, and the runtime running them')
    .action(() => {
      const v = {
        release: releaseVersion(),
        machineId: thisMachine(json()),
        protocol: PROTOCOL_VERSION,
        stateSchema: STATE_SCHEMA_VERSION,
        transferSchema: TRANSFER_SCHEMA_VERSION,
        authoritySchema: AUTHORITY_SCHEMA_VERSION,
        runtime: { node: process.version, platform: process.platform, arch: process.arch },
      };
      printResult(v, json(), () => [
        `release          ${v.release}`,
        `machine          ${v.machineId}`,
        `protocol         ${v.protocol}`,
        `state schema     ${v.stateSchema}`,
        `transfer schema  ${v.transferSchema}`,
        `authority schema ${v.authoritySchema}`,
        `runtime          node ${v.runtime.node} ${v.runtime.platform}-${v.runtime.arch}`,
      ].join('\n'));
    });
}
