import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { FleetId, MachineId } from '@archipelago/protocol';
import { gatewayPaths } from '../../src/gateway/authority.js';
import { AuthorityClient, fleetAuthority, type SshRun } from '../../src/gateway/client.js';
import { startAuthorityServer, type AuthorityServer } from '../../src/gateway/server.js';

const FLEET = '3f1a0b1c-2d3e-4f50-8617-9a0b1c2d3e4f' as FleetId;
const MAC = '42aa0b1c-2d3e-4f50-8617-9a0b1c2d3e4f' as MachineId;
const TRIFT = '9b4d0b1c-2d3e-4f50-8617-9a0b1c2d3e4f' as MachineId;
const OTHER = '1111ab1c-2d3e-4f50-8617-9a0b1c2d3e4f' as MachineId;
const DIGEST = 'a'.repeat(64);

const closers: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const close of closers.splice(0).reverse()) await close();
});

const prefix = (): string => fs.mkdtempSync(path.join(os.tmpdir(), 'archi-gateway-'));

const serve = async (dir: string, opts: Partial<Parameters<typeof startAuthorityServer>[0]> = {}): Promise<AuthorityServer> => {
  const server = await startAuthorityServer({ prefix: dir, ...opts });
  closers.push(() => server.close());
  return server;
};

const connect = async (dir: string, timeoutMs?: number): Promise<AuthorityClient> => {
  const client = await AuthorityClient.connect(dir, timeoutMs === undefined ? {} : { timeoutMs });
  closers.push(() => client.close());
  return client;
};

const raw = (socketPath: string): { socket: net.Socket; lines: string[]; closed: () => boolean } => {
  const socket = net.connect(socketPath);
  socket.setEncoding('utf8');
  const lines: string[] = [];
  let buffer = '';
  let closed = false;
  socket.on('data', (chunk: string) => {
    buffer += chunk;
    for (let nl = buffer.indexOf('\n'); nl >= 0; nl = buffer.indexOf('\n')) {
      lines.push(buffer.slice(0, nl));
      buffer = buffer.slice(nl + 1);
    }
  });
  socket.on('close', () => { closed = true; });
  socket.on('error', () => { closed = true; });
  closers.push(() => { socket.destroy(); });
  return { socket, lines, closed: () => closed };
};

const until = async (done: () => boolean, what: string): Promise<void> => {
  for (let i = 0; i < 200; i++) {
    if (done()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`timed out waiting for ${what}`);
};

const failure = async (call: Promise<unknown>): Promise<{ code: string; data?: Record<string, unknown> }> => {
  try {
    await call;
  } catch (err) {
    return err as { code: string; data?: Record<string, unknown> };
  }
  throw new Error('expected the call to be refused');
};

describe('the authority socket', () => {
  it('runs a handover end to end over the socket', async () => {
    const dir = prefix();
    await serve(dir);
    const client = await connect(dir);

    expect(await client.create({ fleetId: FLEET, initialOwnerMachineId: MAC })).toEqual({ fleetId: FLEET, generation: 0, ownerMachineId: MAC });
    const begun = await client.begin({ fleetId: FLEET, expectedGeneration: 0, fromMachineId: MAC, toMachineId: TRIFT });
    const transactionId = begun.transaction!.id;
    expect(begun.transaction).toMatchObject({ fromMachineId: MAC, toMachineId: TRIFT, phase: 'preparing' });

    const ready = await client.ready({ fleetId: FLEET, transactionId, expectedGeneration: 0, sourceFrozen: true, preparedDigest: DIGEST });
    expect(ready.transaction).toMatchObject({ phase: 'ready-to-commit', preparedDigest: DIGEST });

    const committed = await client.commit({ fleetId: FLEET, transactionId, expectedGeneration: 0 });
    expect(committed).toMatchObject({ generation: 1, ownerMachineId: TRIFT, transaction: { phase: 'committed' } });
    expect(await client.commit({ fleetId: FLEET, transactionId, expectedGeneration: 0 })).toEqual(committed);

    const done = await client.complete({ fleetId: FLEET, transactionId, generation: 1 });
    expect(done).toEqual({ fleetId: FLEET, generation: 1, ownerMachineId: TRIFT });
    expect(await client.get({ fleetId: FLEET })).toEqual(done);
  });

  it('listens on a private socket beside the records and on no port', async () => {
    const dir = prefix();
    const server = await serve(dir);
    expect(server.socketPath).toBe(gatewayPaths(dir).socket);
    expect(fs.statSync(server.socketPath).isSocket()).toBe(true);
    expect(fs.statSync(server.socketPath).mode & 0o777).toBe(0o600);
    expect(fs.statSync(gatewayPaths(dir).dir).mode & 0o777).toBe(0o700);
    expect(typeof server.address).toBe('string');
  });

  it('sends the refusal code and its detail back to the caller', async () => {
    const dir = prefix();
    await serve(dir);
    const client = await connect(dir);
    await client.create({ fleetId: FLEET, initialOwnerMachineId: MAC });

    const stale = await failure(client.begin({ fleetId: FLEET, expectedGeneration: 7, fromMachineId: MAC, toMachineId: TRIFT }));
    expect(stale.code).toBe('generation_mismatch');
    expect(stale.data).toEqual({ expected: 7, actual: 0 });

    expect((await failure(client.get({ fleetId: TRIFT as unknown as FleetId }))).code).toBe('not_found');
    expect((await failure(client.begin({ fleetId: FLEET, expectedGeneration: 0, fromMachineId: MAC, toMachineId: MAC }))).code).toBe('invalid_request');
    expect(await client.get({ fleetId: FLEET })).toMatchObject({ generation: 0 });
  });

  it('closes only the connection that sent a malformed line', async () => {
    const dir = prefix();
    const server = await serve(dir);
    const client = await connect(dir);
    await client.create({ fleetId: FLEET, initialOwnerMachineId: MAC });

    const bad = raw(server.socketPath);
    bad.socket.write('this is not json\n');
    await until(bad.closed, 'the malformed connection to close');

    const huge = raw(server.socketPath);
    huge.socket.write('x'.repeat(2 * 1024 * 1024));
    await until(huge.closed, 'the oversized line to close its connection');

    expect(await client.get({ fleetId: FLEET })).toMatchObject({ generation: 0 });
  });

  it('answers the requests on one connection in the order they arrived', async () => {
    const dir = prefix();
    const server = await serve(dir);
    const client = await connect(dir);
    await client.create({ fleetId: FLEET, initialOwnerMachineId: MAC });

    const pipe = raw(server.socketPath);
    const begin = (id: number, toMachineId: MachineId) =>
      JSON.stringify({ id, op: 'owner.begin', params: { fleetId: FLEET, expectedGeneration: 0, fromMachineId: MAC, toMachineId } });
    pipe.socket.write(`${begin(1, TRIFT)}\n${begin(2, OTHER)}\n`);
    await until(() => pipe.lines.length === 2, 'both replies');

    const frames = pipe.lines.map((l) => JSON.parse(l) as { id: number; result?: unknown; error?: { code: string } });
    expect(frames.map((f) => f.id)).toEqual([1, 2]);
    expect(frames[0].result).toBeTruthy();
    expect(frames[1].error?.code).toBe('transaction_mismatch');
  });

  it('answers with a failure, not a record, when the record cannot be written', async () => {
    const dir = prefix();
    const stages = { fsyncDir: () => { throw Object.assign(new Error('fsync refused'), { code: 'EIO' }); } };
    await serve(dir, { durable: { stages } });
    const client = await connect(dir);
    expect((await failure(client.create({ fleetId: FLEET, initialOwnerMachineId: MAC }))).code).toBe('internal');
  });

  it('takes over a socket file no listener answers, and refuses a second listener', async () => {
    const dir = prefix();
    const socketPath = gatewayPaths(dir).socket;
    fs.mkdirSync(path.dirname(socketPath), { recursive: true });
    fs.writeFileSync(socketPath, 'left behind');

    const server = await serve(dir);
    expect(fs.statSync(server.socketPath).isSocket()).toBe(true);
    await expect(startAuthorityServer({ prefix: dir })).rejects.toThrow(/already listening/);
  });

  it('gives up on a call the gateway never answers', async () => {
    const dir = prefix();
    const socketPath = gatewayPaths(dir).socket;
    fs.mkdirSync(path.dirname(socketPath), { recursive: true });
    let held: net.Socket | undefined;
    const mute = net.createServer((socket) => { held = socket; socket.on('error', () => {}); });
    await new Promise<void>((resolve) => mute.listen(socketPath, resolve));
    closers.push(() => new Promise<void>((resolve) => {
      held?.destroy();
      mute.close(() => resolve());
    }));

    const client = await connect(dir, 50);
    expect((await failure(client.get({ fleetId: FLEET }))).code).toBe('timeout');
  });
});

describe('a fleet authority as its daemon reaches it', () => {
  it("asks the authority's own socket when this machine is the gateway, and fails when nothing listens", async () => {
    const dir = prefix();
    await serve(dir);
    await (await connect(dir)).create({ fleetId: FLEET, initialOwnerMachineId: MAC });
    const here = fleetAuthority({ gatewayMachineId: TRIFT, machineId: TRIFT, prefix: dir });
    expect(await here.get(FLEET)).toEqual({ fleetId: FLEET, generation: 0, ownerMachineId: MAC });
    await expect(fleetAuthority({ gatewayMachineId: TRIFT, machineId: TRIFT, prefix: prefix() }).get(FLEET)).rejects.toThrow();
  });

  it("asks another machine's gateway over ssh by the route the registry names, and reads its answer or its refusal", async () => {
    const registry = path.join(prefix(), 'machines.json');
    fs.writeFileSync(registry, JSON.stringify({
      machines: {
        [TRIFT]: {
          name: 'trift', ssh: 'linus@trift', platform: 'linux', arch: 'x64', home: '/home/linus',
          archiBase: "/home/linus/it's here", pathRoots: { home: '/home/linus' }, gateway: true,
        },
      },
    }));
    const record = { fleetId: FLEET, generation: 3, ownerMachineId: MAC };
    const calls: string[][] = [];
    let answer = { code: 0, stdout: `noise\n${JSON.stringify({ result: { record } })}\n`, stderr: '' };
    const ssh: SshRun = async (argv) => { calls.push(argv); return answer; };
    const far = fleetAuthority({ gatewayMachineId: TRIFT, machineId: MAC, registry, ssh });

    expect(await far.get(FLEET)).toEqual(record);
    expect(calls).toEqual([[
      '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', '--', 'linus@trift',
      `'/home/linus/it'\\''s here/current/bin/archi' 'gateway' 'owner' 'get' '--fleet' '${FLEET}'`,
    ]]);

    answer = { code: 1, stdout: `${JSON.stringify({ error: { code: 'not_found', message: 'no record' } })}\n`, stderr: '' };
    expect((await failure(far.get(FLEET))).code).toBe('not_found');
    answer = { code: 255, stdout: '', stderr: 'ssh: connect to host trift port 22: Connection refused' };
    await expect(far.get(FLEET)).rejects.toThrow(/Connection refused/);
    // a frame that is no authority's answer is a refusal, never taken for silence
    answer = { code: 0, stdout: `${JSON.stringify({ result: { record: { fleetId: FLEET } } })}\n`, stderr: '' };
    expect(await failure(far.get(FLEET))).toMatchObject({ code: 'invalid_request' });
    // a registry that names no route to the gateway it is asked for is a wrong question, not a gateway away
    expect(await failure(fleetAuthority({ gatewayMachineId: OTHER, machineId: MAC, registry, ssh }).get(FLEET))).toMatchObject({ code: 'invalid_request', message: expect.stringMatching(/no ssh route/) });
    expect((await failure(fleetAuthority({ gatewayMachineId: OTHER, machineId: MAC, registry: path.join(prefix(), 'none.json'), ssh }).get(FLEET))).code).toBe('disconnected');
  });
});
