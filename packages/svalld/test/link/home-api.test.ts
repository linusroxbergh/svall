import crypto from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { PROTOCOL_VERSION, type WorkerFile } from '@svall/protocol';
import { HomeApi } from '../../src/link/home-api.js';
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
const apiOf = (dial: ReturnType<typeof dialOf> | undefined, o: Partial<WorkerFile> = {}, linked = false) => new HomeApi({ worker: () => ({ ...worker, ...o }), dial, linked: () => linked });

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
    const api = new HomeApi({ worker: () => worker, dial: { master: () => master, failure: () => undefined, restore: () => {} }, linked: () => true });
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

  it.each([
    ['another fleet', { fleetId: crypto.randomUUID() }, 'fleetId'],
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
