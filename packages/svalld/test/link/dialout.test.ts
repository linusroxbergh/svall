import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import { once } from 'node:events';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installFakeSsh, type FakeSsh } from '../../../cli/test/controller/fake-ssh.js';
import { HomeDial } from '../../src/link/dialout.js';
import { HEARTBEAT_MS } from '../../src/link/home.js';
import { silentLogger } from '../../src/log.js';
import { dialSocket, resolvePaths } from '../../src/paths.js';
import { cleanHomes, makeHome } from '../helpers.js';

const W = crypto.randomUUID();
const until = (check: () => void, timeout = 8000) => vi.waitFor(check, { timeout, interval: 25 });

let ssh: FakeSsh;
const stops: (() => unknown)[] = [];
beforeEach(() => { ssh = installFakeSsh(); ssh.execute({}); });
afterEach(async () => {
  for (const stop of stops.splice(0).reverse()) await stop();
  vi.useRealTimers();
  ssh.clean();
  cleanHomes();
});

/** A worker whose worker.json dials `homeSsh`, its link.sock answered by a server here, and the home's fleet home beside it. */
async function world(o: { homeSsh?: string } = {}) {
  const worker = resolvePaths(makeHome());
  const home = resolvePaths(makeHome());
  const socket = dialSocket(home, W);
  const file = { homeMachineId: crypto.randomUUID(), fleetId: crypto.randomUUID(), token: 't'.repeat(48), homeName: 'studio', homeSsh: o.homeSsh ?? 'ada@studio', homeSocket: socket };
  fs.writeFileSync(worker.workerFile, JSON.stringify(file), { mode: 0o600 });
  let reached = 0;
  const server = net.createServer((s) => { reached++; s.end('link\n'); });
  await new Promise<void>((r) => server.listen(worker.linkSock, r));
  stops.push(() => new Promise<void>((r) => server.close(() => r())));
  const dial = new HomeDial({ paths: worker, log: silentLogger });
  stops.push(() => dial.stop());
  return { worker, home, socket, dial, reached: () => reached };
}

/** What a connect to the home's socket reads, as the home's link would. */
async function through(socket: string): Promise<string> {
  const s = net.connect(socket);
  await once(s, 'connect');
  let got = '';
  for await (const c of s) got += String(c);
  return got;
}

// the ssh argv of each kind, in the order they were spawned
const masters = () => ssh.calls().filter((a) => a.includes('-M'));
const forwards = () => ssh.calls().filter((a) => a.includes('-R'));
const indexOf = (match: (a: string[]) => boolean) => ssh.calls().findIndex(match);
const isClear = (socket: string) => (a: string[]): boolean => !a.includes('-O') && !a.includes('-M') && a.some((w) => w.includes('rm -f')) && a.at(-1)?.includes(socket) === true;

async function staleSocket(sock: string): Promise<void> {
  fs.mkdirSync(path.dirname(sock), { recursive: true, mode: 0o700 });
  const child = spawn(process.execPath, ['-e', `require('net').createServer().listen(${JSON.stringify(sock)}, () => console.log('up'))`], { stdio: ['ignore', 'pipe', 'inherit'] });
  await once(child.stdout, 'data');
  child.kill('SIGKILL');
  await once(child, 'exit');
}

describe('HomeDial', () => {
  it("opens one master to worker.json's homeSsh, clears its socket there before it asks the forward, and the socket reaches link.sock", async () => {
    const w = await world();
    w.dial.start();
    await until(() => expect(fs.existsSync(w.socket)).toBe(true));
    expect(await through(w.socket)).toBe('link\n');
    const [master] = masters();
    expect(masters()).toHaveLength(1);
    expect(master.slice(-2)).toEqual(['--', 'ada@studio']);
    for (const o of ['BatchMode=yes', 'ForwardAgent=no', 'ForwardX11=no', 'ClearAllForwardings=yes']) expect(master).toContain(o);
    expect(forwards()).toEqual([expect.arrayContaining(['-F', 'none', '-O', 'forward', '-R', `${w.socket}:${w.worker.linkSock}`, '--', 'svall-remote.invalid'])]);
    const clear = ssh.calls()[indexOf(isClear(w.socket))];
    for (const o of ['ClearAllForwardings=yes', 'RemoteCommand=none']) expect(clear).toContain(o);
    expect(indexOf(isClear(w.socket))).toBeLessThan(indexOf((a) => a.includes('-R')));
    expect(fs.statSync(path.dirname(w.socket)).mode & 0o777).toBe(0o700);
  });

  it('replaces a socket a dead tunnel left at the path, which sshd would not bind over', async () => {
    const w = await world();
    await staleSocket(w.socket);
    w.dial.start();
    await until(async () => expect(await through(w.socket)).toBe('link\n'));
  });

  it('on a master that answers, cancels the forward it holds before it clears and forwards again, as the master would not bind it twice', async () => {
    const w = await world();
    w.dial.start();
    await until(() => expect(fs.existsSync(w.socket)).toBe(true));
    const before = ssh.calls().length;
    w.dial.restore();
    await until(() => expect(forwards().filter((a) => a.includes('forward'))).toHaveLength(2));
    const again = ssh.calls().slice(before);
    const at = (match: (a: string[]) => boolean) => again.findIndex(match);
    expect(at((a) => a.includes('cancel') && a.includes('-R'))).toBeGreaterThanOrEqual(0);
    expect(at((a) => a.includes('cancel'))).toBeLessThan(at(isClear(w.socket)));
    expect(at(isClear(w.socket))).toBeLessThan(at((a) => a.includes('forward')));
    expect(masters()).toHaveLength(1);
    await until(async () => expect(await through(w.socket)).toBe('link\n'));
  });

  it('opens a master again once the one it rode on is gone, and forwards anew', async () => {
    vi.useFakeTimers({ toFake: ['setInterval'] });
    const w = await world();
    w.dial.start();
    await until(() => expect(fs.existsSync(w.socket)).toBe(true));
    ssh.dropMaster(w.dial.master()!.socket);
    // its listener went with it, and left the file
    await until(async () => expect(await through(w.socket).catch((e: Error) => e.message)).toMatch(/ECONNREFUSED/));
    vi.advanceTimersByTime(HEARTBEAT_MS);
    await until(() => expect(masters()).toHaveLength(2));
    await until(async () => expect(await through(w.socket)).toBe('link\n'));
  });

  it('opens a fresh master after a sleep, whose connection the master it held may have lost while its process answers', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'Date'] });
    const w = await world();
    w.dial.start();
    await until(() => expect(fs.existsSync(w.socket)).toBe(true));
    vi.setSystemTime(Date.now() + 10 * HEARTBEAT_MS);
    vi.advanceTimersByTime(HEARTBEAT_MS);
    await until(() => expect(masters()).toHaveLength(2));
    await until(async () => expect(await through(w.socket)).toBe('link\n'));
  });

  it('cancels its forward and closes its master on a clean stop, leaving a socket that refuses', async () => {
    const w = await world();
    w.dial.start();
    await until(() => expect(fs.existsSync(w.socket)).toBe(true));
    const master = w.dial.master()!.socket;
    await w.dial.stop();
    expect(forwards().at(-1)).toEqual(expect.arrayContaining(['-O', 'cancel', '-R', `${w.socket}:${w.worker.linkSock}`]));
    expect(ssh.calls().at(-1)).toEqual(expect.arrayContaining(['-O', 'exit']));
    expect(ssh.masterPid(master)).toBeUndefined();
    await expect(through(w.socket)).rejects.toThrow(/ECONNREFUSED/);
  });

  it('stops dialing once worker.json is gone', async () => {
    vi.useFakeTimers({ toFake: ['setInterval'] });
    const w = await world();
    w.dial.start();
    await until(() => expect(fs.existsSync(w.socket)).toBe(true));
    const master = w.dial.master()!.socket;
    fs.rmSync(w.worker.workerFile);
    vi.advanceTimersByTime(HEARTBEAT_MS);
    await until(() => expect(ssh.masterPid(master)).toBeUndefined());
    const calls = ssh.calls().length;
    w.dial.restore();
    vi.advanceTimersByTime(HEARTBEAT_MS);
    await new Promise((r) => setTimeout(r, 300));
    expect(ssh.calls()).toHaveLength(calls);
  });

  it('spawns no ssh for a homeSsh that ssh would read as an option', async () => {
    const w = await world();
    const file = JSON.parse(fs.readFileSync(w.worker.workerFile, 'utf8'));
    fs.writeFileSync(w.worker.workerFile, JSON.stringify({ ...file, homeSsh: '-oProxyCommand=touch /tmp/pwned' }));
    w.dial.start();
    await new Promise((r) => setTimeout(r, 300));
    expect(ssh.calls()).toEqual([]);
  });
});
