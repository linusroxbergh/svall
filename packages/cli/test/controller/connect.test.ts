import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FleetId, MachineId, PROTOCOL_VERSION } from '@svall/protocol';
import { runConnect, type ConnectEvent } from '../../src/controller/connect.js';
import { MachineRegistry } from '../../src/controller/registry.js';
import { runProcess } from '../../src/controller/process.js';
import { SshMaster } from '../../src/controller/ssh.js';
import { cleanHomes, makeHome, waitFor } from '../../../svalld/test/helpers.js';
import { installFakeSsh, type FakeSsh } from './fake-ssh.js';

const FLEET = FleetId.parse('11111111-2222-3333-4444-555555555555');
const REMOTE = MachineId.parse('66666666-7777-8888-9999-aaaaaaaaaaaa');
const GATEWAY = MachineId.parse('cccccccc-dddd-eeee-ffff-000000000000');
const DENIED = MachineId.parse('dddddddd-eeee-ffff-0000-111111111111');
const TOKEN = 'remote-token-never-on-disk';

const description = (o: { port: number; generation?: number }) => ({
  fleetId: FLEET, machineId: REMOTE, release: 'dev', protocol: PROTOCOL_VERSION, host: '127.0.0.1', token: TOKEN, ...o,
});

// a reconnect spawns the fake ssh some two dozen times, which a loaded machine can stretch past 5 s
describe('svall connect', { timeout: 20_000 }, () => {
  let ssh: FakeSsh;
  let home: string;
  let registry: MachineRegistry;
  let loadRegistry: () => MachineRegistry;
  // how many more times ssh cannot even be spawned for a destination
  let spawnFailures: Record<string, number>;

  beforeEach(() => {
    spawnFailures = {};
    ssh = installFakeSsh();
    home = makeHome();
    registry = MachineRegistry.load(path.join(ssh.dir, 'config'));
    loadRegistry = () => registry;
    registry.add({
      name: 'trift', ssh: 'trift.test', platform: 'linux', arch: 'arm64',
      home: '/home/linus', svallBase: '/home/linus/.local/share/svall', gateway: false,
    }, REMOTE);
    registry.add({
      name: 'gate', ssh: 'gate.test', platform: 'linux', arch: 'arm64',
      home: '/home/linus', svallBase: '/home/linus/.local/share/svall', gateway: true,
    }, GATEWAY);
    registry.add({
      name: 'denied', ssh: 'denied.test', platform: 'linux', arch: 'arm64',
      home: '/home/linus', svallBase: '/home/linus/.local/share/svall', gateway: false,
    }, DENIED);
  });

  // a case that fails before it stops its helper must not leave that helper looping on into the next
  const running: Run[] = [];
  afterEach(async () => {
    for (const run of running.splice(0)) { run.stop(); await run.code.catch(() => undefined); }
    vi.restoreAllMocks();
    ssh.clean();
    cleanHomes();
  });

  const fleet = (gated: boolean): void => {
    fs.writeFileSync(path.join(home, 'fleet.json'), JSON.stringify({ id: FLEET, ...(gated ? { gatewayMachineId: GATEWAY } : {}) }));
  };
  const gatewayAt = (destination: string): void => {
    registry.remove(GATEWAY);
    registry.add({
      name: 'gate', ssh: destination, platform: 'linux', arch: 'arm64',
      home: '/home/linus', svallBase: '/home/linus/.local/share/svall', gateway: true,
    }, GATEWAY);
  };
  const localDaemon = (): void => {
    fs.writeFileSync(path.join(home, 'node.json'), JSON.stringify({}));
    fs.writeFileSync(path.join(home, 'port'), '4711');
    fs.writeFileSync(path.join(home, 'token'), 'local-token\n');
  };
  const route = (owner: MachineId, generation: number): void => {
    fs.mkdirSync(path.join(home, 'controller'), { recursive: true });
    fs.writeFileSync(path.join(home, 'controller', 'route.json'), JSON.stringify({ ownerMachineId: owner, generation, at: '2026-09-21T09:00:00.000Z' }));
  };
  const gatewayKnocks = (): number => ssh.calls().filter((c) => c.includes('-M') && c.includes('denied.test')).length;
  const holds = (owner: MachineId): void => {
    ssh.reply(['gateway', 'owner', 'get'], {
      stdout: `${JSON.stringify({ result: { record: { fleetId: FLEET, generation: 4, ownerMachineId: owner } } })}\n`,
    });
  };

  type Run = { events: ConnectEvent[]; logs: string[]; code: Promise<number>; stop: () => void };

  function start(onEvent?: (e: ConnectEvent, stop: () => void) => void): Run {
    const events: ConnectEvent[] = [];
    const logs: string[] = [];
    let stop!: () => void;
    const stopped = new Promise<void>((resolve) => { stop = () => { resolve(); }; });
    const code = runConnect({
      fleetHome: home,
      emit: (event) => { events.push(event); onEvent?.(event, stop); },
      log: (line) => { logs.push(line); },
      loadRegistry: () => loadRegistry(),
      openMaster: (destination) => {
        if ((spawnFailures[destination] ?? 0) > 0) {
          spawnFailures[destination]--;
          return Promise.reject(Object.assign(new Error('spawn ssh EAGAIN'), { code: 'EAGAIN' }));
        }
        return SshMaster.open({ destination, socketDir: ssh.socketDir });
      },
      stopped,
      sleep: () => Promise.resolve(),
      now: () => new Date('2026-09-22T09:00:00.000Z'),
      resolveEveryMs: 0,
    });
    const run = { events, logs, code, stop };
    running.push(run);
    return run;
  }

  const stopOnOnline = (e: ConnectEvent, stop: () => void): void => { if (e.type === 'online') stop(); };
  const types = (events: ConnectEvent[]): string[] => events.map((e) => e.type);

  it('brings a local owner online and lets go when its input ends', async () => {
    fleet(false);
    localDaemon();
    const run = start(stopOnOnline);
    expect(await run.code).toBe(0);
    expect(run.events).toEqual([
      { type: 'connecting', owner: 'local' },
      { type: 'online', host: '127.0.0.1', port: 4711, token: 'local-token' },
    ]);
  });

  it('keeps retrying a local daemon that is not up', async () => {
    fleet(false);
    const run = start((e, stop) => {
      if (e.type === 'error') localDaemon();
      stopOnOnline(e, stop);
    });
    expect(await run.code).toBe(0);
    expect(types(run.events)).toEqual(['connecting', 'error', 'connecting', 'online']);
    expect(run.events[1]).toMatchObject({ kind: 'daemon_down' });
  });

  it('says once why a local owner cannot be reached and waits for its input to end', async () => {
    fleet(false);
    localDaemon();
    fs.writeFileSync(path.join(home, 'node.json'), '{ not a node config');
    const run = start();
    await waitFor(() => run.events.some((e) => e.type === 'error'));
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(types(run.events)).toEqual(['connecting', 'error']);
    expect(run.events[1]).toMatchObject({ kind: 'other' });
    run.stop();
    expect(await run.code).toBe(0);
  });

  it('forwards a remote owner and names the master a terminal can ride on', async () => {
    fleet(true);
    holds(REMOTE);
    ssh.answer(description({ port: 4711 }));
    const run = start(stopOnOnline);
    expect(await run.code).toBe(0);
    expect(types(run.events)).toEqual(['connecting', 'connecting', 'online']);
    expect(run.events[1]).toEqual({ type: 'connecting', owner: 'trift' });
    const online = run.events[2] as Extract<ConnectEvent, { type: 'online' }>;
    expect(online).toMatchObject({ type: 'online', host: '127.0.0.1', token: TOKEN, remote: { name: 'trift', destination: 'trift.test' } });
    // the port is the local end of the forward, never the port the far daemon listens on
    expect(online.port).not.toBe(4711);
    expect(online.remote?.controlSocket.startsWith(ssh.socketDir)).toBe(true);
  });

  it('keeps retrying a remote owner it could not reach, and says so each time', async () => {
    fleet(true);
    holds(REMOTE);
    const run = start((e, stop) => {
      if (e.type === 'error') ssh.answer(description({ port: 4711 }));
      stopOnOnline(e, stop);
    });
    expect(await run.code).toBe(0);
    expect(types(run.events)).toEqual(['connecting', 'connecting', 'error', 'connecting', 'online']);
    expect(run.events[2]).toMatchObject({ kind: 'daemon_down' });
  });

  it('retries a remote owner whose master dropped mid-answer', async () => {
    fleet(true);
    holds(REMOTE);
    ssh.reply(['connection-info'], { code: 255 });
    const run = start((e, stop) => {
      if (e.type === 'error') {
        ssh.clearReplies();
        holds(REMOTE);
        ssh.answer(description({ port: 4711 }));
      }
      stopOnOnline(e, stop);
    });
    expect(await run.code).toBe(0);
    expect(types(run.events)).toEqual(['connecting', 'connecting', 'error', 'connecting', 'online']);
    expect(run.events[2]).toMatchObject({ kind: 'unreachable' });
  });

  it('retries a remote owner it could not even spawn ssh for', async () => {
    fleet(true);
    holds(REMOTE);
    ssh.answer(description({ port: 4711 }));
    spawnFailures['trift.test'] = 1;
    const run = start(stopOnOnline);
    expect(await run.code).toBe(0);
    expect(types(run.events)).toEqual(['connecting', 'connecting', 'error', 'connecting', 'online']);
    expect(run.events[2]).toMatchObject({ kind: 'unreachable' });
  });

  it('rebuilds the connection when its forward is gone while the master lives', async () => {
    fleet(true);
    holds(REMOTE);
    ssh.answer(description({ port: 4711 }));
    let cut = false;
    const run = start((e, stop) => {
      if (e.type !== 'online') return;
      if (cut) { stop(); return; }
      cut = true;
      // the listener goes, as `ssh -O cancel` takes it, and the master stays up
      const spec = `127.0.0.1:${e.port}:127.0.0.1:4711`;
      void runProcess('ssh', ['-S', e.remote?.controlSocket ?? '', '-O', 'cancel', '-L', spec, '--', 'trift.test'], { timeoutMs: 5000 });
    });
    expect(await run.code).toBe(0);
    expect(types(run.events)).toEqual(['connecting', 'connecting', 'online', 'connecting', 'online']);
  });

  it('finds a gateway added to the registry after it started', async () => {
    const dir = path.join(ssh.dir, 'config-on-disk');
    const onDisk = MachineRegistry.load(dir);
    onDisk.save();
    loadRegistry = () => MachineRegistry.load(dir);
    fleet(false);
    localDaemon();
    let added = false;
    const run = start((e) => {
      if (e.type !== 'online' || added) return;
      added = true;
      // Add Machine and Make it the gateway, from the same app session
      const later = MachineRegistry.load(dir);
      later.add({
        name: 'gate', ssh: 'gate.test', platform: 'linux', arch: 'arm64',
        home: '/home/linus', svallBase: '/home/linus/.local/share/svall', gateway: true,
      }, GATEWAY);
      later.save();
      holds(later.localId);
      fleet(true);
    });
    await waitFor(() => ssh.remoteCalls().some((w) => w.includes('owner')), 10_000);
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(types(run.events)).toEqual(['connecting', 'online']);
  });

  it('announces a cached route to this machine as local', async () => {
    fleet(true);
    gatewayAt('refused.test');
    route(registry.localId, 4);
    const run = start((e, stop) => { if (e.type === 'connecting') stop(); });
    expect(await run.code).toBe(0);
    expect(run.events[0]).toEqual({ type: 'connecting', owner: 'local' });
  });

  it('keeps the connection, and keeps asking the gateway, after a tick that could not spawn ssh', async () => {
    fleet(true);
    holds(REMOTE);
    ssh.answer(description({ port: 4711 }));
    const run = start((e) => { if (e.type === 'online') spawnFailures['gate.test'] = 1; });
    const asks = (): number => ssh.remoteCalls().filter((w) => w.includes('owner')).length;
    await waitFor(() => spawnFailures['gate.test'] === 0 && asks() >= 3, 10_000);
    expect(types(run.events)).toEqual(['connecting', 'connecting', 'online']);
    expect(run.logs).toEqual([]);
  });

  it('keeps the connection when a liveness check could not spawn ssh', async () => {
    fleet(true);
    holds(REMOTE);
    ssh.answer(description({ port: 4711 }));
    const run = start((e) => {
      if (e.type === 'online') vi.spyOn(SshMaster.prototype, 'check').mockRejectedValueOnce(new Error('spawn ssh EAGAIN'));
    });
    const asks = (): number => ssh.remoteCalls().filter((w) => w.includes('owner')).length;
    await waitFor(() => asks() >= 3, 10_000);
    expect(types(run.events)).toEqual(['connecting', 'connecting', 'online']);
  });

  it('follows the fleet when the gateway names another owner', async () => {
    fleet(true);
    localDaemon();
    holds(registry.localId);
    ssh.answer(description({ port: 4711 }));
    let moved = false;
    const run = start((e, stop) => {
      if (e.type !== 'online') return;
      if (moved) { stop(); return; }
      moved = true;
      ssh.clearReplies();
      holds(REMOTE);
    });
    expect(await run.code).toBe(0);
    expect(types(run.events)).toEqual(['connecting', 'online', 'owner-changed', 'connecting', 'online']);
    expect(run.events[2]).toEqual({ type: 'owner-changed', owner: 'trift' });
    expect(run.events[4]).toMatchObject({ remote: { name: 'trift' } });
  });

  it('rebuilds the connection when the master it was holding has died', async () => {
    fleet(true);
    holds(REMOTE);
    ssh.answer(description({ port: 4711 }));
    let dropped = false;
    const run = start((e, stop) => {
      if (e.type !== 'online') return;
      if (dropped) { stop(); return; }
      dropped = true;
      ssh.dropMaster((e as Extract<ConnectEvent, { type: 'online' }>).remote?.controlSocket ?? '');
    });
    expect(await run.code).toBe(0);
    expect(types(run.events)).toEqual(['connecting', 'connecting', 'online', 'connecting', 'online']);
    expect(run.events[3]).toEqual({ type: 'connecting', owner: 'trift' });
  });

  it('says the owner changed when a dead master comes back to a fleet that moved', async () => {
    fleet(true);
    localDaemon();
    holds(REMOTE);
    ssh.answer(description({ port: 4711 }));
    let dropped = false;
    const run = start((e, stop) => {
      if (e.type !== 'online') return;
      if (dropped) { stop(); return; }
      dropped = true;
      ssh.clearReplies();
      holds(registry.localId);
      ssh.dropMaster((e as Extract<ConnectEvent, { type: 'online' }>).remote?.controlSocket ?? '');
    });
    expect(await run.code).toBe(0);
    expect(types(run.events)).toEqual(['connecting', 'connecting', 'online', 'connecting', 'owner-changed', 'connecting', 'online']);
    expect(run.events.slice(3)).toEqual([
      { type: 'connecting', owner: 'trift' },
      { type: 'owner-changed', owner: 'local' },
      { type: 'connecting', owner: 'local' },
      { type: 'online', host: '127.0.0.1', port: 4711, token: 'local-token' },
    ]);
  });

  it('says why once and waits for its input to end when no retry would help', async () => {
    fleet(true);
    holds(DENIED);
    const run = start();
    await waitFor(() => run.events.some((e) => e.type === 'error'));
    // nothing more arrives: a key that was refused is not a transport that comes back
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(types(run.events)).toEqual(['connecting', 'connecting', 'error']);
    expect(run.events[2]).toMatchObject({ kind: 'auth' });
    run.stop();
    expect(await run.code).toBe(0);
  });

  it('says once that the gateway refused its key and waits for its input to end', async () => {
    fleet(true);
    gatewayAt('denied.test');
    const run = start();
    await waitFor(() => run.events.some((e) => e.type === 'error'));
    // a retry would only knock on the gateway again with the key it refused
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(types(run.events)).toEqual(['connecting', 'error']);
    expect(run.events[1]).toMatchObject({ kind: 'auth' });
    run.stop();
    expect(await run.code).toBe(0);
  });

  it('follows only the cached route once the gateway has refused its key, and says so once', async () => {
    fleet(true);
    gatewayAt('denied.test');
    route(REMOTE, 4);
    const run = start((e, stop) => {
      if (e.type === 'error') ssh.answer(description({ port: 4711, generation: 4 }));
      stopOnOnline(e, stop);
    });
    expect(await run.code).toBe(0);
    expect(types(run.events)).toEqual(['connecting', 'error', 'connecting', 'online']);
    expect(run.events[1]).toMatchObject({ kind: 'daemon_down' });
    expect(run.events[3]).toMatchObject({ remote: { name: 'trift' } });
    expect(gatewayKnocks()).toBe(1);
    expect(run.logs).toHaveLength(1);
    expect(run.logs[0]).toContain('Permission denied');
  });

  it('catches a stale cached route on the tick once the gateway has refused its key', async () => {
    fleet(true);
    gatewayAt('denied.test');
    route(REMOTE, 4);
    ssh.answer(description({ port: 4711, generation: 4 }));
    const run = start();
    // the attempt and the forward ask once each; two more are ticks that found the route still good
    await waitFor(() => ssh.remoteCalls().filter((w) => w.includes('connection-info')).length >= 4, 15_000);
    ssh.answer(description({ port: 4711, generation: 5 }));
    await waitFor(() => run.events.some((e) => e.type === 'error'), 15_000);
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(types(run.events)).toEqual(['connecting', 'online', 'error']);
    expect(run.events[2]).toMatchObject({ kind: 'auth' });
    expect((run.events[2] as Extract<ConnectEvent, { type: 'error' }>).message).toContain('generation 5');
    expect(gatewayKnocks()).toBe(1);
    // the forward onto a machine that no longer owns the fleet is let go
    expect(ssh.calls().some((c) => c.includes('-O') && c.includes('cancel'))).toBe(true);
    run.stop();
    expect(await run.code).toBe(0);
  });

  it('says it is connecting before an attempt that cannot resolve the owner', async () => {
    fleet(true);
    gatewayAt('refused.test');
    const run = start((e, stop) => { if (e.type === 'connecting') stop(); });
    expect(await run.code).toBe(0);
    expect(run.events[0]).toEqual({ type: 'connecting', owner: 'local' });
    expect(run.events[1]).toMatchObject({ type: 'error', kind: 'unreachable' });
  });

  it('keeps the remote token off everything but the online line', async () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    fleet(true);
    holds(REMOTE);
    ssh.answer(description({ port: 4711 }));
    const run = start(stopOnOnline);
    await run.code;
    expect(JSON.stringify(run.events.filter((e) => e.type !== 'online'))).not.toContain(TOKEN);
    expect(ssh.calls().flat().join(' ')).not.toContain(TOKEN);
    expect(stderr.mock.calls.flat().join(' ')).not.toContain(TOKEN);
    const written = fs.readFileSync(path.join(home, 'controller', 'route.json'), 'utf8');
    expect(written).not.toContain(TOKEN);
  });
});
