import fs from 'node:fs';
import { z } from 'zod';
import { FleetConfig, FleetId, MachineId, MachineRecord, PROTOCOL_VERSION } from '@svall/protocol';
import { peekConfig } from '@svall/svalld/config';
import { versionMachineId, type OwnerAnswer } from '@svall/svalld/gateway/client';
import { machineId } from '@svall/svalld/machine';
import { resolvePaths } from '@svall/svalld/paths';
import { isProfileName, PRIVATE } from '@svall/svalld/profile';
import { svallExe, releaseVersion } from '@svall/svalld/release';
import { shq } from '@svall/svalld/text';
import { Client } from '../client.js';
import { localOwner, remoteOwner } from './authority.js';
import { redact } from './process.js';
import { LOCAL, MachineRegistry, type MachineEntry } from './registry.js';
import { cachedOwner, readRoute, writeRoute } from './route.js';
import { classifyExit, SshError, SshMaster, type SshErrorKind } from './ssh.js';

const MAX_ATTEMPTS = 5;
export const FIRST_DELAY = 1000;
export const MAX_DELAY = 16_000;
/** The two failures a transport comes back from on its own; every other kind waits for a person. */
const RETRIED: SshErrorKind[] = ['unreachable', 'daemon_down'];

export const retryable = (err: unknown): boolean => err instanceof SshError && RETRIED.includes(err.kind);

/** A companion that runs another fleet under the profile asked: no retry changes that, only `svall host enable`. */
export class FleetMismatch extends SshError {
  constructor(message: string) { super('other', message); }
}

/** A far machine that answers as another than the registry names, as an ssh alias that now leads elsewhere does. */
export class MachineMismatch extends SshError {
  constructor(message: string) { super('other', message); }
}

/**
 * Refuses a far machine whose `svall version --json` names another machine id than the registry does, or answers
 * without naming one, whatever its login shell printed around it, and hands back what it answered. One whose svall exits
 * without an answer is left to the call that needs it, which fails on its own.
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
  /** the generation of the owner record this daemon holds; a fleet no gateway holds has none */
  generation: z.number().int().nonnegative().optional(),
  /** where the fleet lies on the machine that answers, which a controller elsewhere cannot work out */
  fleetHome: z.string().optional(),
});
type ConnectionInfo = z.infer<typeof ConnectionInfo>;

const sleep = (ms: number): Promise<void> => new Promise((r) => { setTimeout(r, ms); });

/** What this machine's own daemon answers about the fleet it runs. */
export function localConnectionInfo(fleetHome: string): ConnectionInfo {
  const paths = resolvePaths(fleetHome);
  if (!fs.existsSync(paths.port) || !fs.existsSync(paths.token)) {
    throw new SshError('daemon_down', `svalld is not running (no ${paths.port}). Start it with \`svall setup\` or \`pnpm svalld\`.`);
  }
  const config = peekConfig(paths);
  // without a gateway no record but this machine's own can exist, so there is no generation to report
  const generation = config.gatewayMachineId ? cachedOwner(fleetHome)?.generation : undefined;
  return {
    fleetId: config.id,
    machineId: machineId(),
    release: releaseVersion(),
    protocol: PROTOCOL_VERSION,
    host: config.host,
    port: Number(fs.readFileSync(paths.port, 'utf8')),
    token: fs.readFileSync(paths.token, 'utf8').trim(),
    ...(generation === undefined ? {} : { generation }),
    fleetHome: paths.home,
  };
}

export function localFleetId(fleetHome: string): FleetId {
  const file = resolvePaths(fleetHome).fleetConfig;
  try {
    return FleetId.parse((JSON.parse(fs.readFileSync(file, 'utf8')) as { id: unknown }).id);
  } catch {
    throw new Error(`no fleet id in ${file}: there is no fleet here to reach another machine's copy of`);
  }
}

/**
 * The far machine's connection description, checked against the machine this controller meant to
 * reach, and against a fleet when one is named, before its token is handed on. `anyProtocol` takes a
 * companion on another protocol too, as one a rollback put back on an older release is.
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
    throw new FleetMismatch(`${name} answered with fleetId ${info.fleetId}, not ${o.fleetId}: it runs another fleet there; \`svall host enable ${name} --fleet ${o.profile ?? PRIVATE}\` gives it a copy of this one`);
  }
  if (info.machineId !== machine.id) throw new MachineMismatch(`${name} answered with machineId ${info.machineId}, not ${machine.id}`);
  if (!o.anyProtocol && info.protocol !== PROTOCOL_VERSION) throw new SshError('version', `${name} answered with protocol ${info.protocol}, not ${PROTOCOL_VERSION}`);
  return info;
}

/** Retries a transport that may come back, and never one that will not without a person. */
export async function withReconnect<T>(attempt: () => Promise<T>, o: { attempts?: number } = {}): Promise<T> {
  const attempts = o.attempts ?? MAX_ATTEMPTS;
  let delay = FIRST_DELAY;
  for (let n = 1; ; n++) {
    try {
      return await attempt();
    } catch (err) {
      const kind = err instanceof SshError ? err.kind : undefined;
      if (n >= attempts || !kind || !RETRIED.includes(kind)) throw err;
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
    const info = await remoteConnectionInfo(master, machine, { fleetId, profile: o.profile });
    const forward = await master.forward(info.port);
    try {
      const client = await Client.connectEndpoint({ url: `ws://127.0.0.1:${forward.localPort}`, token: info.token });
      client.via = machine.record.name;
      client.onClose(() => { void forward.cancel().catch(() => undefined).then(() => master.close()).catch(() => undefined); });
      return client;
    } catch (err) {
      // an attempt takes its forward with it, so a retry does not leave one behind on the master
      await forward.cancel().catch(() => { /* the master may be gone too */ });
      const message = redact((err as Error).message, [info.token]);
      throw new SshError(/not reachable|did not accept/.test(message) ? 'daemon_down' : 'other', `${machine.record.name}: ${message}`);
    }
  });
}

/** What owner resolution reaches the world through, so a test can answer for it. */
export type OwnerDeps = {
  registry: MachineRegistry;
  openMaster(destination: string): Promise<SshMaster>;
  now(): Date;
};

const realOwnerDeps = (): OwnerDeps => ({
  registry: MachineRegistry.load(),
  openMaster: (destination) => SshMaster.open({ destination }),
  now: () => new Date(),
});

/** No fleet.json is a machine with no fleet to route; one that will not parse is a fleet to leave alone. */
function fleetConfig(fleetHome: string): FleetConfig | undefined {
  const file = resolvePaths(fleetHome).fleetConfig;
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw new SshError('other', `${file} could not be read: ${(err as Error).message}`);
  }
  try {
    return FleetConfig.parse(JSON.parse(text));
  } catch (err) {
    throw new SshError('other', `${file} is not a fleet config, so which machine owns this fleet cannot be read: ${(err as Error).message}`);
  }
}

/**
 * One `owner get` on the gateway: over its own socket when this machine is the gateway, else over ssh. It throws where no
 * ownership frame came back, or where the authority behind it is down.
 */
async function askGateway(fleetId: FleetId, gateway: MachineEntry, d: OwnerDeps): Promise<OwnerAnswer> {
  const answer = gateway.id === d.registry.localId ? await localOwner('get', fleetId) : await overSsh(fleetId, gateway, d);
  // the authority's own socket went quiet or away: the gateway machine is up, its authority may come back
  if ('error' in answer && (answer.error.code === 'disconnected' || answer.error.code === 'timeout')) {
    throw new SshError('unreachable', `${gateway.record.name}: ${answer.error.message}`);
  }
  return answer;
}

async function overSsh(fleetId: FleetId, gateway: MachineEntry, d: OwnerDeps): Promise<OwnerAnswer> {
  const destination = gateway.record.ssh;
  if (!destination) throw new SshError('other', `the gateway ${gateway.record.name} has no ssh destination in the registry`);
  const master = await d.openMaster(destination);
  try {
    await identify(master, gateway);
    return await remoteOwner({ master, exe: svallExe(gateway.record.svallBase), op: 'get', fleetId });
  } finally {
    await master.close().catch(() => undefined);
  }
}

/**
 * The route the gateway last answered, good only while the daemon it names is still at that
 * generation: an owner that has moved on since is exactly what a stale route would route into.
 */
async function fromCachedRoute(fleetHome: string, o: { fleetId: FleetId; profile?: string }, d: OwnerDeps, cause: unknown): Promise<typeof LOCAL | MachineEntry> {
  // a gateway that refused for good stays the reason wherever the route cannot stand in for it; any
  // other failure, an ssh that could not even be spawned included, is one a later attempt can get past
  const kind: SshErrorKind = cause instanceof SshError && !RETRIED.includes(cause.kind) ? cause.kind : 'unreachable';
  const why = (detail: string, k = kind): SshError =>
    new SshError(k, `the gateway did not answer (${(cause as Error).message}), and ${detail}`);
  const route = readRoute(fleetHome);
  if (!route) throw why('no route from an earlier answer was cached here');
  if (route.ownerMachineId === d.registry.localId) {
    const held = cachedOwner(fleetHome)?.generation;
    if (held === route.generation) return LOCAL;
    throw why(`this machine holds generation ${held ?? 'none'}, not the cached route's ${route.generation}`);
  }
  const entry = d.registry.get(route.ownerMachineId);
  if (!entry?.record.ssh) throw why(`the cached route names ${route.ownerMachineId}, which is no machine this controller can reach`);
  let generation: number | undefined;
  try {
    const master = await d.openMaster(entry.record.ssh);
    try {
      ({ generation } = await remoteConnectionInfo(master, entry, { fleetId: o.fleetId, profile: o.profile }));
    } finally {
      await master.close().catch(() => undefined);
    }
  } catch (err) {
    // whether another attempt can help is the cached owner's to say
    throw why(`${entry.record.name} could not be asked about the cached route either: ${(err as Error).message}`, err instanceof SshError ? err.kind : 'unreachable');
  }
  if (generation !== route.generation) {
    throw why(`${entry.record.name} holds generation ${generation ?? 'none'}, not the cached route's ${route.generation}`);
  }
  return entry;
}

/**
 * What a caller that resolves again and again keeps between calls: once the gateway has failed for a
 * reason no retry fixes, it is not asked again, and only the cached route is checked.
 */
export type GatewayMemo = { refused?: Error; onRefused?(err: Error): void };

/** Which machine runs this fleet: what its gateway holds, or the route it last answered. */
export async function resolveOwner(fleetHome: string, o: { profile?: string; deps?: OwnerDeps; memo?: GatewayMemo } = {}): Promise<typeof LOCAL | MachineEntry> {
  const config = fleetConfig(fleetHome);
  const gatewayId = config?.gatewayMachineId;
  if (!config || !gatewayId) return LOCAL;
  const d = o.deps ?? realOwnerDeps();
  const gateway = d.registry.get(gatewayId);
  if (!gateway) throw new SshError('other', `${resolvePaths(fleetHome).fleetConfig} names gateway ${gatewayId}, which is not a machine in the registry${d.registry.setAside()}`);

  const cached = { fleetId: config.id, profile: o.profile };
  if (o.memo?.refused) return await fromCachedRoute(fleetHome, cached, d, o.memo.refused);
  let answer: OwnerAnswer;
  try {
    answer = await askGateway(config.id, gateway, d);
  } catch (err) {
    if (o.memo && err instanceof SshError && !retryable(err)) {
      o.memo.refused = err as Error;
      o.memo.onRefused?.(err as Error);
    }
    return await fromCachedRoute(fleetHome, cached, d, err);
  }
  if ('error' in answer) {
    // a fleet the gateway has no record of has never been handed anywhere
    if (answer.error.code === 'not_found') return LOCAL;
    throw new SshError('other', `${gateway.record.name} would not name this fleet's owner: ${answer.error.message}`);
  }
  const { ownerMachineId, generation } = answer.record;
  try {
    writeRoute(fleetHome, { ownerMachineId, generation, at: d.now().toISOString() });
  } catch {
    // the cache only stands in while the gateway cannot answer, so failing to keep it takes nothing from this answer
  }
  if (ownerMachineId === d.registry.localId) return LOCAL;
  const owner = d.registry.get(ownerMachineId);
  if (!owner) throw new SshError('other', `${gateway.record.name} holds this fleet for ${ownerMachineId}, which is not a machine in the registry; add it with \`svall host add\`${d.registry.setAside()}`);
  return owner;
}

/** The client a command works through: the daemon here, or the one on the machine that owns the fleet. */
export async function connectFor(o: { home: string; host?: string; profile?: string }): Promise<Client> {
  const owner = o.host === undefined ? await resolveOwner(o.home, { profile: o.profile }) : o.host;
  if (owner === LOCAL) return Client.connect(o.home);
  return connectRemote({
    registry: MachineRegistry.load(),
    machine: typeof owner === 'string' ? owner : owner.id,
    fleetHome: o.home,
    profile: o.profile,
  });
}
