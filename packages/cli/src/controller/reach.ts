import fs from 'node:fs';
import path from 'node:path';
import { AUTHORITY_SCHEMA_VERSION, FleetConfig, type FleetId, type MachineId, type MethodName } from '@svall/protocol';
import type { OwnerAnswer } from '@svall/svalld/gateway/client';
import { resolvePaths } from '@svall/svalld/paths';
import { svallExe } from '@svall/svalld/release';
import { ApiError, Client } from '../client.js';
import { localOwner, remoteOwner } from './authority.js';
import { identify, remoteConnectionInfo } from './connection.js';
import { Handover, Refused, type Daemon, type Gateway, type HandoverDeps, type Side } from './handover.js';
import { redact } from './process.js';
import { fileStore, type Route } from './recovery.js';
import { MachineRegistry, type MachineEntry } from './registry.js';
import { rememberOwner } from './route.js';
import { resolveRsync } from './rsync.js';
import { SshError, SshMaster } from './ssh.js';

const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** One ssh master a machine, opened when first needed and again once it stops answering, until `close`. */
export class Masters {
  private held = new Map<MachineId, Promise<SshMaster>>();

  async for(entry: MachineEntry): Promise<SshMaster> {
    const held = this.held.get(entry.id);
    const master = await held?.catch(() => undefined);
    if (master && await master.check().catch(() => false)) return master;
    if (held && this.held.get(entry.id) === held) this.held.delete(entry.id);
    await master?.close().catch(() => undefined);
    if (!entry.record.ssh) throw new SshError('other', `${entry.record.name} has no ssh destination in the registry`);
    const opening = SshMaster.open({ destination: entry.record.ssh });
    this.held.set(entry.id, opening);
    opening.catch(() => { if (this.held.get(entry.id) === opening) this.held.delete(entry.id); });
    return opening;
  }

  async close(): Promise<void> {
    const all = [...this.held.values()];
    this.held.clear();
    for (const m of all) await m.then((x) => x.close()).catch(() => undefined);
  }
}

/** One operation on a gateway's authority. It throws only when the gateway's machine did not answer, or answered as another. */
export type AuthorityOp = (op: string, fleetId: FleetId, params?: Record<string, unknown>) => Promise<OwnerAnswer>;

/**
 * The authority of the gateway `entry`: over its own socket on this machine, through `svall gateway owner` over the master
 * anywhere else, once that master has shown it reaches the machine the registry names and, with `schema`, that its
 * authority keeps records as this release's does.
 */
export function authorityOp(entry: MachineEntry, localId: MachineId, masters: Masters, o: { schema?: boolean } = {}): AuthorityOp {
  if (entry.id !== localId) {
    const identified = new WeakSet<SshMaster>();
    return async (op, fleetId, params) => {
      const master = await masters.for(entry);
      if (!identified.has(master)) {
        const said = await identify(master, entry);
        const schema = Number(/^\s*"authoritySchema":\s*(\d+)/m.exec(said ?? '')?.[1] ?? AUTHORITY_SCHEMA_VERSION);
        if (o.schema && schema !== AUTHORITY_SCHEMA_VERSION) {
          const name = entry.record.name;
          throw new SshError('version', `${name} runs gateway authority schema ${schema}, and this release ${AUTHORITY_SCHEMA_VERSION}; upgrade ${name} or this machine, whichever is older`);
        }
        identified.add(master);
      }
      return remoteOwner({ master, exe: svallExe(entry.record.svallBase), op, fleetId, ...(params && { params }) });
    };
  }
  return (op, fleetId, params) => localOwner(op, fleetId, params);
}

/** The gateway's compare-and-swap operations on one fleet: a refusal is an answer, an authority that went quiet is none. */
export function gatewayOf(op: AuthorityOp, fleetId: FleetId): Gateway {
  const ask = async (name: string, params?: Record<string, unknown>) => {
    const answer = await op(name, fleetId, params);
    if ('record' in answer) return answer.record;
    const { code, message, data } = answer.error;
    throw code === 'disconnected' || code === 'timeout' ? new Error(`the gateway's authority did not answer: ${message}`) : new Refused(code, message, data);
  };
  return {
    get: () => ask('get'),
    begin: (p) => ask('begin', p),
    // the manifest the controller holds is the source's proof that it froze
    ready: (p) => ask('ready', { ...p, sourceFrozen: true }),
    commit: (p) => ask('commit', p),
    abort: (p) => ask('abort', p),
    complete: (p) => ask('complete', p),
  };
}

type Reached = Pick<Client, 'call' | 'close' | 'closed'>;

/**
 * A daemon reached through a client that is opened when first needed, and again after a call whose answer never
 * came or once its socket has closed. A refusal the daemon answered is its word, and keeps the client.
 */
export function reconnecting(connect: () => Promise<Reached>, first?: Reached): Daemon & { close(): void } {
  let held: Promise<Reached> | undefined = first && Promise.resolve(first);
  // lets go the client `was` holds, and never one a concurrent call has opened since
  const drop = (was = held): void => {
    if (held === was) held = undefined;
    void was?.then((c) => c.close(), () => undefined);
  };
  const open = async (): Promise<{ was: Promise<Reached>; client: Reached }> => {
    const was = (held ??= connect());
    try { return { was, client: await was }; } catch (e) {
      if (held === was) held = undefined;
      throw e;
    }
  };
  const call = async (method: MethodName, params: unknown): Promise<unknown> => {
    let { was, client } = await open();
    // a socket that closed since the last call is let go, and this call goes on another
    if (client.closed) {
      drop(was);
      ({ was, client } = await open());
    }
    try {
      return await client.call(method, params as never);
    } catch (e) {
      // a call too large to read is refused by closing the socket, so the next call opens another
      if (!(e instanceof ApiError) || e.code === 'too_large') drop(was);
      if (e instanceof ApiError) throw new Refused(e.code, e.message, e.data);
      throw e;
    }
  };
  return { call: call as Daemon['call'], close: drop };
}

/** A daemon of this fleet as one open client, and what a far one said to reach it: its token, and where the fleet lies there. */
export type Opened = { client: Client; token?: string; fleetHome?: string };

/** This fleet's daemon on `entry`: the one here directly, another through a forward over its master, its token kept in memory. */
export async function openDaemon(entry: MachineEntry, o: { localId: MachineId; fleetHome: string; fleetId: FleetId; profile?: string; masters: Masters }): Promise<Opened> {
  if (entry.id === o.localId) return { client: await Client.connect(o.fleetHome) };
  const master = await o.masters.for(entry);
  const info = await remoteConnectionInfo(master, entry, { fleetId: o.fleetId, profile: o.profile });
  const forward = await master.forward(info.port);
  try {
    const client = await Client.connectEndpoint({ url: `ws://127.0.0.1:${forward.localPort}`, token: info.token });
    client.onClose(() => { void forward.cancel().catch(() => undefined); });
    return { client, token: info.token, ...(info.fleetHome && { fleetHome: info.fleetHome }) };
  } catch (e) {
    await forward.cancel().catch(() => undefined);
    throw new Error(`${entry.record.name}: ${redact(messageOf(e), [info.token])}`);
  }
}

export type Connected = {
  handover: Handover;
  /** the daemon tokens held, to keep out of whatever is written or printed */
  secrets(): string[];
  close(): Promise<void>;
};

/**
 * The handover of the fleet kept at `fleetHome`, as this machine's controller reaches it: its own daemon directly,
 * every other machine and the gateway over one ssh master each, with the tokens held only in memory.
 */
export function connectHandover(o: {
  fleetHome: string; profile?: string; registry?: MachineRegistry; emit?: HandoverDeps['emit']; record?: HandoverDeps['record']; decide?: HandoverDeps['decide'];
}): Connected {
  const registry = o.registry ?? MachineRegistry.load();
  const file = resolvePaths(o.fleetHome).fleetConfig;
  const fleet = FleetConfig.parse(JSON.parse(fs.readFileSync(file, 'utf8')));
  if (!fleet.gatewayMachineId) throw new Error(`${file} names no gateway, so no other machine can be handed this fleet`);
  const gateway = registry.get(fleet.gatewayMachineId);
  if (!gateway) throw new Error(`${file} names gateway ${fleet.gatewayMachineId}, which is not a machine in the registry${registry.setAside()}`);
  const masters = new Masters();
  const daemons: { close(): void }[] = [];
  const tokens: string[] = [];
  try { tokens.push(fs.readFileSync(resolvePaths(o.fleetHome).token, 'utf8').trim()); } catch { /* no daemon here, so no token to keep out */ }
  // the daemons' own rest and activation rows join the stream; where the handover stands is the controller's to say
  const relaying = <C extends Client>(client: C): C => {
    client.onEvent((e) => { if (e.event === 'handover.entity') handover.relay(e); });
    return client;
  };

  const entryOf = (id: MachineId): MachineEntry => {
    const entry = registry.get(id);
    if (!entry) throw new Error(`machine ${id} is not in the registry; add it with \`svall host add\`${registry.setAside()}`);
    return entry;
  };
  const routeOf = (entry: MachineEntry): Route => ({ machineId: entry.id, name: entry.record.name, ...(entry.record.ssh && entry.id !== registry.localId && { ssh: entry.record.ssh }) });

  const side = async (id: MachineId): Promise<Side> => {
    const entry = entryOf(id);
    const route = routeOf(entry);
    const open = async (): Promise<Opened> => {
      const opened = await openDaemon(entry, { localId: registry.localId, fleetHome: o.fleetHome, fleetId: fleet.id, profile: o.profile, masters });
      if (opened.token && !tokens.includes(opened.token)) tokens.push(opened.token);
      relaying(opened.client);
      return opened;
    };
    if (entry.id === registry.localId) {
      const daemon = reconnecting(async () => (await open()).client);
      daemons.push(daemon);
      return { route, daemon, home: entry.record.home, fleetHome: o.fleetHome };
    }
    // a far daemon is reached at once, as only its companion can say where the fleet lies there
    const first = await open();
    const daemon = reconnecting(async () => (await open()).client, first.client);
    daemons.push(daemon);
    if (!first.fleetHome) {
      daemon.close();
      throw new Error(`${entry.record.name} did not say where this fleet lies there`);
    }
    return { route, daemon, home: entry.record.home, master: () => masters.for(entry), fleetHome: first.fleetHome };
  };

  const dir = path.join(o.fleetHome, 'controller');
  const authority = gatewayOf(authorityOp(gateway, registry.localId, masters, { schema: true }), fleet.id);
  const secrets = (): string[] => tokens.filter(Boolean);
  const handover: Handover = new Handover({
    fleetId: fleet.id, store: fileStore(dir), stateDir: dir, local: registry.localId, machines: [...new Set([registry.localId, gateway.id])],
    gateway: authority, side, route: (id) => routeOf(entryOf(id)), rsync: () => resolveRsync(), emit: o.emit, record: o.record, decide: o.decide, secrets,
    moved: (record) => rememberOwner(o.fleetHome, record),
  });
  return {
    handover,
    secrets,
    close: async () => {
      for (const d of daemons) d.close();
      await masters.close();
    },
  };
}
