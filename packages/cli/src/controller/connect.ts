import net from 'node:net';
import {
  FIRST_DELAY, localConnectionInfo, localFleetId, MAX_DELAY, remoteConnectionInfo, resolveOwner, retryable, type GatewayMemo,
} from './connection.js';
import { LOCAL, type MachineEntry, type MachineRegistry } from './registry.js';
import { readRoute } from './route.js';
import { SshError, type SshMaster } from './ssh.js';

const RESOLVE_EVERY = 30_000;
const PORT_CHECK_TIMEOUT = 5000;

/** One line of what a controller is told: where the fleet is, and what happened on the way there. */
export type ConnectEvent =
  | { type: 'connecting'; owner: string }
  | { type: 'online'; host: string; port: number; token: string; remote?: { name: string; destination: string; controlSocket: string } }
  | { type: 'error'; kind: string; message: string }
  | { type: 'owner-changed'; owner: string };

export type ConnectDeps = {
  fleetHome: string;
  profile?: string;
  emit(event: ConnectEvent): void;
  /** one line for whoever reads this helper's stderr; never the token */
  log(line: string): void;
  /** read again for every resolution, so a machine added while the helper runs is found */
  loadRegistry(): MachineRegistry;
  openMaster(destination: string): Promise<SshMaster>;
  /** resolves when this helper is to let go of what it holds */
  stopped: Promise<void>;
  /** the wait before another attempt, and between re-resolutions; it returns early once stopped */
  sleep(ms: number): Promise<void>;
  now(): Date;
  resolveEveryMs?: number;
};

type Owner = typeof LOCAL | MachineEntry;
/** `current`: whether the far daemon still reports the port and token the forward was made for */
type Live = { owner: Owner; online: ConnectEvent; alive(): Promise<boolean>; current(): Promise<boolean>; close(): Promise<void> };
/** Why an online connection ended: the fleet moved, the transport or the daemon at its end went, or the owner could not be vouched for. */
type Ended = { moved: Owner } | { dead: true } | { failed: unknown };

const nameOf = (owner: Owner): string => (owner === LOCAL ? LOCAL : owner.record.name);
const keyOf = (owner: Owner): string => (owner === LOCAL ? LOCAL : owner.id);

const failed = (err: unknown): ConnectEvent => ({
  type: 'error',
  kind: err instanceof SshError ? err.kind : 'other',
  message: (err as Error).message,
});

/** Who an attempt is announced as before the owner is known: what we last knew, else the cached route. */
function announce(d: ConnectDeps, last: Owner | undefined): string {
  if (last) return nameOf(last);
  const route = readRoute(d.fleetHome);
  if (!route) return LOCAL;
  const registry = d.loadRegistry();
  if (route.ownerMachineId === registry.localId) return LOCAL;
  return registry.get(route.ownerMachineId)?.record.name ?? LOCAL;
}

/** Whether something still listens on a local port: a forward can go while its master lives. */
function accepts(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect(port, '127.0.0.1');
    const done = (ok: boolean): void => { socket.destroy(); resolve(ok); };
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
    socket.setTimeout(PORT_CHECK_TIMEOUT, () => done(false));
  });
}

// ssh that could not even be spawned, or a pipe that broke under it, is the transport's to come back from
const transport = (err: unknown, name: string): unknown =>
  (!(err instanceof SshError) && typeof (err as NodeJS.ErrnoException).code === 'string'
    ? new SshError('unreachable', `${name}: ${(err as Error).message}`)
    : err);

/** The daemon here, or a master and a forward onto the one the owning machine runs. */
async function goOnline(owner: Owner, d: ConnectDeps): Promise<Live> {
  if (owner === LOCAL) {
    const info = localConnectionInfo(d.fleetHome);
    return {
      owner,
      online: { type: 'online', host: info.host, port: info.port, token: info.token },
      alive: () => Promise.resolve(true),
      current: () => Promise.resolve(true),
      close: () => Promise.resolve(),
    };
  }
  const destination = owner.record.ssh;
  if (!destination) throw new SshError('other', `the machine ${owner.record.name} has no ssh destination in the registry`);
  const master = await d.openMaster(destination).catch((err: unknown) => { throw transport(err, owner.record.name); });
  try {
    const ask = { fleetId: localFleetId(d.fleetHome), profile: d.profile };
    const info = await remoteConnectionInfo(master, owner, ask);
    const forward = await master.forward(info.port);
    return {
      owner,
      online: {
        type: 'online', host: '127.0.0.1', port: forward.localPort, token: info.token,
        remote: { name: owner.record.name, destination, controlSocket: master.socket },
      },
      // a check that could not even be spawned says nothing about the master
      alive: async () => (await master.check().catch(() => true)) && accepts(forward.localPort),
      // a daemon its unit restarted may listen on another port, as a named fleet's port 0 does, or hold another token
      current: async () => {
        const now = await remoteConnectionInfo(master, owner, ask).catch((err: unknown) => { throw transport(err, owner.record.name); });
        return now.port === info.port && now.token === info.token;
      },
      close: async () => {
        await forward.cancel().catch(() => undefined);
        await master.close().catch(() => undefined);
      },
    };
  } catch (err) {
    await master.close().catch(() => undefined);
    throw transport(err, owner.record.name);
  }
}

/**
 * Holds an online connection until the fleet moves, the master under it dies, the daemon it reaches
 * moves to another port or token, its owner can no longer be vouched for, or the helper is let go.
 */
async function hold(live: Live, d: ConnectDeps, resolve: () => Promise<Owner>, state: { stopped: boolean }): Promise<Ended | undefined> {
  while (!state.stopped) {
    await d.sleep(d.resolveEveryMs ?? RESOLVE_EVERY);
    if (state.stopped) return undefined;
    if (!(await live.alive())) return { dead: true };
    try {
      const owner = await resolve();
      if (keyOf(owner) !== keyOf(live.owner)) return { moved: owner };
      if (!(await live.current())) return { dead: true };
    } catch (err) {
      // a failure a transport comes back from leaves the connection in hand alone
      if (retryable(err)) continue;
      return { failed: err };
    }
  }
  return undefined;
}

/**
 * Holds the connection to whichever machine owns this fleet, reporting every step, until its caller
 * lets go. An owner that cannot be reached is tried again for as long as the failure is one a
 * transport comes back from, and the helper idles once it is not.
 */
export async function runConnect(d: ConnectDeps): Promise<number> {
  const state = { stopped: false };
  void d.stopped.then(() => { state.stopped = true; });
  const memo: GatewayMemo = {
    onRefused: (err) => { d.log(`the gateway refused, so it is not asked again and only the cached route is followed: ${err.message}`); },
  };
  const resolve = (): Promise<Owner> => resolveOwner(d.fleetHome, {
    profile: d.profile, memo, deps: { registry: d.loadRegistry(), openMaster: d.openMaster, now: d.now },
  });
  const idle = async (): Promise<number> => { await d.stopped; return 0; };
  let delay = FIRST_DELAY;
  let next: Owner | undefined;
  let last: Owner | undefined;
  // the owner the controller was last told holds the fleet, by `online` or `owner-changed`
  let told: Owner | undefined;

  while (!state.stopped) {
    const expected = next ? nameOf(next) : announce(d, last);
    d.emit({ type: 'connecting', owner: expected });

    let owner: Owner;
    if (next) {
      owner = next;
      next = undefined;
    } else {
      try {
        owner = await resolve();
      } catch (err) {
        d.emit(failed(err));
        if (!retryable(err)) return await idle();
        delay = await wait(d, delay);
        continue;
      }
      const moved = told !== undefined && keyOf(owner) !== keyOf(told);
      if (moved) {
        d.emit({ type: 'owner-changed', owner: nameOf(owner) });
        told = owner;
      }
      // the attempt was announced as a guess; this is the machine it turned out to be for
      if (moved || nameOf(owner) !== expected) d.emit({ type: 'connecting', owner: nameOf(owner) });
    }
    last = owner;
    if (state.stopped) break;

    let live: Live;
    try {
      live = await goOnline(owner, d);
    } catch (err) {
      d.emit(failed(err));
      if (!retryable(err)) return await idle();
      delay = await wait(d, delay);
      continue;
    }
    d.emit(live.online);
    told = owner;
    delay = FIRST_DELAY;

    const ended = await hold(live, d, resolve, state);
    await live.close();
    if (ended && 'failed' in ended) {
      d.emit(failed(ended.failed));
      return await idle();
    }
    if (ended && 'moved' in ended) {
      d.emit({ type: 'owner-changed', owner: nameOf(ended.moved) });
      told = ended.moved;
      next = ended.moved;
    }
  }
  return 0;
}

async function wait(d: ConnectDeps, delay: number): Promise<number> {
  await d.sleep(delay);
  return Math.min(delay * 2, MAX_DELAY);
}
