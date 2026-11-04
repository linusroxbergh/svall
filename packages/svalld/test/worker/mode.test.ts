import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import WebSocket from 'ws';
import { emptyState, type LinkFrame, type Response } from '@svall/protocol';
import { installFakeSsh } from '../../../cli/test/controller/fake-ssh.js';
import { InvalidConfig } from '../../src/config.js';
import { LinkStream } from '../../src/link/stream.js';
import { silentLogger } from '../../src/log.js';
import { startDaemon } from '../../src/main.js';
import { machineId } from '../../src/machine.js';
import { dialSocket, resolvePaths } from '../../src/paths.js';
import { Store } from '../../src/store.js';
import { Tmux } from '../../src/tmux/tmux.js';
import { isWorker, readWorkerFile, workerOptions } from '../../src/worker/mode.js';
import { cleanHomes, hasTmux, makeHome, waitFor } from '../helpers.js';

const runIf = hasTmux() ? describe : describe.skip;

const workerFile = { homeMachineId: crypto.randomUUID(), fleetId: crypto.randomUUID(), token: 'a'.repeat(48), homeName: 'mac' };

// one call over the API, answered by its id
async function client(port: number, token: string): Promise<{ call(method: string, params?: unknown): Promise<Response>; close(): void }> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  await new Promise((r) => ws.once('open', r));
  ws.send(JSON.stringify({ token }));
  let next = 1;
  return {
    call: (method, params) => new Promise((resolve) => {
      const id = next++;
      ws.on('message', (raw) => { const m = JSON.parse(raw.toString()) as Response; if (m.id === id) resolve(m); });
      ws.send(JSON.stringify({ id, method, params }));
    }),
    close: () => ws.close(),
  };
}

describe('worker.json', () => {
  afterEach(cleanHomes);

  it('makes a fleet home a worker\'s, and one missing or invalid is an InvalidConfig naming the file', () => {
    const paths = resolvePaths(makeHome());
    expect(isWorker(paths)).toBe(false);
    expect(() => readWorkerFile(paths)).toThrow(InvalidConfig);
    fs.writeFileSync(paths.workerFile, JSON.stringify({ ...workerFile, token: 'short' }));
    expect(isWorker(paths)).toBe(true);
    expect(() => readWorkerFile(paths)).toThrow(new RegExp(`${paths.workerFile}.*token`));
    fs.writeFileSync(paths.workerFile, JSON.stringify(workerFile));
    expect(workerOptions(paths, 'linux')).toEqual({ worker: workerFile, off: ['mobile', 'push', 'scribe', 'fleets'] });
    // a Mac's File menu still lists and opens the fleets beside this one
    expect(workerOptions(paths, 'darwin')).toEqual({ worker: workerFile, off: ['mobile', 'push', 'scribe'] });
  });
});

runIf('svalld --worker', () => {
  const homes: string[] = [];
  afterEach(async () => {
    for (const h of homes.splice(0)) { const p = resolvePaths(h); await new Tmux(p.tmuxSock, p.tmuxConf).killServer(); }
    vi.unstubAllEnvs();
    cleanHomes();
  });

  it('refuses to start while this machine\'s id cannot be read, rather than run as a new machine', async () => {
    const home = makeHome();
    homes.push(home);
    fs.writeFileSync(resolvePaths(home).workerFile, JSON.stringify(workerFile));
    fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ shell: '/bin/sh' }));
    const config = makeHome();
    vi.stubEnv('SVALL_CONFIG_DIR', config);
    fs.writeFileSync(path.join(config, 'machine.json'), '{');
    await expect(startDaemon({ home, port: 0, worker: true, log: silentLogger })).rejects.toThrow(/invalid machine file .*machine\.json.*delete the file to mint a new machine id/);
    expect(fs.readFileSync(path.join(config, 'machine.json'), 'utf8')).toBe('{');
  });

  it("a dial-out worker with no link yet resumes its own robots at rest, journaling them for its home, and none of the home's", async () => {
    const ssh = installFakeSsh();
    const home = makeHome();
    homes.push(home);
    const paths = resolvePaths(home);
    const me = machineId();
    fs.writeFileSync(paths.workerFile, JSON.stringify({ ...workerFile, homeSsh: 'refused.test', homeSocket: dialSocket({ dialSockets: '/home/ada/.svall/w' }, me) }));
    fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ shell: '/bin/sh' }));
    const robot = (id: string, o: object) => {
      const sessionId = crypto.randomUUID();
      const transcriptPath = path.join(home, `${sessionId}.jsonl`);
      fs.writeFileSync(transcriptPath, '');
      return {
        id, islandId: 'i_a', cell: { x: 0, y: 0 }, name: id, portrait: 'fox', note: '', instructions: '', cwd: home, context: [], shell: { lastOutputAt: 0 }, unread: false,
        tmux: { windowId: '@9', paneId: '%9' }, agent: { kind: 'claude', sessionId, transcriptPath, status: 'idle', lastActivityAt: Date.now() }, ...o,
      };
    };
    const island = { id: 'i_a', name: 'a', description: '', instructions: '', context: [], position: { x: 0, y: 0 }, size: { w: 4, h: 3 }, seed: 1 };
    const mine = robot('c_mine', { machine: me, placement: { generation: 1 } });
    const others = robot('c_home', { tmux: undefined, agent: { ...robot('x', {}).agent, restingSince: Date.now() }, revive: { command: 'true' } });
    fs.writeFileSync(paths.state, JSON.stringify({ ...emptyState(), islands: { i_a: island }, robots: { c_mine: mine, c_home: others } }));
    const d = await startDaemon({ home, port: 0, worker: true, log: silentLogger });
    try {
      await waitFor(async () => !!d.store.state.robots.c_mine.tmux && (await d.fleet.readScreen('c_mine', 20)).includes(`--resume ${mine.agent.sessionId}`));
      await waitFor(() => fs.readFileSync(paths.outbox, 'utf8').includes('c_mine'));
      expect(d.store.state.robots.c_home.tmux).toBeUndefined();
      expect(d.store.state.machines?.[workerFile.homeMachineId as never]?.reachable).not.toBe(true);
    } finally {
      await d.stop();
      await new Tmux(paths.tmuxSock, paths.tmuxConf).killServer();
      ssh.clean();
    }
  }, 60_000);

  it('a home with worker.json starts with scribe off and no mobile, and still answers state.get', async () => {
    const home = makeHome();
    homes.push(home);
    const paths = resolvePaths(home);
    fs.writeFileSync(paths.workerFile, JSON.stringify(workerFile));
    // fleet.json as an older release left it on a machine it made a gateway
    fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ shell: '/bin/sh', gatewayMachineId: crypto.randomUUID() }));
    const d = await startDaemon({ home, port: 0, worker: true, log: silentLogger });
    const api = await client(d.port, d.token);
    try {
      expect(d.store.state.scribeOff).toBe(true);
      expect(Store.load(paths.state, () => {}).state.scribeOff).toBe(true);
      expect(await api.call('state.get')).toMatchObject({ result: { version: 12 } });
      expect(await api.call('fleet.config')).toMatchObject({ error: { code: 'not_on_worker' } });
      expect(await api.call('workspace.clones')).toMatchObject({ result: { machine: machineId(), folders: expect.any(Array) } });
      expect(await api.call('mobile.get')).toMatchObject({ error: { code: 'not_on_worker', message: 'not on a worker' } });
      expect(await api.call('usage.get')).toMatchObject({ result: { available: true, idle: true, windows: [] } });
      // a Mac worker's File menu lists the fleets beside this one; Linux has no app to ask
      expect(await api.call('fleets.list')).toMatchObject(process.platform === 'darwin' ? { result: { fleets: expect.any(Array) } } : { error: { code: 'forbidden' } });
      // a change is the home's to make, and no home has linked
      const islands = structuredClone(d.store.state.islands);
      expect(await api.call('island.arrange', {})).toMatchObject({ error: { code: 'not_reachable', message: expect.stringMatching(/ cannot reach this Mac right now; try again when it is awake$/) } });
      expect(d.store.state.islands).toEqual(islands);
    } finally {
      api.close();
      await d.stop();
    }
  });

  it('greets its home with the release svall version names, the version in release.json', async () => {
    const home = makeHome();
    homes.push(home);
    const paths = resolvePaths(home);
    fs.writeFileSync(paths.workerFile, JSON.stringify(workerFile));
    fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ shell: '/bin/sh' }));
    const release = makeHome();
    fs.writeFileSync(path.join(release, 'release.json'), JSON.stringify({ version: 'v9.8.7' }));
    vi.stubEnv('SVALL_RELEASE_ROOT', release);
    const d = await startDaemon({ home, port: 0, worker: true, log: silentLogger });
    const frames: LinkFrame[] = [];
    const stream = new LinkStream(net.connect(paths.linkSock), { onFrame: (f) => frames.push(f), onClose: () => {} });
    try {
      stream.send({ t: 'hello', token: workerFile.token, release: 'v9.8.7' });
      await vi.waitFor(() => expect(frames.find((f) => f.t === 'hello')).toMatchObject({ release: 'v9.8.7' }));
    } finally {
      stream.close();
      await d.stop();
    }
  });
});
