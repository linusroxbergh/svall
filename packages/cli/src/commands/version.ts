import fs from 'node:fs';
import { Command } from 'commander';
import { AUTHORITY_SCHEMA_VERSION, OwnerRecord, PROTOCOL_VERSION, STATE_SCHEMA_VERSION, TRANSFER_SCHEMA_VERSION } from '@svall/protocol';
import { readFleetConfig } from '@svall/svalld/config';
import { machineId, machineIdFailure } from '@svall/svalld/machine';
import { resolvePaths } from '@svall/svalld/paths';
import { releaseSigned, releaseVersion } from '@svall/svalld/release';
import { readWorkerFile } from '@svall/svalld/worker/mode';
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

const attempt = <T>(read: () => T): T | undefined => {
  try { return read(); } catch { return undefined; }
};

// worker: the home whose fleet `home` serves; handedOver: a fleet run here as its owner since a handover, where one
// no gateway holds owns itself from its first record
function served(home: string, me: string): { worker?: { homeMachineId: string; homeName: string; fleetId: string }; handedOver?: { fleetId: string } } {
  const paths = resolvePaths(home);
  const worker = attempt(() => readWorkerFile(paths));
  if (worker) return { worker: { homeMachineId: worker.homeMachineId, homeName: worker.homeName, fleetId: worker.fleetId } };
  const owner = attempt(() => OwnerRecord.parse(JSON.parse(fs.readFileSync(paths.owner, 'utf8'))));
  const gateway = attempt(() => readFleetConfig(paths).gatewayMachineId);
  return owner?.ownerMachineId === me && (owner.generation > 0 || gateway) ? { handedOver: { fleetId: owner.fleetId } } : {};
}

export function versionCommand(json: () => boolean, home: () => string): Command {
  return new Command('version')
    .description('the release, the versions a handover has to agree on, and the runtime running them')
    .action(() => {
      const me = thisMachine(json());
      const v = {
        release: releaseVersion(),
        signed: releaseSigned(),
        machineId: me,
        protocol: PROTOCOL_VERSION,
        stateSchema: STATE_SCHEMA_VERSION,
        transferSchema: TRANSFER_SCHEMA_VERSION,
        authoritySchema: AUTHORITY_SCHEMA_VERSION,
        runtime: { node: process.version, platform: process.platform, arch: process.arch },
        ...served(home(), me),
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
