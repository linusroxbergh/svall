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
  delete process.env.SVALL_FAKE_SSH_HANG;
  for (const stop of stops.splice(0).reverse()) await stop();
  vi.useRealTimers();
  ssh.clean();
  cleanHomes();
});

/** A worker whose worker.json dials `homeSsh`, its link.sock answered by a server here, and the home's fleet home beside it. */
async function world(o: { homeSsh?: string; linked?: () => boolean } = {}) {
  const worker = resolvePaths(makeHome());
  const home = resolvePaths(makeHome());
  const socket = dialSocket(home, W);
  const file = { homeMachineId: crypto.randomUUID(), fleetId: crypto.randomUUID(), token: 't'.repeat(48), homeName: 'studio', homeSsh: o.homeSsh ?? 'ada@studio', homeSocket: socket };
  fs.writeFileSync(worker.workerFile, JSON.stringify(file), { mode: 0o600 });
  let reached = 0;
  const server = net.createServer((s) => { reached++; s.on('error', () => {}); s.end('link\n'); });
  await new Promise<void>((r) => server.listen(worker.linkSock, r));
  stops.push(() => new Promise<void>((r) => server.close(() => r())));
  const said: string[] = [];
  const dial = new HomeDial({ paths: worker, log: { ...silentLogger, info: (l: string) => { said.push(l); }, error: (l: string) => { said.push(l); } }, me: W, linked: o.linked ?? (() => false) });
  stops.push(() => dial.stop());
  return { worker, home, socket, dial, reached: () => reached, said };
}

/** What a connect to the home's socket reads, as the home's link would. */
async function through(socket: string): Promise<string> {
  const s = net.connect(socket);
  await once(s, 'connect');
  let got = '';
  for await (const c of s) got += String(c);
  return got;
}

// the forward answered, so its listener is up and the tunnel held, where a socket file alone may still refuse
const dialed = (w: { said: string[] }) => until(() => expect(w.said.at(-1)).toMatch(/^dialed/));
// the dial said it gave up, which comes before any ssh it would have spawned next
const gaveUp = (w: { said: string[] }) => until(() => expect(w.said.at(-1)).toMatch(/^the dial to the home failed/));
const rewrite = (w: { worker: { workerFile: string } }, change: object) =>
  fs.writeFileSync(w.worker.workerFile, JSON.stringify({ ...JSON.parse(fs.readFileSync(w.worker.workerFile, 'utf8')), homeSsh: undefined, ...change }));

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
    await dialed(w);
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
    await dialed(w);
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
    await dialed(w);
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
    await dialed(w);
    vi.setSystemTime(Date.now() + 10 * HEARTBEAT_MS);
    vi.advanceTimersByTime(HEARTBEAT_MS);
    await until(() => expect(masters()).toHaveLength(2));
    await until(async () => expect(await through(w.socket)).toBe('link\n'));
  });

  it('binds its socket again once it is gone from the home while the link is down and the master up, which nothing else would notice', async () => {
    vi.useFakeTimers({ toFake: ['setInterval'] });
    const w = await world();
    w.dial.start();
    await dialed(w);
    fs.rmSync(w.socket);
    vi.advanceTimersByTime(HEARTBEAT_MS);
    await until(() => expect(forwards().filter((a) => a.includes('forward'))).toHaveLength(2));
    await until(async () => expect(await through(w.socket)).toBe('link\n'));
    expect(masters()).toHaveLength(1);
  });

  it('asks for no socket while the link is up, and forwards nothing again while its socket is there', async () => {
    vi.useFakeTimers({ toFake: ['setInterval'] });
    let linked = true;
    let asked = 0;
    const w = await world({ linked: () => { asked++; return linked; } });
    w.dial.start();
    await dialed(w);
    const probes = () => ssh.remoteCalls().filter((c) => c[0] === 'test' && c[1] === '-S');
    // two beats, each past the master's check, so a probe the first spawned has been logged by the second
    for (const n of [1, 2]) {
      vi.advanceTimersByTime(HEARTBEAT_MS);
      await until(() => expect(asked).toBeGreaterThanOrEqual(n));
    }
    expect(probes()).toEqual([]);
    linked = false;
    vi.advanceTimersByTime(HEARTBEAT_MS);
    await until(() => expect(probes()).toEqual([['test', '-S', w.socket]]));
    await new Promise((r) => setTimeout(r, 300));
    expect(forwards().filter((a) => a.includes('forward'))).toHaveLength(1);
  });

  it('cancels its forward and closes its master on a clean stop, leaving a socket that refuses', async () => {
    const w = await world();
    w.dial.start();
    await dialed(w);
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
    await dialed(w);
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

  it('tries a dial that failed again, with the destination worker.json names by then', async () => {
    const w = await world({ homeSsh: 'refused.test' });
    w.dial.start();
    await until(() => expect(masters()).toHaveLength(1));
    rewrite(w, { homeSsh: 'ada@studio' });
    await dialed(w);
    expect(masters().at(-1)?.slice(-2)).toEqual(['--', 'ada@studio']);
  });

  it('leaves the master to the old home for a homeSsh that names another', async () => {
    const w = await world();
    w.dial.start();
    await dialed(w);
    const old = w.dial.master()!.socket;
    rewrite(w, { homeSsh: 'ada@elsewhere' });
    w.dial.restore();
    await until(() => expect(masters().at(-1)?.slice(-2)).toEqual(['--', 'ada@elsewhere']));
    await until(() => expect(ssh.masterPid(old)).toBeUndefined());
  });

  it('closes its master and dials no more once worker.json names no home to dial', async () => {
    const w = await world();
    w.dial.start();
    await dialed(w);
    const master = w.dial.master()!.socket;
    rewrite(w, { homeSocket: undefined });
    w.dial.restore();
    await until(() => expect(ssh.masterPid(master)).toBeUndefined());
    const calls = ssh.calls().length;
    w.dial.restore();
    await new Promise((r) => setTimeout(r, 300));
    expect(ssh.calls()).toHaveLength(calls);
  });

  it('asks no forward over a path that holds anything but a socket, which stays, and tries again', async () => {
    const w = await world();
    fs.mkdirSync(path.dirname(w.socket), { recursive: true, mode: 0o700 });
    fs.writeFileSync(w.socket, 'keep');
    w.dial.start();
    await until(() => expect(ssh.calls().filter(isClear(w.socket)).length).toBeGreaterThanOrEqual(2));
    expect(forwards()).toEqual([]);
    expect(fs.readFileSync(w.socket, 'utf8')).toBe('keep');
  });

  it("spawns no ssh for a socket that is not this machine's", async () => {
    const w = await world();
    rewrite(w, { homeSsh: 'ada@studio', homeSocket: dialSocket(w.home, crypto.randomUUID()) });
    w.dial.start();
    await gaveUp(w);
    expect(ssh.calls()).toEqual([]);
  });

  it('binds nothing new when told to look at a tunnel that is whole, as after a link lost over it, and opens a master again once its own is gone', async () => {
    const w = await world();
    w.dial.start();
    await dialed(w);
    w.dial.check();
    const probe = () => ssh.remoteCalls().some((c) => c[0] === 'test' && c[1] === '-S');
    await until(() => expect(probe()).toBe(true));
    w.dial.check();
    await new Promise((r) => setTimeout(r, 1500));
    expect(forwards().filter((a) => a.includes('forward'))).toHaveLength(1);
    expect(masters()).toHaveLength(1);
    ssh.dropMaster(w.dial.master()!.socket);
    w.dial.check();
    await until(() => expect(masters()).toHaveLength(2));
  });

  for (const [step, hang] of [['master check', () => { process.env.SVALL_FAKE_SSH_HANG = 'check'; }], ['forward', () => { process.env.SVALL_FAKE_SSH_HANG = 'forward'; }], ['far command', () => { ssh.reply(['svall-dial'], { delayMs: 20_000 }); }]] as const) {
    it(`stops at once in a ${step} that hangs, well before that step would time out`, async () => {
      const w = await world();
      hang();
      w.dial.start();
      const spawned = step === 'master check' ? () => masters().length === 1 : step === 'forward' ? () => forwards().length === 1 : () => ssh.calls().some(isClear(w.socket));
      await until(() => expect(spawned()).toBe(true));
      const at = Date.now();
      await w.dial.stop();
      expect(Date.now() - at).toBeLessThan(8000);
    });
  }

  it('gives up a dial under way at once when it stops, ending the master it was opening', async () => {
    const w = await world({ homeSsh: 'check.test' });
    w.dial.start();
    await until(() => expect(masters()).toHaveLength(1));
    const at = Date.now();
    await w.dial.stop();
    expect(Date.now() - at).toBeLessThan(5000);
  });

  it('reads no sleep into a daemon that took long to reach its start', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'Date'] });
    const w = await world();
    vi.setSystemTime(Date.now() + 10 * HEARTBEAT_MS);
    w.dial.start();
    await dialed(w);
    vi.advanceTimersByTime(HEARTBEAT_MS);
    await new Promise((r) => setTimeout(r, 1500));
    expect(masters()).toHaveLength(1);
  });

  it('spawns no ssh for a homeSsh that ssh would read as an option', async () => {
    const w = await world();
    const file = JSON.parse(fs.readFileSync(w.worker.workerFile, 'utf8'));
    fs.writeFileSync(w.worker.workerFile, JSON.stringify({ ...file, homeSsh: '-oProxyCommand=touch /tmp/pwned' }));
    w.dial.start();
    await gaveUp(w);
    expect(ssh.calls()).toEqual([]);
  });
});
