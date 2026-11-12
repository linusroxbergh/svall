import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import WebSocket from 'ws';
import { emptyState, HOME_ISLAND, MachineId, type HomeManifest, type Response } from '@svall/protocol';
import { HomeCrash } from '../../src/failpoints.js';
import { HomeFreeze } from '../../src/fleet/home-freeze.js';
import { abortAdopt, adoptStatus, enter, installAdopt, journalLines, markKey, packFleet, stageAdopt, type HomeDaemon } from '../../src/fleet/home-move.js';
import { writeOwed } from '../../src/fleet/home-workers.js';
import { enrolLock } from '../../src/kernel-lock.js';
import { HomeDial } from '../../src/link/dialout.js';
import { HomeLinks } from '../../src/link/home.js';
import { SshMaster } from '../../src/link/ssh.js';
import { HomeConnection } from '../../src/link/worker.js';
import { silentLogger } from '../../src/log.js';
import { machineId, putRecord } from '../../src/machine.js';
import { startDaemon, type Daemon } from '../../src/main.js';
import { dialSocket, resolvePaths, type Paths } from '../../src/paths.js';
import { issueToken } from '../../src/placement/workers.js';
import { Tmux } from '../../src/tmux/tmux.js';
import { startsAsWorker } from '../../src/worker/mode.js';
import { cleanHomes, hasTmux, makeHome, waitFor } from '../helpers.js';
import { ADOPT_KEY, crashAt, disarmCrash, FLEET, ID, KEY, MAC, marker, robot, stateOf, STUDIO, TOKEN, world, putMarker } from './home-world.js';

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

  describe('the check asks the machine taking the fleet of each path that changes', () => {
    const NONE = 'svall-holds-no-such-folder';
    afterEach(() => { vi.restoreAllMocks(); });
    const config = (paths: Paths, cwd: string) => fs.writeFileSync(paths.fleetConfig, JSON.stringify({ ...JSON.parse(fs.readFileSync(paths.fleetConfig, 'utf8')), defaultCwd: cwd }));

    it('going out, over the link to the worker, and says what it answers', async () => {
      const paths = fleetHome();
      const d = await firstStart(paths);
      await d.stop();
      config(paths, path.join(os.homedir(), NONE));
      await d.start();
      const call = vi.spyOn(HomeLinks.prototype, 'call').mockResolvedValue({ machineId: STUDIO, release: 'r', protocol: 1, stateSchema: 1, clock: Date.now(), fleetHome: '/home/ada/.svall', tailscale: {}, paths: { [`~/${NONE}`]: false } });
      expect(await d.ask('fleet.homeCheck', { to: STUDIO })).toMatchObject({ result: { sheet: { rewrites: [{ key: 'defaultCwd', to: `~/${NONE}`, lacks: true }] } } });
      expect(call).toHaveBeenCalledWith(STUDIO, 'home.facts', { paths: [`~/${NONE}`, '~/.svall/home'] });
    }, 60_000);

    it('in its own move says the move, not an enrol, as its freeze holds the enrol lock', async () => {
      const paths = fleetHome();
      const d = await firstStart(paths);
      vi.spyOn(HomeLinks.prototype, 'call').mockResolvedValue({ machineId: STUDIO, release: 'r', protocol: 1, stateSchema: 1, clock: Date.now(), fleetHome: '/home/ada/.svall', tailscale: {} });
      vi.spyOn(HomeFreeze.prototype, 'movingId', 'get').mockReturnValue(ID);
      const held = (await enrolLock(paths.home))!;
      try {
        const r = await d.ask('fleet.homeCheck', { to: STUDIO }) as unknown as { result: { refusal: { reason: string; more?: { reason: string }[] } } };
        const reasons = [r.result.refusal, ...(r.result.refusal.more ?? [])].map((m) => m.reason);
        expect([r.result.refusal, ...(r.result.refusal.more ?? [])]).toContainEqual(expect.objectContaining({ reason: 'the fleet is moving already', raw: ID }));
        expect(reasons).not.toContain('a worker is being enrolled');
      } finally { held(); }
    }, 60_000);

    it('names another worker\'s way back by its platform, as the registry has it', async () => {
      const paths = fleetHome();
      const d = await firstStart(paths);
      const vault = MachineId.parse('77777777-8888-9999-aaaa-bbbbbbbbbbbb');
      // no ssh route, so the move cannot carry it
      putRecord(vault, { name: 'linus-vault', platform: 'linux', arch: 'x64', home: '/home/ada', svallBase: '/home/ada/.svall' } as never);
      issueToken(paths, vault);
      vi.spyOn(HomeLinks.prototype, 'call').mockResolvedValue({ machineId: STUDIO, release: 'r', protocol: 1, stateSchema: 1, clock: Date.now(), fleetHome: '/home/ada/.svall', tailscale: {} });
      expect(await d.ask('fleet.homeCheck', { to: STUDIO })).toMatchObject({ result: { refusal: { more: expect.arrayContaining([{ reason: `${vault} is a worker of this fleet too`, action: `remove ${vault} first; after the move, add it again from ${STUDIO}` }]) } } });
    }, 60_000);

    it('coming back, the paths the home names by its own fleet.json, of this machine', async () => {
      const paths = fleetHome();
      fs.writeFileSync(paths.workerFile, JSON.stringify({ homeMachineId: STUDIO, fleetId: FLEET, token: TOKEN, homeName: 'studio', homeSsh: 'ada@studio', homeSocket: dialSocket(resolvePaths('/home/ada/.svall'), machineId()), homeSvallBase: '/opt/svall' }));
      vi.spyOn(HomeDial.prototype, 'start').mockImplementation(() => {});
      const rewrites = [{ key: 'defaultCwd', to: `~/${NONE}` }, { key: 'home.cwd', to: '~' }];
      const run = vi.fn().mockResolvedValue({ code: 0, signal: null, stderr: '', stdout: JSON.stringify({ machineId: STUDIO, fleetId: FLEET, release: 'r', protocol: 1, stateSchema: 1, clock: Date.now(), fleetHome: '/home/ada/.svall', tailscale: {}, rewrites }) });
      vi.spyOn(HomeDial.prototype, 'master').mockReturnValue({ run } as never);
      const d = real(paths);
      await d.start();
      config(paths, path.join(os.homedir(), 'what-this-worker-holds'));
      expect(await d.ask('fleet.homeCheck', { to: machineId() })).toMatchObject({ result: { sheet: { rewrites: [{ key: 'defaultCwd', to: `~/${NONE}`, lacks: true }, { key: 'home.cwd', to: '~' }] } } });
    }, 60_000);
  });

  describe('what the machine taking the fleet answers of the other workers', () => {
    afterEach(() => { vi.restoreAllMocks(); });

    it('a worker that dials out is never asked what it reaches, as it probes in its own process; one its home dials is', async () => {
      let served: Record<string, unknown> = {};
      const start = HomeConnection.prototype.start;
      vi.spyOn(HomeConnection.prototype, 'start').mockImplementation(function (this: HomeConnection) { served = (this as unknown as { o: { handlers: Record<string, unknown> } }).o.handlers; return start.call(this); });
      vi.spyOn(HomeDial.prototype, 'start').mockImplementation(() => {});
      for (const dials of [true, false]) {
        const paths = fleetHome();
        const out = { homeSsh: 'ada@studio', homeSocket: dialSocket(resolvePaths('/home/ada/.svall'), machineId()), homeSvallBase: '/opt/svall' };
        fs.writeFileSync(paths.workerFile, JSON.stringify({ homeMachineId: STUDIO, fleetId: FLEET, token: TOKEN, homeName: 'studio', ...(dials && out) }));
        const d = real(paths);
        await d.start();
        expect(Object.hasOwn(served, 'home.facts')).toBe(true);
        expect(Object.hasOwn(served, 'home.reach')).toBe(!dials);
        await d.stop();
      }
    }, 60_000);

    it('an answer this release cannot read is one that could not be asked, not an error of the check, and a second Mac is refused all the same', async () => {
      const W = '77777777-0000-4000-8000-000000000000' as MachineId;
      const MAC2 = '88888888-0000-4000-8000-000000000000' as MachineId;
      putRecord(W, { name: 'reach-box', ssh: 'ada@reach-box', platform: 'linux', arch: 'arm64', home: '/home/ada', svallBase: '/home/ada/.local/share/svall' });
      // the check counts only the workers the registry lists
      putRecord(MAC2, { name: 'reach-mac', platform: 'darwin', arch: 'arm64', home: '/Users/ada', svallBase: '/Users/ada/.local/share/svall', dial: 'worker' });
      onTestFinished(() => { putRecord(W, undefined); putRecord(MAC2, undefined); });
      const paths = fleetHome();
      const d = await firstStart(paths);
      issueToken(paths, W);
      issueToken(paths, MAC2);
      const facts = { machineId: STUDIO, release: 'r', protocol: 1, stateSchema: 1, clock: Date.now(), fleetHome: '/home/ada/.svall', tailscale: {}, paths: {} };
      // a kind a later release knows
      const reach = { [W]: { ok: false, ssh: 'ada@reach-box', kind: 'from-a-later-release' } };
      vi.spyOn(HomeLinks.prototype, 'call').mockImplementation(((_m: MachineId, method: string) => Promise.resolve(method === 'home.reach' ? reach : facts)) as never);
      const r = await d.ask('fleet.homeCheck', { to: STUDIO }) as unknown as { result: { ok: boolean; refusal: { reason: string; more?: { reason: string }[] } } };
      expect(r.result.ok).toBe(false);
      const reasons = [r.result.refusal, ...(r.result.refusal.more ?? [])].map((m) => m.reason).join('\n');
      expect(reasons).toContain('could not be asked whether it reaches the other workers');
      expect(reasons).toContain(`${MAC2} is a worker of this fleet too`);
    }, 60_000);
  });

  it('the old home: frozen under its marker and refusing writes, then a worker past its guard, with its robots', async () => {
    const paths = fleetHome();
    const d = await firstStart(paths);
    const me = machineId();
    await d.stop();
    const mark = { ...marker(), from: me as MachineId, fromHome: '/home/ada' as never };
    putMarker(paths, mark);

    await d.start();
    expect(await d.ask('fleet.home')).toMatchObject({ result: { mine: true } });
    expect(await d.ask('robot.update', { id: 'c_here', note: 'x' })).toMatchObject({ error: { code: 'frozen' } });
    expect(await d.ask('fleet.homeMove', { op: 'status' })).toMatchObject({ result: { moving: { id: ID, to: STUDIO, asks: true } } });
    expect(stateOf({ paths } as never).robots.c_here.machine).toBeUndefined();
    await d.stop();

    const enrol = { worker: { homeMachineId: STUDIO, fleetId: FLEET, token: TOKEN, homeName: 'studio' } } as never;
    putMarker(paths, { ...mark, enrol });
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
    putMarker(paths, waits);
    await d.start();
    await d.stop();
    await d.start();
    expect(await d.ask('robot.update', { id: 'c_here', note: 'x' })).toMatchObject({ error: { code: 'frozen' } });
    // a delivered outcome is the one thing that ends it; a thaw is refused
    expect(await d.ask('fleet.thaw', { id: ID })).toMatchObject({ error: { code: 'frozen' } });
    expect(await d.ask('fleet.homeMove', { op: 'told', id: ID, key: 'typed by hand' })).toMatchObject({ error: { message: expect.stringMatching(/not ended by told/) } });
    expect(fs.existsSync(paths.homeMoving)).toBe(true);
    expect(await d.ask('fleet.homeMove', { op: 'told', id: ID, key: KEY })).toMatchObject({ result: {} });
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
    const a = await installAdopt(deps, ID, ADOPT_KEY, w.enrolment);
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
    await expect(installAdopt(deps, ID, ADOPT_KEY, w.enrolment)).rejects.toThrow(HomeCrash);
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
    await expect(installAdopt(deps, ID, ADOPT_KEY, w.enrolment)).rejects.toThrow(HomeCrash);
    expect(daemon.d).toBeUndefined();
    expect(await abortAdopt(deps, ID)).toEqual({ status: 'not-adopted' });
    expect(await daemon.ask('fleet.home')).toMatchObject({ result: { mine: false } });
    expect(await installAdopt(deps, ID, ADOPT_KEY, w.enrolment)).toMatchObject({ status: 'not-adopted' });
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

  it('a home frozen under no marker opens no ssh to a worker it owes, though the freeze\'s lock alone would let it; once it thaws, it does', async () => {
    const W = '99999999-0000-4000-8000-000000000000' as MachineId;
    putRecord(W, { name: 'owed-box', ssh: 'ada@owed-box', platform: 'linux', arch: 'arm64', home: '/home/ada', svallBase: '/home/ada/.local/share/svall' });
    onTestFinished(() => { putRecord(W, undefined); vi.restoreAllMocks(); });
    // the home's own links would dial it too
    vi.spyOn(HomeLinks.prototype, 'start').mockImplementation(() => {});
    const open = vi.spyOn(SshMaster, 'open').mockRejectedValue(new Error('no ssh in this test'));
    let frozen = true;
    vi.spyOn(HomeFreeze.prototype, 'active', 'get').mockImplementation(() => frozen);
    const paths = fleetHome();
    const d = real(paths);
    await d.start();
    enter(paths, ID, 'adopted');
    writeOwed(paths, ID, [W]);
    issueToken(paths, W);
    // as a freeze holds it from its pause
    const held = await enrolLock(paths.home);
    expect(held).toBeDefined();
    await new Promise((r) => { setTimeout(r, 7_000); });
    expect(open).not.toHaveBeenCalled();
    frozen = false;
    held?.();
    await waitFor(() => open.mock.calls.length > 0, 15_000);
    expect(open).toHaveBeenCalledWith(expect.objectContaining({ destination: 'ada@owed-box' }));
    await d.stop();
  }, 60_000);

  it('a worker owes the old home what its status names, and is asked for nothing else', async () => {
    const { paths, daemon } = await taking();
    fs.writeFileSync(paths.homeDeliver, JSON.stringify({ id: ID, ssh: 'ada@nowhere', svallBase: '/x', fleetHome: '/y', from: MAC, fleetId: FLEET }));
    expect(await daemon.ask('fleet.homeMove', { op: 'status' })).toMatchObject({ result: { moving: { id: ID, asks: false, unmarked: true } } });
    markKey(paths, ID);
    expect(((await daemon.ask('fleet.homeMove', { op: 'status' })) as { result: { moving: object } }).result.moving).not.toHaveProperty('unmarked');
    expect(await daemon.ask('fleet.homeMove', { op: 'abort' })).toMatchObject({ error: { code: 'not_on_worker' } });
    fs.rmSync(paths.homeDeliver);
  }, 60_000);
});
