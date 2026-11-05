import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { emptyState, HOME_ISLAND, type HomeManifest, type MachineId, type Response } from '@svall/protocol';
import { HomeCrash } from '../../src/failpoints.js';
import { abortAdopt, adoptStatus, installAdopt, journalLines, packFleet, stageAdopt, writeMarker, type HomeDaemon } from '../../src/fleet/home-move.js';
import { silentLogger } from '../../src/log.js';
import { machineId } from '../../src/machine.js';
import { startDaemon, type Daemon } from '../../src/main.js';
import { resolvePaths, type Paths } from '../../src/paths.js';
import { issueToken } from '../../src/placement/workers.js';
import { Tmux } from '../../src/tmux/tmux.js';
import { startsAsWorker } from '../../src/worker/mode.js';
import { cleanHomes, hasTmux, makeHome, waitFor } from '../helpers.js';
import { crashAt, disarmCrash, FLEET, ID, MAC, marker, robot, stateOf, STUDIO, TOKEN, world } from './home-world.js';

const runIf = hasTmux() ? describe : describe.skip;

async function client(d: Daemon): Promise<{ call(method: string, params?: unknown): Promise<Response>; close(): void }> {
  const ws = new WebSocket(`ws://127.0.0.1:${d.port}`);
  await new Promise((r) => ws.once('open', r));
  ws.send(JSON.stringify({ token: d.token }));
  await new Promise((r) => ws.once('message', r));
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

/** The fleet's daemon as the real start runs it, in this process: the gate, the role read after it, and a stop that flushes what it holds. */
class RealDaemon implements HomeDaemon {
  d?: Daemon;
  noAnswer = false;
  constructor(readonly paths: Paths) {}
  async stop(): Promise<void> { await this.d?.stop(); this.d = undefined; }
  async start(): Promise<void> {
    await this.stop();
    this.d = await startDaemon({ home: this.paths.home, port: 0, log: silentLogger, worker: () => startsAsWorker(this.paths, machineId) });
  }
  async answersHome(fleetId: string): Promise<boolean> {
    if (this.noAnswer || !this.d) return false;
    const api = await client(this.d);
    try {
      const { result } = await api.call('fleet.home') as unknown as { result: { mine: boolean; fleetId: string } };
      return result.mine && result.fleetId === fleetId;
    } finally { api.close(); }
  }
  async ask(method: string, params?: unknown): Promise<Response> {
    const api = await client(this.d!);
    try { return await api.call(method, params); } finally { api.close(); }
  }
}

const daemons: RealDaemon[] = [];
const real = (paths: Paths): RealDaemon => { const d = new RealDaemon(paths); daemons.push(d); return d; };
const fleetHome = (): Paths => {
  const home = path.join(makeHome(), 'fleet');
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  return resolvePaths(home);
};

runIf('a home move through real starts', () => {
  afterEach(async () => {
    disarmCrash();
    for (const d of daemons.splice(0)) {
      await d.stop();
      await new Tmux(d.paths.tmuxSock, d.paths.tmuxConf).killServer();
    }
    cleanHomes();
  });

  // a fleet's real first start, with what a home comes to hold: a robot, an island that says something, a note and its worker's token
  const firstStart = async (paths: Paths): Promise<RealDaemon> => {
    const d = real(paths);
    await d.start();
    d.d!.store.update((s) => {
      s.islands.i_a = { ...s.islands[Object.keys(s.islands).find((i) => i !== HOME_ISLAND)!], id: 'i_a', name: 'work', description: 'what it is for' };
      s.robots.c_here = { ...robot('c_here'), islandId: 'i_a', cwd: paths.home };
    });
    fs.mkdirSync(path.join(paths.docs, 'fleet'), { recursive: true });
    fs.writeFileSync(path.join(paths.docs, 'fleet', 'note.md'), 'a note');
    issueToken(paths, STUDIO);
    return d;
  };

  it('the old home: frozen under its marker and refusing writes, then a worker past its guard, with its robots', async () => {
    const paths = fleetHome();
    const d = await firstStart(paths);
    const me = machineId();
    await d.stop();
    const mark = { ...marker(), from: me as MachineId, fromHome: '/home/ada' as never };
    writeMarker(paths, mark);

    await d.start();
    expect(await d.ask('fleet.home')).toMatchObject({ result: { mine: true } });
    expect(await d.ask('robot.update', { id: 'c_here', note: 'x' })).toMatchObject({ error: { code: 'frozen' } });
    expect(await d.ask('fleet.homeMove', { op: 'status' })).toMatchObject({ result: { moving: { id: ID, to: STUDIO, asks: true } } });
    expect(stateOf({ paths } as never).robots.c_here.machine).toBeUndefined();
    await d.stop();

    const enrol = { worker: { homeMachineId: STUDIO, fleetId: FLEET, token: TOKEN, homeName: 'studio' } } as never;
    writeMarker(paths, { ...mark, enrol });
    await d.start();
    expect(await d.ask('fleet.home')).toMatchObject({ result: { mine: false, machine: STUDIO } });
    const s = d.d!.store.state;
    expect(s.robots.c_here.machine).toBe(me);
    expect(s.machines?.[STUDIO]?.snapshot).toBeDefined();
    expect(fs.existsSync(paths.homeMoving)).toBe(false);
    expect(fs.existsSync(`${paths.docs}.home-${ID}/fleet/note.md`)).toBe(true);
    expect(fs.existsSync(paths.workersFile)).toBe(false);
    expect(journalLines(paths, ID).at(-1)?.phase).toBe('done');
    // and again it starts the worker it is, its join not run twice
    const held = fs.readFileSync(`${paths.state}.home-${ID}`, 'utf8');
    await d.stop();
    await d.start();
    expect(await d.ask('fleet.home')).toMatchObject({ result: { mine: false } });
    expect(fs.readFileSync(`${paths.state}.home-${ID}`, 'utf8')).toBe(held);
  }, 120_000);

  it('an outcome told while it starts ends the daemon all the same, whoever asks to hear of it later', async () => {
    const paths = resolvePaths(makeHome());
    const daemon = new RealDaemon(paths);
    daemons.push(daemon);
    await daemon.start();
    daemon.d!.fleet.emit('stopped');
    let ended = false;
    daemon.d!.whenStopped(() => { ended = true; });
    expect(ended).toBe(true);
  });

  it('a marker with nothing to tell it starts no home that takes writes through a restart', async () => {
    const paths = fleetHome();
    const d = await firstStart(paths);
    await d.stop();
    const { ask: _ask, ...waits } = marker();
    writeMarker(paths, waits);
    await d.start();
    await d.stop();
    await d.start();
    expect(await d.ask('robot.update', { id: 'c_here', note: 'x' })).toMatchObject({ error: { code: 'frozen' } });
    // a delivered outcome is the one thing that ends it; a thaw is refused
    expect(await d.ask('fleet.thaw', { id: ID })).toMatchObject({ error: { code: 'frozen' } });
    expect(await d.ask('fleet.homeMove', { op: 'told', id: ID })).toMatchObject({ result: {} });
    expect(fs.existsSync(paths.homeMoving)).toBe(false);
    expect(await d.ask('robot.update', { id: 'c_here', note: 'x' })).toMatchObject({ result: {} });
  }, 120_000);

  // a worker from a real start, with its own robot's copy, going by the fleet's id as a joined worker does, and an archive to it from a Mac
  const taking = async () => {
    const w = await world();
    const paths = fleetHome();
    const me = machineId();
    const copy = { ...emptyState(), islands: { i_a: { id: 'i_a', kind: 'island', name: 'work', description: '', instructions: '', context: [], position: { x: 0, y: 0 }, size: { w: 2, h: 2 }, seed: 1 } }, robots: { mine: { ...robot('mine', me as MachineId, 3), tmux: undefined, cwd: paths.home } }, machines: { [MAC]: { name: 'mac', reachable: false, since: 1, home: '/Users/ada', snapshot: { version: 7, at: 1 } } } };
    fs.writeFileSync(paths.state, JSON.stringify(copy));
    fs.writeFileSync(paths.fleetConfig, JSON.stringify({ id: FLEET }));
    fs.writeFileSync(paths.workerFile, JSON.stringify({ homeMachineId: MAC, fleetId: FLEET, token: TOKEN, homeName: 'mac' }));
    const daemon = real(paths);
    await daemon.start();
    await daemon.stop();
    await w.mac.daemon.stop();
    const manifest: HomeManifest = { ...w.manifest, to: me as MachineId };
    const { sha256, bytes } = await packFleet(w.mac.paths, manifest);
    await daemon.start();
    const deps = { paths, me: me as MachineId, daemon, registryDir: makeHome() };
    await stageAdopt(deps, ID, sha256, bytes);
    return { w, paths, daemon, deps, me };
  };

  it('the machine taking the fleet: its running daemon answers as the home, on the fleet relabelled, with nothing left of a worker', async () => {
    const { w, paths, daemon, deps, me } = await taking();
    const a = await installAdopt(deps, ID, w.enrolment);
    expect(a.status).toBe('adopted');
    expect(await daemon.ask('fleet.home')).toMatchObject({ result: { mine: true, machine: me, fleetId: FLEET } });
    const s = daemon.d!.store.state;
    expect(s.robots.here.machine).toBe(MAC);
    expect(s.robots.mine.machine).toBeUndefined();
    expect(Object.values(s.machines ?? {}).some((m) => m.snapshot)).toBe(false);
    expect(fs.existsSync(paths.workerFile)).toBe(false);
    expect(fs.existsSync(paths.epoch)).toBe(false);
    expect(fs.readFileSync(paths.mobilePass, 'utf8')).toBe('the-pass');
    expect(await daemon.ask('robot.update', { id: 'mine', note: 'it takes writes' })).toMatchObject({ result: {} });
  }, 120_000);

  it.each([1, 2, 3, 5, 9])('a crash at restored file %i of a rollback: a real start commits nothing on a worker\'s files, and comes back the worker', async (n) => {
    const { w, paths, daemon, deps } = await taking();
    const fleetBefore = fs.readFileSync(paths.fleetConfig, 'utf8');
    daemon.noAnswer = true;
    crashAt('restore.file', n);
    await expect(installAdopt(deps, ID, w.enrolment)).rejects.toThrow(HomeCrash);
    daemon.noAnswer = false;
    const a = await adoptStatus(deps, ID);
    expect(a).toMatchObject({ status: 'pending', phase: 'rolledback' });
    expect(await daemon.ask('fleet.home')).toMatchObject({ result: { mine: false, machine: MAC } });
    expect(fs.existsSync(paths.workerFile)).toBe(true);
    expect(fs.readFileSync(paths.fleetConfig, 'utf8')).toBe(fleetBefore);
    expect(daemon.d!.store.state.robots.mine.machine).toBe(machineId());
  }, 120_000);

  it('a crash after the stop, called off: the worker comes back up, and the move stays off', async () => {
    const { w, daemon, deps } = await taking();
    crashAt('adopt.stopped');
    await expect(installAdopt(deps, ID, w.enrolment)).rejects.toThrow(HomeCrash);
    expect(daemon.d).toBeUndefined();
    expect(await abortAdopt(deps, ID)).toEqual({ status: 'not-adopted' });
    expect(await daemon.ask('fleet.home')).toMatchObject({ result: { mine: false } });
    expect(await installAdopt(deps, ID, w.enrolment)).toMatchObject({ status: 'not-adopted' });
  }, 120_000);

  it('a home owed the phone tries it once its daemon runs, and journals what came of it', async () => {
    const paths = fleetHome();
    const d = await firstStart(paths);
    await d.stop();
    fs.mkdirSync(paths.homeMoves, { recursive: true });
    fs.writeFileSync(path.join(paths.homeMoves, `${ID}.ndjson`), `${JSON.stringify({ phase: 'adopted', at: 1, detail: 'serve' })}\n`);
    await d.start();
    await waitFor(() => journalLines(paths, ID).some((l) => l.phase === 'served'), 15_000);
    expect(journalLines(paths, ID).filter((l) => l.phase === 'served')).toHaveLength(1);
  }, 60_000);

  it('a worker owes the old home what its status names, and is asked for nothing else', async () => {
    const { paths, daemon } = await taking();
    fs.writeFileSync(paths.homeDeliver, JSON.stringify({ id: ID, ssh: 'ada@nowhere', svallBase: '/x', fleetHome: '/y' }));
    expect(await daemon.ask('fleet.homeMove', { op: 'status' })).toMatchObject({ result: { moving: { id: ID, asks: false } } });
    expect(await daemon.ask('fleet.homeMove', { op: 'abort' })).toMatchObject({ error: { code: 'not_on_worker' } });
    fs.rmSync(paths.homeDeliver);
  }, 60_000);
});
