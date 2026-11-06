import { z } from 'zod';
import { FleetId, MachineId, MachineRecord, PROTOCOL_VERSION } from '@svall/protocol';
import { isProfileName } from '../profile.js';
import { svallExe } from '../release.js';
import { shq } from '../text.js';
import { classifyExit, SshError, type SshMaster } from './ssh.js';

/** A companion that runs another fleet under the profile asked: no retry changes that, only `svall host upgrade`. */
export class FleetMismatch extends SshError {
  constructor(message: string, readonly found: FleetId) { super('other', message); }
}

/** A far machine that answers as another than the registry names, as an ssh alias that now leads elsewhere does. */
export class MachineMismatch extends SshError {
  constructor(message: string, readonly found?: MachineId) { super('other', message); }
}

/** What a companion answers about the fleet it runs: enough to reach it, and to refuse the wrong one. */
export const ConnectionInfo = z.object({
  fleetId: FleetId,
  machineId: MachineId,
  release: z.string(),
  protocol: z.number().int(),
  host: z.string(),
  port: z.number().int().positive(),
  token: z.string().min(1),
  /** where the fleet lies on the machine that answers, which a controller elsewhere cannot work out */
  fleetHome: z.string(),
});
export type ConnectionInfo = z.infer<typeof ConnectionInfo>;

type Far = { id: MachineId; record: Pick<MachineRecord, 'name' | 'svallBase'> & { ssh?: string } };

/**
 * The far machine's connection description, checked against the machine meant and any fleet named before its token is
 * handed on. `anyProtocol` also takes a companion on another protocol, as one a rollback put on an older release is;
 * `fleetHome` names the fleet there by its folder.
 */
export async function remoteConnectionInfo(master: Pick<SshMaster, 'run'>, machine: Far, o: { fleetId?: FleetId; profile?: string; anyProtocol?: boolean; fleetHome?: string }): Promise<ConnectionInfo> {
  const name = machine.record.name;
  // the record and the flag are read again here, whatever wrote them, and everything that is not a
  // literal flag is quoted for the login shell ssh hands the command line to
  if (!MachineRecord.shape.svallBase.safeParse(machine.record.svallBase).success) {
    throw new SshError('other', `${name}: the registry's svallBase is not an absolute path`);
  }
  if (o.profile !== undefined && !isProfileName(o.profile)) {
    throw new SshError('other', `${name}: the profile ${JSON.stringify(o.profile)} is not a profile name`);
  }
  const exe = shq(svallExe(machine.record.svallBase));
  const env = o.fleetHome === undefined ? [] : ['env', shq(`SVALL_HOME=${o.fleetHome}`)];
  const r = await master.run([...env, exe, 'connection-info', '--json', ...(o.profile ? ['-p', shq(o.profile)] : [])]);
  if (r.code !== 0) {
    // an exit that is neither ssh's nor the far shell's came back from the companion
    throw new SshError(classifyExit(r, 'daemon_down'), `${name}: svall connection-info exited ${r.code}: ${r.stderr.trim().slice(0, 400)}`);
  }
  let info: ConnectionInfo;
  try {
    info = ConnectionInfo.parse(JSON.parse(r.stdout));
  } catch {
    // the answer may hold a token, so none of it is quoted back
    throw new SshError('other', `${name}: svall connection-info did not answer a connection description`);
  }
  if (o.fleetId !== undefined && info.fleetId !== o.fleetId) {
    throw new FleetMismatch(`${name} answered with fleetId ${info.fleetId}, not ${o.fleetId}: it runs another fleet there; \`svall ${o.profile ? `-p ${o.profile} ` : ''}host upgrade ${name}\` makes it this fleet's worker`, info.fleetId);
  }
  if (info.machineId !== machine.id) throw new MachineMismatch(`${name} answered with machineId ${info.machineId}, not ${machine.id}`, info.machineId);
  if (!o.anyProtocol && info.protocol !== PROTOCOL_VERSION) throw new SshError('version', `${name} answered with protocol ${info.protocol}, not ${PROTOCOL_VERSION}`);
  return info;
}
