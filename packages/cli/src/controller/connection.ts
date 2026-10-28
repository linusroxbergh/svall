import fs from 'node:fs';
import { z } from 'zod';
import { FleetId, MachineId, MachineRecord, PROTOCOL_VERSION } from '@svall/protocol';
import { peekConfig, readFleetConfig } from '@svall/svalld/config';
import { machineId, versionMachineId } from '@svall/svalld/machine';
import { resolvePaths } from '@svall/svalld/paths';
import { svalldUnitName } from '@svall/svalld/linux/setup';
import { isProfileName, profileOf } from '@svall/svalld/profile';
import { svallExe, releaseVersion } from '@svall/svalld/release';
import { shq } from '@svall/svalld/text';
import { Client } from '../client.js';
import { redact } from './process.js';
import { LOCAL, MachineRegistry, type MachineEntry } from './registry.js';
import { classifyExit, SshError, SshMaster, type SshErrorKind } from './ssh.js';

const MAX_ATTEMPTS = 5;
const FIRST_DELAY = 1000;
const MAX_DELAY = 16_000;
/** The two failures a transport comes back from on its own; every other kind waits for a person. */
const RETRIED: SshErrorKind[] = ['unreachable', 'daemon_down'];

/** A companion that runs another fleet under the profile asked: no retry changes that, only `svall host upgrade`. */
export class FleetMismatch extends SshError {
  constructor(message: string) { super('other', message); }
}

/** A far machine that answers as another than the registry names, as an ssh alias that now leads elsewhere does. */
export class MachineMismatch extends SshError {
  constructor(message: string) { super('other', message); }
}

/**
 * Refuses a far machine whose `svall version --json` names another machine id than the registry, or none, and hands back
 * its answer; one whose svall exits nonzero is left to the call that needs it.
 */
export async function identify(master: Pick<SshMaster, 'run'>, machine: MachineEntry): Promise<string | undefined> {
  const r = await master.run([shq(svallExe(machine.record.svallBase)), 'version', '--json']);
  if (r.code !== 0) return undefined;
  const where = machine.record.ssh ?? machine.record.name;
  const id = versionMachineId(r.stdout);
  if (id === undefined) throw new MachineMismatch(`${where} answered svall version --json without a machine id, so it cannot be told from another machine than ${machine.record.name} (${machine.id})`);
  if (id !== machine.id) throw new MachineMismatch(`${where} now reaches machine ${id}, not ${machine.record.name} (${machine.id})`);
  return r.stdout;
}

/** What a companion answers about the fleet it runs: enough to reach it, and to refuse the wrong one. */
const ConnectionInfo = z.object({
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
type ConnectionInfo = z.infer<typeof ConnectionInfo>;

const sleep = (ms: number): Promise<void> => new Promise((r) => { setTimeout(r, ms); });

/** What this machine's own daemon answers about the fleet it runs. */
export function localConnectionInfo(fleetHome: string, platform: NodeJS.Platform = process.platform): ConnectionInfo {
  const paths = resolvePaths(fleetHome);
  if (!fs.existsSync(paths.port) || !fs.existsSync(paths.token)) {
    // on Linux the daemon is a systemd unit, which says why it is down
    const how = platform === 'linux'
      ? `\`systemctl --user status ${svalldUnitName(profileOf(paths.home))}\` there says why, as \`svall host doctor <machine>\` does from the Mac`
      : 'Start it with `svall setup` or `pnpm svalld`';
    throw new SshError('daemon_down', `svalld is not running (no ${paths.port}). ${how}.`);
  }
  const config = peekConfig(paths);
  return {
    fleetId: config.id,
    machineId: machineId(),
    release: releaseVersion(),
    protocol: PROTOCOL_VERSION,
    host: config.host,
    port: Number(fs.readFileSync(paths.port, 'utf8')),
    token: fs.readFileSync(paths.token, 'utf8').trim(),
    fleetHome: paths.home,
  };
}

function localFleetId(fleetHome: string): FleetId {
  const file = resolvePaths(fleetHome).fleetConfig;
  try {
    return readFleetConfig({ fleetConfig: file }).id;
  } catch {
    throw new Error(`no fleet id in ${file}: there is no fleet here to reach another machine's copy of`);
  }
}

/**
 * The far machine's connection description, checked against the machine meant and any fleet named before its token is
 * handed on. `anyProtocol` also takes a companion on another protocol, as one a rollback put on an older release is.
 */
export async function remoteConnectionInfo(master: SshMaster, machine: MachineEntry, o: { fleetId?: FleetId; profile?: string; anyProtocol?: boolean }): Promise<ConnectionInfo> {
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
  const r = await master.run([exe, 'connection-info', '--json', ...(o.profile ? ['-p', shq(o.profile)] : [])]);
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
    throw new FleetMismatch(`${name} answered with fleetId ${info.fleetId}, not ${o.fleetId}: it runs another fleet there; \`svall ${o.profile ? `-p ${o.profile} ` : ''}host upgrade ${name}\` makes it this fleet's worker`);
  }
  if (info.machineId !== machine.id) throw new MachineMismatch(`${name} answered with machineId ${info.machineId}, not ${machine.id}`);
  if (!o.anyProtocol && info.protocol !== PROTOCOL_VERSION) throw new SshError('version', `${name} answered with protocol ${info.protocol}, not ${PROTOCOL_VERSION}`);
  return info;
}

/** The far daemon of `machine` over a forward on `master`, which a failed connection takes back; its error holds no token. */
export async function connectForwarded(master: SshMaster, machine: MachineEntry, o: { fleetId?: FleetId; profile?: string; anyProtocol?: boolean }) {
  const info = await remoteConnectionInfo(master, machine, o);
  const forward = await master.forward(info.port);
  try {
    return { client: await Client.connectEndpoint({ url: `ws://127.0.0.1:${forward.localPort}`, token: info.token }), info, forward };
  } catch (err) {
    // an attempt takes its forward with it, so a retry does not leave one behind on the master
    await forward.cancel().catch(() => { /* the master may be gone too */ });
    throw new Error(`${machine.record.name}: ${redact((err as Error).message, [info.token])}`);
  }
}

/** Retries a transport that may come back, and never one that will not without a person. */
export async function withReconnect<T>(attempt: () => Promise<T>): Promise<T> {
  let delay = FIRST_DELAY;
  for (let n = 1; ; n++) {
    try {
      return await attempt();
    } catch (err) {
      const kind = err instanceof SshError ? err.kind : undefined;
      if (n >= MAX_ATTEMPTS || !kind || !RETRIED.includes(kind)) throw err;
      await sleep(delay);
      delay = Math.min(delay * 2, MAX_DELAY);
    }
  }
}

/** A client on a daemon another machine runs: one control master, one forward, and a token kept in memory. */
export async function connectRemote(o: { registry: MachineRegistry; machine: string; fleetHome: string; profile?: string }): Promise<Client> {
  const machine = o.registry.get(o.machine);
  if (!machine) throw new Error(`no machine ${o.machine} in the registry${o.registry.setAside()}`);
  const destination = machine.record.ssh;
  if (!destination) throw new Error(`the machine ${machine.record.name} has no ssh destination in the registry`);
  const fleetId = localFleetId(o.fleetHome);
  return withReconnect(async () => {
    const master = await SshMaster.open({ destination });
    const { client, forward } = await connectForwarded(master, machine, { fleetId, profile: o.profile }).catch((err: Error) => {
      throw err instanceof SshError ? err : new SshError(/not reachable|did not accept/.test(err.message) ? 'daemon_down' : 'other', err.message);
    });
    client.via = machine.record.name;
    client.onClose(() => { void forward.cancel().catch(() => undefined).then(() => master.close()).catch(() => undefined); });
    return client;
  });
}

/** The client a command works through: the daemon here, or the one on the machine `host` names. */
export async function connectFor(o: { home: string; host?: string; profile?: string }): Promise<Client> {
  if (o.host === undefined || o.host === LOCAL) return Client.connect(o.home);
  return connectRemote({ registry: MachineRegistry.load(), machine: o.host, fleetHome: o.home, profile: o.profile });
}
