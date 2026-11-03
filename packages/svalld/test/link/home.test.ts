import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import { once } from 'node:events';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FleetId, MachineId, emptyState } from '@svall/protocol';
import { HomeLinks, socketTransport, type Transport } from '../../src/link/home.js';
import { HomeConnection } from '../../src/link/worker.js';
import { silentLogger, type Logger } from '../../src/log.js';
import type { MachineEntry } from '../../src/machine.js';
import { dialSocket, resolvePaths } from '../../src/paths.js';
import { issueToken } from '../../src/placement/workers.js';
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
async function world(o: { machines?: () => MachineEntry[]; connect?: Transport; log?: Logger } = {}) {
  const homePaths = resolvePaths(makeHome());
  const workerPaths = resolvePaths(makeHome());
  const token = issueToken(homePaths, W);
  const home = Store.load(homePaths.state, () => {});
  const store = Store.load(workerPaths.state, () => {});
  store.update((d) => { Object.assign(d, emptyState()); });
  const worker = new HomeConnection({
    paths: workerPaths, worker: { homeMachineId: H, fleetId: FleetId.parse(crypto.randomUUID()), token, homeName: 'studio' }, me: W, store,
    outbox: Outbox.open(workerPaths), log: silentLogger, release: '1.2.3', bootId: 'boot-1', handlers: {},
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
    onReport: () => {}, onEvent: async () => {}, onInventory: async () => {},
    snapshot: () => ({ version: 1, state: home.state, agentHomes: { claude: '/c', codex: '/x', opencode: '/o' }, home: '/home/ada' }),
  });
  stops.push(() => links.stop());
  return { homePaths, workerPaths, token, home, worker, sock, tunnel, links, firsts, tries: () => tries };
}

// a socket whose listener is gone without unlinking it, as a tunnel sshd dropped without its cancel leaves
async function staleSocket(sock: string): Promise<void> {
  fs.mkdirSync(path.dirname(sock), { recursive: true, mode: 0o700 });
  const child = spawn(process.execPath, ['-e', `require('net').createServer().listen(${JSON.stringify(sock)}, () => console.log('up'))`], { stdio: ['ignore', 'pipe', 'inherit'] });
  await once(child.stdout, 'data');
  child.kill('SIGKILL');
  await once(child, 'exit');
}

describe('a worker that dials in', () => {
  it('links over its socket in the fleet home, greeted with the token first, and gives terminals no ssh route', async () => {
    const w = await world();
    await w.tunnel();
    w.links.start();
    await until(() => expect(w.links.for(W)?.synced && w.worker.connected()).toBe(true));
    expect(JSON.parse(w.firsts[0])).toMatchObject({ t: 'hello', token: w.token });
    expect(w.links.for(W)?.via()).toBeUndefined();
    expect(w.home.state.machines?.[W]).toMatchObject({ name: 'mac', reachable: true });
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

  it('removes a socket that refuses, as a tunnel gone without its cancel leaves, and links once the worker binds the path again', async () => {
    const w = await world();
    await staleSocket(w.sock);
    expect(fs.lstatSync(w.sock).isSocket()).toBe(true);
    w.links.start();
    await until(() => expect(fs.existsSync(w.sock)).toBe(false));
    expect(w.home.state.machines?.[W]?.reachable).toBe(false);
    await w.tunnel();
    await until(() => expect(w.links.for(W)?.synced).toBe(true), 1500);
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
    entry = dialing;
    w.links.refresh();
    await until(() => expect(w.links.for(W)?.dialsIn && w.links.for(W)?.synced).toBe(true));
    expect(w.links.for(W)?.via()).toBeUndefined();
    entry = { id: W, record: { ...record, ssh: 'mac' } };
    w.links.refresh();
    await until(() => expect(!w.links.for(W)?.dialsIn && w.links.for(W)?.synced).toBe(true));
    expect(ssh).toBe(2);
  });

  it('is not linked by a home that takes no link from a worker that dials in', async () => {
    const homePaths = resolvePaths(makeHome());
    issueToken(homePaths, W);
    const log = errors();
    const home = Store.load(homePaths.state, () => {});
    const links = new HomeLinks({
      paths: homePaths, store: home, log, release: '1.2.3', machines: () => [dialing], connect: () => Promise.reject(new Error('no ssh')),
      onReport: () => {}, onEvent: async () => {}, onInventory: async () => {},
      snapshot: () => ({ version: 1, state: home.state, agentHomes: { claude: '/c', codex: '/x', opencode: '/o' }, home: '/home/ada' }),
    });
    stops.push(() => links.stop());
    links.start();
    await until(() => expect(home.state.machines?.[W]?.reachable).toBe(false));
    expect(links.for(W)?.connected()).toBe(false);
  });
});
