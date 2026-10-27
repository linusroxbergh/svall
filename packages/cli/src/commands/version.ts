import { Command } from 'commander';
import { PROTOCOL_VERSION, STATE_SCHEMA_VERSION } from '@svall/protocol';
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

// the home whose fleet `home` serves as a worker
function served(home: string): { worker?: { homeMachineId: string; homeName: string; fleetId: string } } {
  const worker = attempt(() => readWorkerFile(resolvePaths(home)));
  return worker ? { worker: { homeMachineId: worker.homeMachineId, homeName: worker.homeName, fleetId: worker.fleetId } } : {};
}

export function versionCommand(json: () => boolean, home: () => string): Command {
  return new Command('version')
    .description('the release, the versions every machine of a fleet has to agree on, and the runtime running them')
    .action(() => {
      const me = thisMachine(json());
      const v = {
        release: releaseVersion(),
        signed: releaseSigned(),
        machineId: me,
        protocol: PROTOCOL_VERSION,
        stateSchema: STATE_SCHEMA_VERSION,
        runtime: { node: process.version, platform: process.platform, arch: process.arch },
        ...served(home()),
      };
      printResult(v, json(), () => [
        `release          ${v.release} (${v.signed ? 'signed' : 'unsigned'})`,
        `machine          ${v.machineId}`,
        `protocol         ${v.protocol}`,
        `state schema     ${v.stateSchema}`,
        `runtime          node ${v.runtime.node} ${v.runtime.platform}-${v.runtime.arch}`,
      ].join('\n'));
    });
}
