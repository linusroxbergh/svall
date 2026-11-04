import crypto from 'node:crypto';
import net from 'node:net';
import { describe, expect, it, vi } from 'vitest';
import { WebSocketServer } from 'ws';
import { PROTOCOL_VERSION, type WorkerFile } from '@svall/protocol';
import { greets, HomeApi } from '../../src/link/home-api.js';
import { classifySsh, SshError, type SshMaster } from '../../src/link/ssh.js';

const HOME = crypto.randomUUID() as WorkerFile['homeMachineId'];
const FLEET = crypto.randomUUID() as WorkerFile['fleetId'];
const TOKEN = 'secret-of-the-home';
const worker: WorkerFile = {
  homeMachineId: HOME, fleetId: FLEET, token: 't'.repeat(48), homeName: 'studio', homeSsh: 'ada@studio',
  homeSocket: '/home/ada/.svall-x/w/0123456789ab.sock', homeSvallBase: '/home/ada/.local/share/svall',
};
const info = (o: object = {}) => ({ code: 0, signal: null, stderr: '', stdout: JSON.stringify({ fleetId: FLEET, machineId: HOME, release: '0.21', protocol: PROTOCOL_VERSION, host: '127.0.0.1', port: 47800, token: TOKEN, fleetHome: '/home/ada/.svall-x', ...o }) });

function fakeMaster(answers: () => unknown = () => info()) {
  let next = 50_000;
  const cancels: number[] = [];
  const master = {
    destination: 'ada@studio', socket: '/tmp/svall-501/1-abc',
    run: vi.fn(() => Promise.resolve(answers())),
    forward: vi.fn(() => { const localPort = next++; return Promise.resolve({ localPort, cancel: () => { cancels.push(localPort); return Promise.resolve(); } }); }),
  };
  return { master: master as unknown as SshMaster, run: master.run, forward: master.forward, cancels };
}

const dialOf = (master: SshMaster | undefined, failure?: SshError) => ({ master: () => master, failure: () => failure, restore: vi.fn() });
const apiOf = (dial: ReturnType<typeof dialOf> | undefined, o: Partial<WorkerFile> = {}, linked = false, answers: (port: number, token: string) => Promise<boolean> = () => Promise.resolve(true)) =>
  new HomeApi({ worker: () => ({ ...worker, ...o }), dial, linked: () => linked, greets: answers });

describe('how a window reaches a far home', () => {
  it("forwards the home's port over the master and hands over the route, the token kept out of argv", async () => {
    const m = fakeMaster();
    const a = await apiOf(dialOf(m.master)).answer();
    expect(a).toEqual({ machine: HOME, name: 'studio', state: 'connected', ssh: 'ada@studio', controlSocket: '/tmp/svall-501/1-abc', port: 50_000, token: TOKEN, release: '0.21' });
    expect(m.forward).toHaveBeenCalledWith(47800);
    expect(JSON.stringify(m.run.mock.calls)).not.toContain(TOKEN);
    expect(JSON.stringify(m.run.mock.calls)).toContain('SVALL_HOME=/home/ada/.svall-x');
    expect(JSON.stringify(m.run.mock.calls)).toContain('/home/ada/.local/share/svall/current/bin/svall');
  });

  it('reads the port at each ask, keeps the forward while it stands, and moves it after a far daemon restart', async () => {
    let port = 47800;
    const m = fakeMaster(() => info({ port }));
    const api = apiOf(dialOf(m.master));
    expect((await api.answer()).port).toBe(50_000);
    expect((await api.answer()).port).toBe(50_000);
    expect(m.run).toHaveBeenCalledTimes(2);
    expect(m.forward).toHaveBeenCalledTimes(1);
    port = 47999;
    expect((await api.answer()).port).toBe(50_001);
    expect(m.cancels).toEqual([50_000]);
  });

  it('forwards anew over a new master, as the old one took its forward with it', async () => {
    const one = fakeMaster();
    const two = fakeMaster();
    let master = one.master;
    const api = new HomeApi({ worker: () => worker, dial: { master: () => master, failure: () => undefined, restore: () => {} }, linked: () => true, greets: () => Promise.resolve(true) });
    await api.answer();
    master = two.master;
    await api.answer();
    expect(two.forward).toHaveBeenCalledTimes(1);
    expect(one.cancels).toEqual([50_000]);
  });

  it('takes one attempt at a time, and asks made meanwhile take its answer', async () => {
    const m = fakeMaster();
    const api = apiOf(dialOf(m.master));
    const [a, b] = await Promise.all([api.answer(), api.answer()]);
    expect(a).toBe(b);
    expect(m.run).toHaveBeenCalledTimes(1);
  });

  it('says version with the far release and hands over no route, asks nothing again by itself, and does on a retry', async () => {
    let protocol = PROTOCOL_VERSION - 1;
    const m = fakeMaster(() => info({ protocol, release: '0.20' }));
    const api = apiOf(dialOf(m.master));
    const a = await api.answer();
    expect(a).toMatchObject({ state: 'version', release: '0.20' });
    expect(a).not.toHaveProperty('token');
    expect(a).not.toHaveProperty('port');
    await api.answer();
    expect(m.run).toHaveBeenCalledTimes(1);
    protocol = PROTOCOL_VERSION;
    expect((await api.answer(true)).state).toBe('connected');
    expect(m.run).toHaveBeenCalledTimes(2);
  });

  it('reads an svall the far shell cannot run as version', async () => {
    const a = await apiOf(dialOf(fakeMaster(() => ({ code: 127, signal: null, stderr: 'not found', stdout: '' })).master)).answer();
    expect(a.state).toBe('version');
  });

  it('names both fleets of a mismatch, and gives no advice that would enrol the far machine', async () => {
    const other = crypto.randomUUID();
    const a = await apiOf(dialOf(fakeMaster(() => info({ fleetId: other })).master)).answer();
    expect(a.detail).toContain(other);
    expect(a.detail).toContain(FLEET);
    expect(a.detail).not.toContain('host upgrade');
  });

  it('says newer only of a far side ahead of this one', async () => {
    expect(await apiOf(dialOf(fakeMaster(() => info({ protocol: PROTOCOL_VERSION + 1, release: '0.99' })).master)).answer()).toMatchObject({ state: 'version', newer: true });
    expect(await apiOf(dialOf(fakeMaster(() => info({ protocol: PROTOCOL_VERSION - 1, release: '0.01' })).master)).answer()).not.toHaveProperty('newer');
  });

  it('gives back the forward it held when the far side settles, the dial fails, the master goes, or it stops', async () => {
    let protocol = PROTOCOL_VERSION;
    const m = fakeMaster(() => info({ protocol }));
    let failure: SshError | undefined;
    let master: SshMaster | undefined = m.master;
    const api = new HomeApi({ worker: () => worker, dial: { master: () => master, failure: () => failure, restore: () => {} }, linked: () => true, greets: () => Promise.resolve(true) });
    const forwarded = async () => { const a = await api.answer(); expect(a.state).toBe('connected'); return a; };
    const held = () => m.forward.mock.calls.length - m.cancels.length;
    await forwarded();
    expect(held()).toBe(1);
    protocol = PROTOCOL_VERSION - 1;
    expect((await api.answer(true)).state).toBe('version');
    expect(held()).toBe(0);
    protocol = PROTOCOL_VERSION;
    await api.answer(true);
    expect(held()).toBe(1);
    failure = new SshError('auth', 'Permission denied (publickey).');
    expect((await api.answer()).state).toBe('auth');
    expect(held()).toBe(0);
    failure = undefined;
    await forwarded();
    master = undefined;
    expect((await api.answer()).state).toBe('connecting');
    expect(held()).toBe(0);
    master = m.master;
    await forwarded();
    await api.stop();
    expect(held()).toBe(0);
  });

  it('answers connected only once the API greets through the forward, gives it back when none does, and tries again next ask', async () => {
    const m = fakeMaster();
    let up = false;
    const asked: [number, string][] = [];
    const api = apiOf(dialOf(m.master), {}, false, (port, token) => { asked.push([port, token]); return Promise.resolve(up); });
    const a = await api.answer();
    expect(a).toMatchObject({ state: 'unreachable', detail: expect.stringContaining('studio') });
    expect(a).not.toHaveProperty('token');
    expect(a).not.toHaveProperty('port');
    expect(JSON.stringify(a)).not.toContain(TOKEN);
    expect(asked).toEqual([[50_000, TOKEN]]);
    expect(m.cancels).toEqual([50_000]);
    up = true;
    expect(await api.answer()).toMatchObject({ state: 'connected', port: 50_001 });
  });

  it.each([
    ['another fleet', { fleetId: crypto.randomUUID() }, FLEET],
    ['another machine', { machineId: crypto.randomUUID() }, 'machineId'],
  ])('shows %s, never takes it for the home, and asks nothing again by itself', async (_what, o, word) => {
    const m = fakeMaster(() => info(o));
    const api = apiOf(dialOf(m.master));
    const a = await api.answer();
    expect(a).toMatchObject({ state: 'unreachable', detail: expect.stringContaining(word) });
    expect(a).not.toHaveProperty('token');
    expect(JSON.stringify(a)).not.toContain(TOKEN);
    expect(m.forward).not.toHaveBeenCalled();
    await api.answer();
    expect(m.run).toHaveBeenCalledTimes(1);
  });

  it('cancels its forward when the far daemon goes down, and asks again next time', async () => {
    let down = false;
    const m = fakeMaster(() => (down ? { code: 1, signal: null, stderr: 'svalld is not running', stdout: '' } : info()));
    const api = apiOf(dialOf(m.master));
    await api.answer();
    down = true;
    expect(await api.answer()).toMatchObject({ state: 'unreachable', detail: expect.stringContaining('svalld is not running') });
    expect(m.cancels).toEqual([50_000]);
    down = false;
    expect((await api.answer()).state).toBe('connected');
    expect(m.run).toHaveBeenCalledTimes(3);
  });

  it('says unreachable when the forward cannot be made, holding none', async () => {
    const m = fakeMaster();
    m.forward.mockImplementationOnce(() => Promise.reject(new SshError('other', 'ssh could not forward')));
    const api = apiOf(dialOf(m.master));
    expect(await api.answer()).toMatchObject({ state: 'unreachable', detail: expect.stringContaining('could not forward') });
    expect((await api.answer()).state).toBe('connected');
  });

  it('says connecting while the dial has no master yet', async () => {
    expect((await apiOf(dialOf(undefined)).answer()).state).toBe('connecting');
  });

  it('says auth for a refused login or host key, and a retry asks the dial again', async () => {
    for (const stderr of ['linus@studio: Permission denied (publickey).', 'Host key verification failed.']) {
      const dial = dialOf(undefined, new SshError(classifySsh(stderr), stderr));
      const api = apiOf(dial);
      expect(await api.answer()).toMatchObject({ state: 'auth', detail: stderr });
      expect(dial.restore).not.toHaveBeenCalled();
      await api.answer(true);
      expect(dial.restore).toHaveBeenCalledTimes(1);
    }
  });

  it.each([
    'ssh: connect to host studio port 22: Connection refused',
    'ssh: connect to host studio port 22: Operation timed out',
    'ssh: Could not resolve hostname studio',
    'Connection closed by 100.1.2.3 port 22',
    'client_loop: send disconnect: Broken pipe',
    'ssh: connect to host studio port 22: No route to host',
    'ssh: connect to host 100.117.42.24 port 22: Permission denied',
    'hostkeys_find_by_key_hostfile: hostkeys_foreach failed for /Users/a/.ssh/known_hosts: Permission denied\nssh: connect to host 100.117.42.24 port 22: Operation timed out',
    'Load key "/Users/a/.ssh/id_ed25519": Permission denied\nssh: connect to host 100.117.42.24 port 22: Network is unreachable',
  ])('never reads a transient failure as auth: %s', async (stderr) => {
    const a = await apiOf(dialOf(undefined, new SshError(classifySsh(stderr), stderr))).answer();
    expect(a.state).toBe('unreachable');
  });

  it('asks a person to enrol again when worker.json does not say where svall is on the home', async () => {
    const a = await apiOf(dialOf(fakeMaster().master), { homeSvallBase: undefined }).answer();
    expect(a).toMatchObject({ state: 'version', detail: expect.stringContaining('enrol it again') });
  });

  it('answers from the link alone for a worker its home dials', async () => {
    expect((await apiOf(undefined, {}, true).answer()).state).toBe('connected');
    expect((await apiOf(undefined, {}, false).answer()).state).toBe('unreachable');
  });
});

describe('whether the API greets through a forward', () => {
  it('takes a greeting for the token it said', async () => {
    const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' });
    await new Promise((r) => wss.once('listening', r));
    const said: string[] = [];
    wss.on('connection', (ws) => ws.on('message', (raw) => {
      said.push(String(raw));
      ws.send(JSON.stringify({ id: 0, result: { ok: true, protocol: PROTOCOL_VERSION } }));
    }));
    expect(await greets((wss.address() as net.AddressInfo).port, 'the-token')).toBe(true);
    expect(said).toEqual([JSON.stringify({ token: 'the-token' })]);
    await new Promise((r) => wss.close(r));
  });

  it('takes a socket closed for a wrong token, one closed ungreeted as ssh does, one that never answers and a port nobody holds as no', async () => {
    const refusing = new WebSocketServer({ port: 0, host: '127.0.0.1' });
    await new Promise((r) => refusing.once('listening', r));
    refusing.on('connection', (ws) => ws.on('message', () => ws.close(4401, 'unauthorized')));
    expect(await greets((refusing.address() as net.AddressInfo).port, 't')).toBe(false);
    await new Promise((r) => refusing.close(r));

    const forward = net.createServer((s) => { s.on('error', () => {}); s.destroy(); });
    await new Promise<void>((r) => forward.listen(0, '127.0.0.1', r));
    expect(await greets((forward.address() as net.AddressInfo).port, 't')).toBe(false);
    await new Promise((r) => forward.close(r));

    const silent = net.createServer((s) => { s.on('error', () => {}); });
    await new Promise<void>((r) => silent.listen(0, '127.0.0.1', r));
    const port = (silent.address() as net.AddressInfo).port;
    expect(await greets(port, 't', 50)).toBe(false);
    silent.close();
    await new Promise((r) => { setTimeout(r, 5); });
    expect(await greets(1, 't')).toBe(false);
  });
});
