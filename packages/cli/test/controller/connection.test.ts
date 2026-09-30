import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WebSocketServer } from 'ws';
import { FleetId, MachineId, PROTOCOL_VERSION } from '@svall/protocol';
import { AuthorityClient } from '@svall/svalld/gateway/client';
import { startAuthorityServer } from '@svall/svalld/gateway/server';
import { machineId } from '@svall/svalld/machine';
import { connectionInfoCommand } from '../../src/commands/connection.js';
import { connectFor, connectRemote, FleetMismatch, MachineMismatch, remoteConnectionInfo, resolveOwner, withReconnect, type GatewayMemo, type OwnerDeps } from '../../src/controller/connection.js';
import { MachineRegistry, type MachineEntry } from '../../src/controller/registry.js';
import { SshError, SshMaster } from '../../src/controller/ssh.js';
import { cleanHomes, makeHome, waitFor } from '../../../svalld/test/helpers.js';
import { installFakeSsh, type FakeSsh } from './fake-ssh.js';

const FLEET = FleetId.parse('11111111-2222-3333-4444-555555555555');
const REMOTE = MachineId.parse('66666666-7777-8888-9999-aaaaaaaaaaaa');
const TOKEN = 'remote-token-never-on-disk';

const description = (o: { port: number } & Partial<Record<string, unknown>>) => ({
  fleetId: FLEET, machineId: REMOTE, release: 'dev', protocol: PROTOCOL_VERSION, host: '127.0.0.1', token: TOKEN, ...o,
});

describe('remote connections', () => {
  let ssh: FakeSsh;
  let home: string;
  let registry: MachineRegistry;
  let remote: MachineEntry;

  beforeEach(() => {
    ssh = installFakeSsh();
    home = makeHome();
    fs.writeFileSync(path.join(home, 'fleet.json'), JSON.stringify({ id: FLEET }));
    registry = MachineRegistry.load(path.join(ssh.dir, 'config'));
    remote = registry.add({
      name: 'trift', ssh: 'trift.test', platform: 'linux', arch: 'arm64',
      home: '/home/linus', svallBase: '/home/linus/.local/share/svall', gateway: false,
    }, REMOTE);
  });

  afterEach(async () => {
    for (const m of opened.splice(0)) await m.close().catch(() => undefined);
    ssh.clean();
    cleanHomes();
  });

  const opened: SshMaster[] = [];
  const master = async (): Promise<SshMaster> => {
    const m = await SshMaster.open({ destination: 'trift.test', socketDir: ssh.socketDir });
    opened.push(m);
    return m;
  };
  const control = (op: string) => ssh.calls().filter((c) => c.includes('-O') && c[c.indexOf('-O') + 1] === op);

  it('asks the companion by its absolute path and reads the description back', async () => {
    ssh.answer(description({ port: 4711 }));
    const info = await remoteConnectionInfo(await master(), remote, { fleetId: FLEET, profile: 'private' });
    expect(info.port).toBe(4711);
    expect(info.token).toBe(TOKEN);
    const call = ssh.calls().at(-1) as string[];
    // the only `--` ends ssh's own options; everything after the destination is the far shell's line
    expect(call.slice(call.indexOf('--'))).toEqual(['--', 'svall-remote.invalid',
      "'/home/linus/.local/share/svall/current/bin/svall'", 'connection-info', '--json', '-p', "'private'"]);
    expect(ssh.remoteCalls().at(-1)).toEqual(['/home/linus/.local/share/svall/current/bin/svall', 'connection-info', '--json', '-p', 'private']);
  });

  it('quotes a base the far shell would otherwise read as more than one word', async () => {
    ssh.answer(description({ port: 4711 }));
    const svallBase = "/home/li nus/it's; touch /tmp/pwned";
    const entry = { ...remote, record: { ...remote.record, svallBase } };
    await remoteConnectionInfo(await master(), entry, { fleetId: FLEET, profile: 'private' });
    const words = ssh.remoteCalls().at(-1) as string[];
    expect(words[0]).toBe(`${svallBase}/current/bin/svall`);
    expect(words).toEqual([words[0], 'connection-info', '--json', '-p', 'private']);
  });

  it('refuses a registry base that is not an absolute path', async () => {
    const entry = { ...remote, record: { ...remote.record, svallBase: '../../etc' } };
    const err = await remoteConnectionInfo(await master(), entry, { fleetId: FLEET }).catch((e: SshError) => e);
    expect((err as SshError).message).toContain('svallBase');
    expect(ssh.remoteCalls()).toEqual([]);
  });

  it('refuses a profile that is not a profile name', async () => {
    const err = await remoteConnectionInfo(await master(), remote, { fleetId: FLEET, profile: '$(touch /tmp/pwned)' }).catch((e: SshError) => e);
    expect((err as SshError).message).toContain('profile');
    expect(ssh.remoteCalls()).toEqual([]);
  });

  it.each([
    ['fleetId', { fleetId: FleetId.parse(crypto.randomUUID()) }, 'other'],
    ['machineId', { machineId: MachineId.parse(crypto.randomUUID()) }, 'other'],
    ['protocol', { protocol: PROTOCOL_VERSION + 1 }, 'version'],
  ])('refuses a description whose %s is not this fleet\'s, without exposing the token', async (field, wrong, kind) => {
    ssh.answer(description({ port: 4711, ...wrong }));
    const err = await remoteConnectionInfo(await master(), remote, { fleetId: FLEET }).catch((e: SshError) => e);
    expect(err).toBeInstanceOf(SshError);
    expect((err as SshError).kind).toBe(kind);
    expect((err as SshError).message).toContain(field);
    expect((err as SshError).message).not.toContain(TOKEN);
  });

  it('refuses a description naming another machine as a machine mismatch, which no retry changes', async () => {
    ssh.answer(description({ port: 4711, machineId: MachineId.parse(crypto.randomUUID()) }));
    const err = await remoteConnectionInfo(await master(), remote, { fleetId: FLEET }).catch((e: SshError) => e);
    expect(err).toBeInstanceOf(MachineMismatch);
  });

  it('names host enable as the way on when the companion runs another fleet under the profile', async () => {
    const theirs = FleetId.parse(crypto.randomUUID());
    ssh.answer(description({ port: 4711, fleetId: theirs }));
    for (const [profile, flag] of [['work', 'work'], [undefined, 'private']] as const) {
      const err = await remoteConnectionInfo(await master(), remote, { fleetId: FLEET, ...(profile && { profile }) }).catch((e: SshError) => e);
      expect(err).toBeInstanceOf(FleetMismatch);
      expect((err as Error).message).toContain(`trift answered with fleetId ${theirs}, not ${FLEET}`);
      expect((err as Error).message).toContain(`\`svall host enable trift --fleet ${flag}\``);
    }
  });

  it('reads a companion whose daemon is down as daemon_down', async () => {
    const err = await remoteConnectionInfo(await master(), remote, { fleetId: FLEET }).catch((e: SshError) => e);
    expect((err as SshError).kind).toBe('daemon_down');
  });

  it('reads a companion that its master dropped mid-answer as unreachable', async () => {
    ssh.reply(['connection-info'], { code: 255 });
    const err = await remoteConnectionInfo(await master(), remote, { fleetId: FLEET }).catch((e: SshError) => e);
    expect((err as SshError).kind).toBe('unreachable');
  });

  it.each([126, 127])('reads a companion svall the far shell exits %i on as a version fault', async (code) => {
    ssh.reply(['connection-info'], { stderr: 'sh: /home/linus/.local/share/svall/current/bin/svall: not found\n', code });
    const err = await remoteConnectionInfo(await master(), remote, { fleetId: FLEET }).catch((e: SshError) => e);
    expect((err as SshError).kind).toBe('version');
  });

  it('connects a client through the forward without the token touching disk', async () => {
    const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    await new Promise((r) => wss.once('listening', r));
    const seen: string[] = [];
    wss.on('connection', (ws) => ws.on('message', (raw) => {
      seen.push(JSON.parse(raw.toString()).token);
      ws.send(JSON.stringify({ id: 0, result: { ok: true } }));
    }));
    ssh.answer(description({ port: (wss.address() as { port: number }).port }));

    const client = await connectRemote({ registry, machine: 'trift', fleetHome: home });
    expect(seen).toEqual([TOKEN]);
    expect(fs.readdirSync(home)).toEqual(['fleet.json']);
    expect(ssh.calls().flat().join(' ')).not.toContain(TOKEN);
    client.close();
    // the forward and master are let go after close() returns, and would otherwise reach the next test's ssh
    await waitFor(() => control('exit').length === 1);
    await new Promise((r) => wss.close(r));
  });

  it('lets go of its forward and its master once its client closes', async () => {
    const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    await new Promise((r) => wss.once('listening', r));
    wss.on('connection', (ws) => ws.on('message', () => ws.send(JSON.stringify({ id: 0, result: { ok: true } }))));
    ssh.answer(description({ port: (wss.address() as { port: number }).port }));

    const client = await connectRemote({ registry, machine: 'trift', fleetHome: home });
    expect(control('cancel')).toEqual([]);
    client.close();
    await waitFor(() => control('cancel').length === 1 && control('exit').length === 1);
    await new Promise((r) => wss.close(r));
  });

  it('takes its forward back when the daemon refuses the connection', async () => {
    const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    await new Promise((r) => wss.once('listening', r));
    wss.on('connection', (ws) => ws.on('message', () => ws.send(JSON.stringify({ id: 0, result: { ok: false } }))));
    ssh.answer(description({ port: (wss.address() as { port: number }).port }));

    const err = await connectRemote({ registry, machine: 'trift', fleetHome: home }).catch((e: SshError) => e);
    expect((err as SshError).message).toContain('refused the token');
    expect((err as SshError).message).not.toContain(TOKEN);
    const forwarded = ssh.calls().filter((c) => c.includes('-O') && (c.includes('forward') || c.includes('cancel')));
    expect(forwarded.map((c) => c[c.indexOf('-O') + 1])).toEqual(['forward', 'cancel']);
    await new Promise((r) => wss.close(r));
  });

  it('refuses a machine the registry has no ssh destination for', async () => {
    registry.add({
      name: 'mac', platform: 'darwin', arch: 'arm64', home: '/Users/linus',
      svallBase: '/Users/linus/.local/share/svall', gateway: false,
    });
    await expect(connectRemote({ registry, machine: 'mac', fleetHome: home })).rejects.toThrow(/no ssh destination/);
  });

  it('keeps an ungated fleet on the direct local path', async () => {
    expect(await resolveOwner(home)).toBe('local');
    await expect(connectFor({ home, host: 'local' })).rejects.toThrow(/svalld is not running/);
    expect(ssh.calls()).toEqual([]);
  });
});

describe('withReconnect', () => {
  beforeEach(() => vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] }));
  afterEach(() => vi.useRealTimers());

  it('retries a daemon that is down with a widening delay', async () => {
    let n = 0;
    const attempt = vi.fn(() => { n++; return n < 3 ? Promise.reject(new SshError('daemon_down', 'down')) : Promise.resolve('up'); });
    const running = withReconnect(attempt);
    await vi.advanceTimersByTimeAsync(999);
    expect(attempt).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(attempt).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1999);
    expect(attempt).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(await running).toBe('up');
  });

  it('gives up after five attempts', async () => {
    const attempt = vi.fn(() => Promise.reject(new SshError('unreachable', 'no route')));
    const running = withReconnect(attempt);
    const failed = expect(running).rejects.toThrow('no route');
    await vi.advanceTimersByTimeAsync(60_000);
    await failed;
    expect(attempt).toHaveBeenCalledTimes(5);
  });

  it('does not retry a key it was refused for', async () => {
    const attempt = vi.fn(() => Promise.reject(new SshError('auth', 'Permission denied')));
    await expect(withReconnect(attempt)).rejects.toThrow('Permission denied');
    expect(attempt).toHaveBeenCalledTimes(1);
  });
});

describe('svall connection-info', () => {
  let home: string;
  let out: string[];

  beforeEach(() => {
    home = makeHome();
    out = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => { out.push(String(chunk)); return true; });
  });
  afterEach(() => { vi.restoreAllMocks(); cleanHomes(); });

  const run = (json: boolean) => connectionInfoCommand(() => home, () => json).parseAsync([], { from: 'user' });

  it('describes the fleet a controller would reach', async () => {
    fs.writeFileSync(path.join(home, 'fleet.json'), JSON.stringify({ id: FLEET }));
    fs.writeFileSync(path.join(home, 'node.json'), JSON.stringify({}));
    fs.writeFileSync(path.join(home, 'port'), '4711');
    fs.writeFileSync(path.join(home, 'token'), 'local-token\n');
    await run(true);
    expect(JSON.parse(out.join(''))).toMatchObject({
      fleetId: FLEET, machineId: machineId(), protocol: PROTOCOL_VERSION, host: '127.0.0.1', port: 4711, token: 'local-token',
      // where the fleet lies here, which a controller elsewhere cannot work out for itself
      fleetHome: home,
    });
  });

  it('keeps the token out of the human reading', async () => {
    fs.writeFileSync(path.join(home, 'fleet.json'), JSON.stringify({ id: FLEET }));
    fs.writeFileSync(path.join(home, 'node.json'), JSON.stringify({}));
    fs.writeFileSync(path.join(home, 'port'), '4711');
    fs.writeFileSync(path.join(home, 'token'), 'local-token\n');
    await run(false);
    expect(out.join('')).toContain('4711');
    expect(out.join('')).not.toContain('local-token');
  });

  it('refuses when svalld is not running', async () => {
    await expect(run(true)).rejects.toThrow(/svalld is not running/);
  });

  it('carries the generation its daemon holds when the fleet has a gateway', async () => {
    const gateway = MachineId.parse('cccccccc-dddd-eeee-ffff-000000000000');
    fs.writeFileSync(path.join(home, 'fleet.json'), JSON.stringify({ id: FLEET, gatewayMachineId: gateway }));
    fs.writeFileSync(path.join(home, 'node.json'), JSON.stringify({}));
    fs.writeFileSync(path.join(home, 'port'), '4711');
    fs.writeFileSync(path.join(home, 'token'), 'local-token\n');
    fs.writeFileSync(path.join(home, 'owner.json'), JSON.stringify({ fleetId: FLEET, generation: 6, ownerMachineId: machineId() }));
    await run(true);
    expect(JSON.parse(out.join(''))).toMatchObject({ generation: 6 });
  });

  it('carries no generation for a fleet no gateway holds', async () => {
    fs.writeFileSync(path.join(home, 'fleet.json'), JSON.stringify({ id: FLEET }));
    fs.writeFileSync(path.join(home, 'node.json'), JSON.stringify({}));
    fs.writeFileSync(path.join(home, 'port'), '4711');
    fs.writeFileSync(path.join(home, 'token'), 'local-token\n');
    fs.writeFileSync(path.join(home, 'owner.json'), JSON.stringify({ fleetId: FLEET, generation: 6, ownerMachineId: machineId() }));
    await run(true);
    expect(JSON.parse(out.join(''))).not.toHaveProperty('generation');
  });

  it('reads a fleet still on config.json, and leaves splitting it to the daemon', async () => {
    const legacy = `${JSON.stringify({ id: FLEET, host: '127.0.0.1' })}\n`;
    fs.writeFileSync(path.join(home, 'config.json'), legacy);
    fs.writeFileSync(path.join(home, 'port'), '4711');
    fs.writeFileSync(path.join(home, 'token'), 'local-token\n');
    await run(true);
    expect(JSON.parse(out.join(''))).toMatchObject({ fleetId: FLEET, host: '127.0.0.1', port: 4711 });
    expect(fs.readdirSync(home).sort()).toEqual(['config.json', 'port', 'token']);
    expect(fs.readFileSync(path.join(home, 'config.json'), 'utf8')).toBe(legacy);
  });
});

describe('resolveOwner', () => {
  let ssh: FakeSsh;
  let home: string;
  let registry: MachineRegistry;
  let deps: OwnerDeps;

  const GATEWAY = MachineId.parse('cccccccc-dddd-eeee-ffff-000000000000');
  const ROUTE = () => path.join(home, 'controller', 'route.json');

  beforeEach(() => {
    ssh = installFakeSsh();
    home = makeHome();
    registry = MachineRegistry.load(path.join(ssh.dir, 'config'));
    registry.add({
      name: 'trift', ssh: 'trift.test', platform: 'linux', arch: 'arm64',
      home: '/home/linus', svallBase: '/home/linus/.local/share/svall', gateway: false,
    }, REMOTE);
    deps = {
      registry,
      openMaster: (destination) => SshMaster.open({ destination, socketDir: ssh.socketDir }),
      now: () => new Date('2026-09-22T09:00:00.000Z'),
    };
  });

  afterEach(() => { ssh.clean(); cleanHomes(); });

  const gateway = (destination: string): void => {
    registry.add({
      name: 'gate', ssh: destination, platform: 'linux', arch: 'arm64',
      home: '/home/linus', svallBase: '/home/linus/.local/share/svall', gateway: true,
    }, GATEWAY);
    fs.writeFileSync(path.join(home, 'fleet.json'), JSON.stringify({ id: FLEET, gatewayMachineId: GATEWAY }));
  };

  const answers = (frame: unknown): void => {
    ssh.reply(['gateway', 'owner', 'get'], { stdout: `${JSON.stringify(frame)}\n` });
  };
  const holds = (owner: MachineId, generation = 4): void =>
    answers({ result: { record: { fleetId: FLEET, generation, ownerMachineId: owner } } });

  const route = (owner: MachineId, generation: number): void => {
    fs.mkdirSync(path.join(home, 'controller'), { recursive: true });
    fs.writeFileSync(ROUTE(), JSON.stringify({ ownerMachineId: owner, generation, at: '2026-09-21T09:00:00.000Z' }));
  };
  const daemonOwner = (owner: MachineId, generation: number): void => {
    fs.writeFileSync(path.join(home, 'owner.json'), JSON.stringify({ fleetId: FLEET, generation, ownerMachineId: owner }));
  };

  it('reads a record naming this machine as the local route, and caches it', async () => {
    gateway('gate.test');
    holds(registry.localId, 7);
    expect(await resolveOwner(home, { deps })).toBe('local');
    expect(JSON.parse(fs.readFileSync(ROUTE(), 'utf8'))).toEqual({
      ownerMachineId: registry.localId, generation: 7, at: '2026-09-22T09:00:00.000Z',
    });
    expect(fs.statSync(ROUTE()).mode & 0o777).toBe(0o600);
  });

  it('reads a record naming another machine as that machine', async () => {
    gateway('gate.test');
    holds(REMOTE);
    expect(await resolveOwner(home, { deps })).toMatchObject({ id: REMOTE });
  });

  it('refuses a record naming a machine the registry has never heard of', async () => {
    gateway('gate.test');
    holds(MachineId.parse(crypto.randomUUID()));
    const err = await resolveOwner(home, { deps }).catch((e: SshError) => e);
    expect((err as SshError).kind).toBe('other');
    expect((err as SshError).message).toContain('registry');
  });

  it('takes a fleet the gateway has no record of as this machine\'s', async () => {
    gateway('gate.test');
    answers({ error: { code: 'not_found', message: 'no record for that fleet' } });
    expect(await resolveOwner(home, { deps })).toBe('local');
    expect(fs.existsSync(ROUTE())).toBe(false);
  });

  it('never takes the word of a gateway whose ssh destination now reaches another machine', async () => {
    gateway('gate.test');
    ssh.reply(['version', '--json'], { stdout: JSON.stringify({ release: 'dev', protocol: PROTOCOL_VERSION, machineId: REMOTE }, null, 2) });
    answers({ error: { code: 'not_found', message: 'no record for that fleet' } });
    const err = await resolveOwner(home, { deps }).catch((e: SshError) => e);
    expect(err).toBeInstanceOf(SshError);
    expect((err as SshError).message).toContain(`gate.test now reaches machine ${REMOTE}, not gate (${GATEWAY})`);
    expect(ssh.remoteCalls().some((w) => w.includes('owner'))).toBe(false);
  });

  it('reads which machine a gateway is past whatever its login shell prints first', async () => {
    gateway('gate.test');
    const shell = 'Welcome to other\n';
    ssh.reply(['version', '--json'], { stdout: `${shell}${JSON.stringify({ release: 'dev', protocol: PROTOCOL_VERSION, machineId: REMOTE }, null, 2)}\n` });
    ssh.reply(['gateway', 'owner', 'get'], { stdout: `${shell}${JSON.stringify({ error: { code: 'not_found', message: 'no record for that fleet' } })}\n` });
    const err = await resolveOwner(home, { deps }).catch((e: SshError) => e);
    expect((err as SshError).message).toContain(`gate.test now reaches machine ${REMOTE}, not gate (${GATEWAY})`);
    expect(ssh.remoteCalls().some((w) => w.includes('owner'))).toBe(false);
  });

  it('reads the machine id only where svall version --json prints it, as the daemon does, whatever a login shell quotes before it', async () => {
    gateway('gate.test');
    const banner = `motd: {"machineId": "${REMOTE}"}\n`;
    ssh.reply(['version', '--json'], { stdout: `${banner}${JSON.stringify({ release: 'dev', protocol: PROTOCOL_VERSION, machineId: GATEWAY }, null, 2)}\n` });
    holds(REMOTE);
    expect(await resolveOwner(home, { deps })).toMatchObject({ id: REMOTE });
  });

  it('takes no ownership answer from a gateway whose svall answers without naming its machine', async () => {
    gateway('gate.test');
    ssh.reply(['version', '--json'], { stdout: `${JSON.stringify({ release: 'dev', protocol: PROTOCOL_VERSION })}\n` });
    answers({ error: { code: 'not_found', message: 'no record for that fleet' } });
    const err = await resolveOwner(home, { deps }).catch((e: SshError) => e);
    expect((err as SshError).message).toContain('gate.test answered svall version --json without a machine id');
    expect(ssh.remoteCalls().some((w) => w.includes('owner'))).toBe(false);
  });

  it('passes on a corrupt authority rather than routing anywhere', async () => {
    gateway('gate.test');
    answers({ error: { code: 'authority_corrupt', message: 'owner-11111111.json is not readable' } });
    const err = await resolveOwner(home, { deps }).catch((e: SshError) => e);
    expect((err as SshError).kind).toBe('other');
    expect((err as SshError).message).toContain('owner-11111111.json is not readable');
  });

  it('falls back to a cached local route when the daemon is at the same generation', async () => {
    gateway('refused.test');
    route(registry.localId, 7);
    daemonOwner(registry.localId, 7);
    expect(await resolveOwner(home, { deps })).toBe('local');
  });

  it('refuses a cached local route the daemon has moved past', async () => {
    gateway('refused.test');
    route(registry.localId, 7);
    daemonOwner(registry.localId, 8);
    const err = await resolveOwner(home, { deps }).catch((e: SshError) => e);
    expect((err as SshError).kind).toBe('unreachable');
  });

  it('falls back to a cached remote route the far daemon still reports', async () => {
    gateway('refused.test');
    route(REMOTE, 7);
    ssh.answer(description({ port: 4711, generation: 7 }));
    expect(await resolveOwner(home, { deps })).toMatchObject({ id: REMOTE });
  });

  it('refuses a cached remote route the far daemon has moved past', async () => {
    gateway('refused.test');
    route(REMOTE, 7);
    ssh.answer(description({ port: 4711, generation: 9 }));
    const err = await resolveOwner(home, { deps }).catch((e: SshError) => e);
    expect((err as SshError).kind).toBe('unreachable');
  });

  it('refuses an unreachable gateway with nothing cached', async () => {
    gateway('refused.test');
    const err = await resolveOwner(home, { deps }).catch((e: SshError) => e);
    expect((err as SshError).kind).toBe('unreachable');
  });

  it('keeps a gateway that refused its key the reason when nothing is cached', async () => {
    gateway('denied.test');
    const err = await resolveOwner(home, { deps }).catch((e: SshError) => e);
    expect((err as SshError).kind).toBe('auth');
  });

  it('reports the cached owner\'s own failure, and the gateway\'s refusal, when neither can be read', async () => {
    gateway('denied.test');
    route(REMOTE, 7);
    const err = await resolveOwner(home, { deps }).catch((e: SshError) => e);
    expect((err as SshError).kind).toBe('daemon_down');
    expect((err as SshError).message).toContain('Permission denied');
  });

  it('asks a gateway that refused for good only once for a caller that remembers it', async () => {
    gateway('denied.test');
    route(registry.localId, 7);
    daemonOwner(registry.localId, 7);
    const refusals: unknown[] = [];
    const memo: GatewayMemo = { onRefused: (err) => { refusals.push(err); } };
    expect(await resolveOwner(home, { deps, memo })).toBe('local');
    expect(await resolveOwner(home, { deps, memo })).toBe('local');
    expect((memo.refused as SshError).kind).toBe('auth');
    expect(refusals).toHaveLength(1);
    expect(ssh.calls().filter((c) => c.includes('-M') && c.includes('denied.test'))).toHaveLength(1);
  });

  it('keeps asking a gateway that was only out of reach', async () => {
    gateway('refused.test');
    route(registry.localId, 7);
    daemonOwner(registry.localId, 7);
    const memo: GatewayMemo = {};
    await resolveOwner(home, { deps, memo });
    await resolveOwner(home, { deps, memo });
    expect(memo.refused).toBeUndefined();
    expect(ssh.calls().filter((c) => c.includes('-M') && c.includes('refused.test'))).toHaveLength(2);
  });

  it('does not take a gateway it could not spawn ssh for as refusing', async () => {
    gateway('gate.test');
    const memo: GatewayMemo = {};
    const spawnFailed = Object.assign(new Error('spawn ssh EAGAIN'), { code: 'EAGAIN' });
    const err = await resolveOwner(home, { deps: { ...deps, openMaster: () => Promise.reject(spawnFailed) }, memo }).catch((e: SshError) => e);
    expect((err as SshError).kind).toBe('unreachable');
    expect(memo.refused).toBeUndefined();
  });

  it('retries a cached owner that its master dropped mid-answer', async () => {
    gateway('refused.test');
    route(REMOTE, 7);
    ssh.reply(['connection-info'], { code: 255 });
    const err = await resolveOwner(home, { deps }).catch((e: SshError) => e);
    expect((err as SshError).kind).toBe('unreachable');
  });

  it('answers the owner the gateway named even when the route cannot be cached', async () => {
    gateway('gate.test');
    holds(REMOTE);
    fs.writeFileSync(path.join(home, 'controller'), '');
    expect(await resolveOwner(home, { deps })).toMatchObject({ id: REMOTE });
  });

  it('takes a gateway authority that is not answering on its socket as out of reach', async () => {
    gateway('gate.test');
    answers({ error: { code: 'disconnected', message: 'the gateway authority did not answer on /run/svall/authority.sock' } });
    const err = await resolveOwner(home, { deps }).catch((e: SshError) => e);
    expect((err as SshError).kind).toBe('unreachable');
    route(registry.localId, 7);
    daemonOwner(registry.localId, 7);
    expect(await resolveOwner(home, { deps })).toBe('local');
  });

  it('takes a gateway authority that timed out as out of reach', async () => {
    gateway('gate.test');
    answers({ error: { code: 'timeout', message: 'the gateway authority did not answer get within 10000ms' } });
    const err = await resolveOwner(home, { deps }).catch((e: SshError) => e);
    expect((err as SshError).kind).toBe('unreachable');
  });

  it('reads a gateway whose svall cannot be run as a version fault', async () => {
    gateway('gate.test');
    ssh.reply(['gateway', 'owner', 'get'], { stderr: 'sh: /home/linus/.local/share/svall/current/bin/svall: not found\n', code: 127 });
    const err = await resolveOwner(home, { deps }).catch((e: SshError) => e);
    expect((err as SshError).kind).toBe('version');
  });

  it('keeps a gateway that dropped the connection mid-answer unreachable', async () => {
    gateway('gate.test');
    // a mux client whose master went away exits 255 with nothing on its stderr
    ssh.reply(['gateway', 'owner', 'get'], { code: 255 });
    const err = await resolveOwner(home, { deps }).catch((e: SshError) => e);
    expect((err as SshError).kind).toBe('unreachable');
  });

  it('refuses a gateway the registry has no ssh destination for as a fault to fix', async () => {
    registry.add({
      name: 'gate', platform: 'linux', arch: 'arm64',
      home: '/home/linus', svallBase: '/home/linus/.local/share/svall', gateway: true,
    }, GATEWAY);
    fs.writeFileSync(path.join(home, 'fleet.json'), JSON.stringify({ id: FLEET, gatewayMachineId: GATEWAY }));
    const err = await resolveOwner(home, { deps }).catch((e: SshError) => e);
    expect((err as SshError).kind).toBe('other');
    expect(ssh.calls()).toEqual([]);
  });

  it('refuses a fleet.json it cannot read rather than taking the fleet for this machine\'s', async () => {
    gateway('gate.test');
    fs.writeFileSync(path.join(home, 'fleet.json'), '{ not a fleet config');
    const err = await resolveOwner(home, { deps }).catch((e: SshError) => e);
    expect((err as SshError).kind).toBe('other');
    expect((err as SshError).message).toContain('fleet.json');
    expect(ssh.calls()).toEqual([]);
  });

  it('takes a home with no fleet.json as this machine\'s', async () => {
    expect(await resolveOwner(home, { deps })).toBe('local');
  });

  it('asks the far daemon about the profile the command is for', async () => {
    gateway('refused.test');
    route(REMOTE, 7);
    ssh.answer(description({ port: 4711, generation: 7 }));
    expect(await resolveOwner(home, { deps, profile: 'work' })).toMatchObject({ id: REMOTE });
    expect(ssh.remoteCalls().at(-1)).toEqual([
      '/home/linus/.local/share/svall/current/bin/svall', 'connection-info', '--json', '-p', 'work',
    ]);
  });

  it('asks the authority on its own socket when this machine is the gateway, and ssh nothing', async () => {
    fs.writeFileSync(path.join(home, 'fleet.json'), JSON.stringify({ id: FLEET, gatewayMachineId: registry.localId }));
    const prefix = fs.mkdtempSync(path.join(ssh.dir, 'gw-'));
    const held = process.env.SVALL_GATEWAY_PREFIX;
    process.env.SVALL_GATEWAY_PREFIX = prefix;
    const server = await startAuthorityServer({ prefix });
    try {
      const client = await AuthorityClient.connect(prefix);
      await client.create({ fleetId: FLEET, initialOwnerMachineId: REMOTE });
      client.close();
      expect(await resolveOwner(home, { deps })).toMatchObject({ id: REMOTE });
      expect(ssh.calls()).toEqual([]);
      await server.close();
      // a local authority that is down is out of reach, as a far one is
      route(REMOTE, 0);
      ssh.answer(description({ port: 4711, generation: 0 }));
      expect(await resolveOwner(home, { deps })).toMatchObject({ id: REMOTE });
    } finally {
      await server.close().catch(() => undefined);
      if (held === undefined) delete process.env.SVALL_GATEWAY_PREFIX;
      else process.env.SVALL_GATEWAY_PREFIX = held;
    }
  });

  it('refuses a gateway id the registry has no machine for', async () => {
    fs.writeFileSync(path.join(home, 'fleet.json'), JSON.stringify({ id: FLEET, gatewayMachineId: GATEWAY }));
    const err = await resolveOwner(home, { deps }).catch((e: SshError) => e);
    expect((err as SshError).kind).toBe('other');
    expect(ssh.calls()).toEqual([]);
  });

  it('names the registry it set aside when the gateway it cannot find may have been in it', async () => {
    const dir = path.join(ssh.dir, 'reset');
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, 'machines.json'), '{ not json');
    const reset = MachineRegistry.load(dir, { warn: () => undefined });
    fs.writeFileSync(path.join(home, 'fleet.json'), JSON.stringify({ id: FLEET, gatewayMachineId: GATEWAY }));
    const err = await resolveOwner(home, { deps: { ...deps, registry: MachineRegistry.load(dir) } }).catch((e: SshError) => e);
    expect((err as SshError).message).toContain(`which is not a machine in the registry; the registry could not be read once and was moved to ${reset.recovered}`);
  });
});
