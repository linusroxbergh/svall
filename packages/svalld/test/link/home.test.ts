import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import { once } from 'node:events';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FleetId, MachineId, emptyState } from '@svall/protocol';
import { PassThrough } from 'node:stream';
import { HomeLinks, socketTransport, sshTransport, type Transport } from '../../src/link/home.js';
import { SshMaster } from '../../src/link/ssh.js';
import { HomeConnection } from '../../src/link/worker.js';
import { silentLogger, type Logger } from '../../src/log.js';
import type { MachineEntry } from '../../src/machine.js';
import { dialSocket, resolvePaths } from '../../src/paths.js';
import { dropToken, issueToken, workerProfile } from '../../src/placement/workers.js';
import { Store } from '../../src/store.js';
import { Outbox } from '../../src/worker/outbox.js';
import { cleanHomes, makeHome } from '../helpers.js';

const W = MachineId.parse(crypto.randomUUID());
const H = MachineId.parse(crypto.randomUUID());
const record = { name: 'mac', platform: 'darwin', arch: 'arm64', home: '/Users/ada', svallBase: '/Users/ada/.svall' } as const;
const dialing: MachineEntry = { id: W, record: { ...record, dial: 'worker' } };

const until = (check: () => void, timeout = 5000) => vi.waitFor(check, { timeout, interval: 25 });

const stops: (() => unknown)[] = [];
afterEach(async () => {
  for (const stop of stops.splice(0).reverse()) await stop();
  cleanHomes();
});

const errors = (): Logger & { lines: string[] } => {
  const lines: string[] = [];
  return { ...silentLogger, lines, error: (l: string) => { lines.push(l); } };
};

/** A home and a worker that dials it; `tunnel()` binds the home's socket onto the worker's link.sock, as sshd does for -R. */
async function world(o: { machines?: () => MachineEntry[]; connect?: Transport; log?: Logger; mirror?: { push: () => Promise<{ sent: number }>; settled: () => Promise<unknown> }; onEvent?: () => Promise<void>; onLink?: (live: boolean) => void; held?: () => boolean } = {}) {
  const homePaths = resolvePaths(makeHome());
  const workerPaths = resolvePaths(makeHome());
  const token = issueToken(homePaths, W);
  const home = Store.load(homePaths.state, () => {});
  const store = Store.load(workerPaths.state, () => {});
  store.update((d) => { Object.assign(d, emptyState()); });
  const outbox = Outbox.open(workerPaths);
  const worker = new HomeConnection({
    paths: workerPaths, worker: { homeMachineId: H, fleetId: FleetId.parse(crypto.randomUUID()), token, homeName: 'studio' }, me: W, store,
    outbox, log: silentLogger, release: '1.2.3', bootId: 'boot-1', handlers: {}, onLink: o.onLink,
  });
  await worker.start();
  stops.push(() => worker.stop());
  const sock = dialSocket(homePaths, W);
  // the first line the home sent through each tunnel connection
  const firsts: string[] = [];
  const tunnel = async () => {
    fs.mkdirSync(path.dirname(sock), { recursive: true, mode: 0o700 });
    const open = new Set<net.Socket>();
    const server = net.createServer((from) => {
      const to = net.connect(workerPaths.linkSock);
      for (const s of [from, to]) { open.add(s); s.on('close', () => open.delete(s)); }
      from.once('data', (c: Buffer) => firsts.push(c.toString().split('\n')[0]));
      from.pipe(to); to.pipe(from);
      from.on('error', () => to.destroy());
      to.on('error', () => from.destroy());
    });
    await new Promise<void>((r) => server.listen(sock, r));
    stops.push(() => new Promise<void>((r) => { server.close(() => r()); for (const s of open) s.destroy(); }));
    return server;
  };
  let tries = 0;
  const dialIn = socketTransport({ paths: homePaths });
  const links = new HomeLinks({
    paths: homePaths, store: home, log: o.log ?? silentLogger, release: '1.2.3', machines: o.machines ?? (() => [dialing]),
    connect: o.connect ?? (() => Promise.reject(new Error('the home never ssh-es to a worker that dials in'))),
    dialIn: (e) => { tries++; return dialIn(e); },
    onReport: () => {}, onEvent: o.onEvent ?? (async () => {}), onInventory: async () => {}, held: o.held,
    snapshot: () => ({ version: 1, state: home.state, agentHomes: { claude: '/c', codex: '/x', opencode: '/o' }, home: '/home/ada' }),
    ...(o.mirror && { mirror: o.mirror }),
  });
  stops.push(() => links.stop());
  return { homePaths, workerPaths, token, home, worker, outbox, sock, tunnel, links, firsts, tries: () => tries };
}

// a socket whose listener is gone without unlinking it, as a tunnel sshd dropped without its cancel leaves
async function staleSocket(sock: string): Promise<void> {
  fs.mkdirSync(path.dirname(sock), { recursive: true, mode: 0o700 });
  const child = spawn(process.execPath, ['-e', `require('net').createServer().listen(${JSON.stringify(sock)}, () => console.log('up'))`], { stdio: ['ignore', 'pipe', 'inherit'] });
  await once(child.stdout, 'data');
  child.kill('SIGKILL');
  await once(child, 'exit');
}

describe('the link a home dials', () => {
  afterEach(() => { vi.restoreAllMocks(); });
  const dialed = async (profile: string, profileOf?: (m: string) => string | undefined): Promise<string[]> => {
    let argv: string[] = [];
    vi.spyOn(SshMaster, 'open').mockResolvedValue({ socket: '/tmp/m', stream: (a: string[]) => { argv = a; return { stream: new PassThrough(), exited: new Promise(() => {}) }; }, close: () => Promise.resolve() } as never);
    await sshTransport({ profile, log: silentLogger, ...(profileOf && { profileOf }) })({ id: 'w1', record: { name: 'studio', ssh: 'ada@studio', svallBase: '/opt/svall' } } as never);
    return argv;
  };

  it('asks the worker for the fleet by the name it has there, or by this one\'s where none is held', async () => {
    expect(await dialed('mac2', () => 'private')).not.toContain('-p');
    expect(await dialed('private', () => 'mac2')).toEqual(expect.arrayContaining(['-p', "'mac2'"]));
    expect(await dialed('mac2', () => undefined)).toEqual(expect.arrayContaining(['-p', "'mac2'"]));
  });

  it('a token issued again keeps the name held for that worker', () => {
    const paths = resolvePaths(makeHome());
    issueToken(paths, W);
    expect(workerProfile(paths, W)).toBeUndefined();
    fs.writeFileSync(paths.workersFile, JSON.stringify({ [W]: { ...JSON.parse(fs.readFileSync(paths.workersFile, 'utf8'))[W], profile: 'private' } }));
    issueToken(paths, W);
    expect(workerProfile(paths, W)).toBe('private');
  });
});

describe('a worker that dials in', () => {
  it('links over its socket in the fleet home, greeted with the token first, and gives terminals no ssh route', async () => {
    const w = await world();
    await w.tunnel();
    w.links.start();
    await until(() => expect(w.links.for(W)?.synced && w.worker.connected()).toBe(true));
    expect(JSON.parse(w.firsts[0])).toMatchObject({ t: 'hello', token: w.token });
    expect(w.links.for(W)?.via()).toBeUndefined();
    expect(w.home.state.machines?.[W]).toMatchObject({ name: 'mac', reachable: true });
  });

  it('a barrier waits out an apply under way, past its time, and answers what came of it', async () => {
    let finish!: () => void;
    const applying = new Promise<void>((r) => { finish = r; });
    const w = await world({ onEvent: () => applying });
    await w.tunnel();
    w.links.start();
    await until(() => expect(w.links.for(W)?.synced && w.worker.connected()).toBe(true));
    w.worker.journal('mutation', { nothing: true });
    await until(() => expect(w.links.for(W)?.outboxDrained()).toBe(false));
    let said: boolean | undefined;
    const asked = w.links.barrier(W, 50).then((b) => { said = b; });
    await new Promise((r) => setTimeout(r, 250));
    expect(said).toBeUndefined();
    finish();
    await asked;
    expect(said).toBe(true);
  });

  it('while the fleet moves, leaves a change in the worker\'s outbox unacknowledged, and applies it once the move is off; a report goes on', async () => {
    let holding = false;
    const applied: string[] = [];
    const w = await world({ held: () => holding, onEvent: async () => { applied.push('mutation'); } });
    await w.tunnel();
    w.links.start();
    await until(() => expect(w.links.for(W)?.synced && w.worker.connected()).toBe(true));
    expect(await w.links.barrier(W, 2000)).toBe(true);
    holding = true;
    const acked = () => w.outbox.acked();
    w.worker.journal('robot.sync', { robotId: 'nobody', generation: 0, fields: {} }, 'nobody');
    await until(() => expect(acked()).toBe(1));
    w.worker.journal('mutation', { nothing: true });
    await new Promise((r) => setTimeout(r, 150));
    expect(applied).toEqual([]);
    expect(acked()).toBe(1);
    expect(await w.links.barrier(W, 100)).toBe(false);
    holding = false;
    w.links.released();
    await until(() => expect(applied).toEqual(['mutation']), 4000);
    await until(() => expect(acked()).toBe(2));
  });

  it('once a change is held, a report after it waits too, as acks are cumulative: acking it would take the change with it', async () => {
    let holding = false;
    const applied: string[] = [];
    const w = await world({ held: () => holding, onEvent: async () => { applied.push('mutation'); } });
    await w.tunnel();
    w.links.start();
    await until(() => expect(w.links.for(W)?.synced && w.worker.connected()).toBe(true));
    holding = true;
    w.worker.journal('mutation', { nothing: true });
    w.worker.journal('robot.sync', { robotId: 'nobody', generation: 0, fields: {} }, 'nobody');
    await new Promise((r) => setTimeout(r, 200));
    expect(applied).toEqual([]);
    expect(w.outbox.acked()).toBe(0);
    holding = false;
    w.links.released();
    await until(() => expect(w.outbox.acked()).toBe(2), 4000);
    expect(applied).toEqual(['mutation']);
  });

  it('holds its socket folder to the account alone, whatever mode it found it at', async () => {
    const w = await world();
    w.links.start();
    expect(fs.statSync(w.homePaths.dialSockets).mode & 0o777).toBe(0o700);
    w.links.stop();
    fs.chmodSync(w.homePaths.dialSockets, 0o755);
    w.links.start();
    expect(fs.statSync(w.homePaths.dialSockets).mode & 0o777).toBe(0o700);
  });

  it('is not reachable while no socket is there, tried again with backoff, and links within a second of its socket appearing', async () => {
    const log = errors();
    const w = await world({ log });
    w.links.start();
    // past the tries at 0, 1 and 3 s the next is 4 s off
    await until(() => expect(w.tries()).toBe(3), 8000);
    expect(w.home.state.machines?.[W]?.reachable).toBe(false);
    expect(log.lines).toEqual([expect.stringContaining(`mac is not reachable: mac has not dialed in (ENOENT ${w.sock}); trying again`)]);
    const at = Date.now();
    await w.tunnel();
    await until(() => expect(w.links.for(W)?.synced).toBe(true), 1500);
    expect(Date.now() - at).toBeLessThan(1500);
    expect(w.tries()).toBe(4);
  }, 15_000);

  it('keeps a socket that refuses, which sshd may have bound and not yet listen on, and links once it answers', async () => {
    const w = await world();
    await staleSocket(w.sock);
    w.links.start();
    await until(() => expect(w.tries()).toBeGreaterThanOrEqual(2));
    expect(fs.lstatSync(w.sock).isSocket()).toBe(true);
    expect(w.home.state.machines?.[W]?.reachable).toBe(false);
    fs.rmSync(w.sock);
    await w.tunnel();
    await until(() => expect(w.links.for(W)?.synced).toBe(true), 1500);
  });

  it('gives up on a stream only an old listener took once its socket appears, as after a wake, and links at once', async () => {
    const w = await world();
    fs.mkdirSync(path.dirname(w.sock), { recursive: true, mode: 0o700 });
    const open = new Set<net.Socket>();
    const deaf = net.createServer((s) => { open.add(s); s.on('error', () => {}); });
    await new Promise<void>((r) => deaf.listen(w.sock, r));
    stops.push(() => new Promise<void>((r) => { deaf.close(() => r()); for (const s of open) s.destroy(); }));
    w.links.start();
    await until(() => expect(open.size).toBeGreaterThan(0));
    fs.rmSync(w.sock);
    await w.tunnel();
    await until(() => expect(w.links.for(W)?.synced).toBe(true), 1500);
  });

  it('gives up on a stream only an old listener took after a link the worker answered', async () => {
    const w = await world();
    await w.tunnel();
    w.links.start();
    await until(() => expect(w.links.for(W)?.synced).toBe(true));
    fs.rmSync(w.sock);
    const open = new Set<net.Socket>();
    const deaf = net.createServer((s) => { open.add(s); s.on('error', () => {}); });
    await new Promise<void>((r) => deaf.listen(w.sock, r));
    stops.push(() => new Promise<void>((r) => { deaf.close(() => r()); for (const s of open) s.destroy(); }));
    w.links.for(W)!.close();
    await until(() => expect(open.size).toBeGreaterThan(0));
    fs.rmSync(w.sock);
    await w.tunnel();
    await until(() => expect(w.links.for(W)?.synced).toBe(true), 1500);
  });

  it('keeps its backoff when the worker binds its socket again after a link it answered closed', async () => {
    const w = await world({
      onEvent: () => Promise.reject(new Error('no room left')),
      onLink: (live) => { if (!live) { fs.rmSync(w.sock, { force: true }); void w.tunnel(); } },
    });
    await w.tunnel();
    w.worker.journal('docs.write', { a: 1 });
    w.links.start();
    await new Promise((r) => setTimeout(r, 4000));
    // the tries at 0, 1 and 3 s, where each binding's watch event would make it one per round trip
    expect(w.tries()).toBeGreaterThanOrEqual(2);
    expect(w.tries()).toBeLessThanOrEqual(4);
  }, 10_000);

  it('ends the link of a worker whose token it took back, and tries no more', async () => {
    const w = await world();
    await w.tunnel();
    w.links.start();
    await until(() => expect(w.links.for(W)?.synced).toBe(true));
    dropToken(w.homePaths, W);
    w.links.refresh();
    await until(() => expect(w.home.state.machines?.[W]?.reachable).toBe(false));
    const tries = w.tries();
    await new Promise((r) => setTimeout(r, 1500));
    expect(w.tries()).toBeLessThanOrEqual(tries + 1);
    expect(w.worker.connected()).toBe(false);
  });

  it('pushes the agent configuration to a worker on either platform, on linking and before a move', async () => {
    for (const platform of ['darwin', 'linux'] as const) {
      const push = vi.fn(() => Promise.resolve({ sent: 0 }));
      const w = await world({ machines: () => [{ id: W, record: { ...dialing.record, platform } }], mirror: { push, settled: () => Promise.resolve() } });
      await w.tunnel();
      w.links.start();
      await until(() => expect(w.links.for(W)?.synced).toBe(true));
      await w.links.pushMirror(W);
      await w.links.mirrorSettled(W);
      expect(push).toHaveBeenCalledTimes(2);
      w.links.stop();
    }
  });

  it('leaves anything at the path that is not a socket', async () => {
    const w = await world();
    fs.mkdirSync(w.homePaths.dialSockets, { recursive: true, mode: 0o700 });
    fs.writeFileSync(w.sock, 'not a socket');
    await expect(socketTransport({ paths: w.homePaths })(dialing)).rejects.toThrow(/mac has not dialed in|ENOTSOCK|ECONNREFUSED/);
    expect(fs.readFileSync(w.sock, 'utf8')).toBe('not a socket');
  });

  it('is linked anew over its socket once its record says it dials in, and over ssh again once it no longer does', async () => {
    let entry: MachineEntry = { id: W, record: { ...record, ssh: 'mac' } };
    let ssh = 0;
    const w = await world({
      machines: () => [entry],
      connect: async () => { ssh++; const stream = net.connect(w.workerPaths.linkSock); await once(stream, 'connect'); return { stream, via: { ssh: 'mac', controlSocket: '/tmp/m' } }; },
    });
    w.links.start();
    await until(() => expect(w.links.for(W)?.synced).toBe(true));
    expect(w.links.for(W)?.via()).toEqual({ ssh: 'mac', controlSocket: '/tmp/m' });
    await w.tunnel();
    const stopped = vi.spyOn(w.links.for(W)!, 'stop');
    entry = dialing;
    w.links.refresh();
    expect(stopped).toHaveBeenCalled();
    await until(() => expect(w.links.for(W)?.dialsIn && w.links.for(W)?.synced).toBe(true));
    expect(w.links.for(W)?.via()).toBeUndefined();
    entry = { id: W, record: { ...record, ssh: 'mac' } };
    w.links.refresh();
    await until(() => expect(!w.links.for(W)?.dialsIn && w.links.for(W)?.synced).toBe(true));
    expect(ssh).toBe(2);
  });
});
