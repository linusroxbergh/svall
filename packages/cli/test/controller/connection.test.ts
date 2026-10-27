import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WebSocketServer } from 'ws';
import { FleetId, MachineId, PROTOCOL_VERSION } from '@svall/protocol';
import { machineId } from '@svall/svalld/machine';
import { connectionInfoCommand } from '../../src/commands/connection.js';
import { connectFor, connectRemote, FleetMismatch, localConnectionInfo, MachineMismatch, remoteConnectionInfo, withReconnect } from '../../src/controller/connection.js';
import { MachineRegistry, type MachineEntry } from '../../src/controller/registry.js';
import { SshError, SshMaster } from '../../src/controller/ssh.js';
import { cleanHomes, makeHome, waitFor } from '../../../svalld/test/helpers.js';
import { installFakeSsh, type FakeSsh } from './fake-ssh.js';

const FLEET = FleetId.parse('11111111-2222-3333-4444-555555555555');
const REMOTE = MachineId.parse('66666666-7777-8888-9999-aaaaaaaaaaaa');
const TOKEN = 'remote-token-never-on-disk';

const description = (o: { port: number } & Partial<Record<string, unknown>>) => ({
  fleetId: FLEET, machineId: REMOTE, release: 'dev', protocol: PROTOCOL_VERSION, host: '127.0.0.1', token: TOKEN, fleetHome: '/home/linus/.svall', ...o,
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
    registry = MachineRegistry.load(path.join(ssh.dir, 'config'), { hostname: 'kolvik' });
    remote = registry.add({
      name: 'trift', ssh: 'trift.test', platform: 'linux', arch: 'arm64',
      home: '/home/linus', svallBase: '/home/linus/.local/share/svall',
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

  it('names host upgrade as the way on when the companion runs another fleet under the profile', async () => {
    const theirs = FleetId.parse(crypto.randomUUID());
    ssh.answer(description({ port: 4711, fleetId: theirs }));
    for (const [profile, flag] of [['work', '-p work '], [undefined, '']] as const) {
      const err = await remoteConnectionInfo(await master(), remote, { fleetId: FLEET, ...(profile && { profile }) }).catch((e: SshError) => e);
      expect(err).toBeInstanceOf(FleetMismatch);
      expect((err as Error).message).toContain(`trift answered with fleetId ${theirs}, not ${FLEET}`);
      expect((err as Error).message).toContain(`\`svall ${flag}host upgrade trift\` makes it this fleet's worker`);
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
      ws.send(JSON.stringify({ id: 0, result: { ok: true, protocol: PROTOCOL_VERSION } }));
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
    wss.on('connection', (ws) => ws.on('message', () => ws.send(JSON.stringify({ id: 0, result: { ok: true, protocol: PROTOCOL_VERSION } }))));
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
      svallBase: '/Users/linus/.local/share/svall',
    });
    await expect(connectRemote({ registry, machine: 'mac', fleetHome: home })).rejects.toThrow(/no ssh destination/);
  });

  it('takes --host local for this machine\'s daemon, and opens no ssh', async () => {
    await expect(connectFor({ home, host: 'local' })).rejects.toThrow(/svalld is not running/);
    expect(ssh.calls()).toEqual([]);
  });

  it("reaches this machine's daemon without --host though fleet.json names a gateway, and opens no ssh", async () => {
    fs.writeFileSync(path.join(home, 'fleet.json'), JSON.stringify({ id: FLEET, gatewayMachineId: MachineId.parse('cccccccc-dddd-eeee-ffff-000000000000') }));
    const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    await new Promise((r) => wss.once('listening', r));
    wss.on('connection', (ws) => ws.on('message', (raw) => {
      const { id } = JSON.parse(raw.toString()) as { id?: number };
      ws.send(JSON.stringify(id === undefined ? { id: 0, result: { ok: true, protocol: PROTOCOL_VERSION } } : { id, result: { machineId: machineId() } }));
    }));
    fs.writeFileSync(path.join(home, 'port'), String((wss.address() as { port: number }).port));
    fs.writeFileSync(path.join(home, 'token'), 'local-token');

    const client = await connectFor({ home });
    expect((await client.call('system.info', {})).machineId).toBe(machineId());
    expect(ssh.calls()).toEqual([]);
    client.close();
    await new Promise((r) => wss.close(r));
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

  it('names the way to start svalld on the platform it runs on', () => {
    const said = (platform: NodeJS.Platform) => { try { localConnectionInfo(home, platform); } catch (e) { return (e as Error).message; } return ''; };
    expect(said('darwin')).toContain('`svall setup`');
    expect(said('linux')).toContain(`systemctl --user status svall-svalld@${path.basename(home)}.service`);
    expect(said('linux')).toContain('`svall host doctor <machine>` does from the Mac');
    expect(said('linux')).not.toMatch(/svall setup|pnpm svalld/);
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
