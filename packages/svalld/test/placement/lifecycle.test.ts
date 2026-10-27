import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ApiError, emptyState, type MachineId, type Robot } from '@svall/protocol';
import { Config } from '../../src/config.js';
import { Fleet } from '../../src/fleet.js';
import { silentLogger } from '../../src/log.js';
import { resolvePaths } from '../../src/paths.js';
import { Router } from '../../src/placement/router.js';
import { Store } from '../../src/store.js';
import { tmuxConfText } from '../../src/tmux/conf.js';
import { Tmux } from '../../src/tmux/tmux.js';
import { cleanHomes, hasTmux, makeHome, waitForPolls } from '../helpers.js';
import { H, W, island, placed, robot } from './world.js';

const runIf = hasTmux() ? describe : describe.skip;
const SID = '3f2b8c1e-6a4d-4e7b-9c21-5d8f0a1b2c3d';
const agent = { kind: 'claude' as const, sessionId: SID, status: 'working' as const, lastActivityAt: 1, pid: process.pid };

// the calls either end sent the other, which no test here should make
const sent: string[] = [];
const down = <T>(method: string): Promise<T> => { sent.push(method); return Promise.reject(new ApiError('not_reachable', 'down')); };

/** A started fleet on a tmux of its own, as the home (`home` absent) or as a worker of the home `home` names. */
async function side(me: MachineId, robots: Record<string, Robot>, home?: MachineId) {
  const paths = resolvePaths(makeHome());
  const config = Config.parse({ shell: '/bin/sh', home: { cwd: path.join(paths.home, 'mc') } });
  fs.writeFileSync(paths.tmuxConf, tmuxConfText(config));
  const store = Store.load(paths.state, () => {});
  store.update((d) => { Object.assign(d, { ...emptyState(), islands: { i_1: island }, robots: structuredClone(robots) }); });
  const tmux = new Tmux(paths.tmuxSock, paths.tmuxConf);
  const router = home
    ? new Router({ store, me, log: silentLogger, home: { id: home, connection: { call: (method) => down(method), connected: () => false } } })
    : new Router({ store, me, log: silentLogger, links: { call: (_machine, method) => down(method) } });
  const fleet = new Fleet({
    store, tmux, paths, config, log: silentLogger, pollMs: 100, processes: async () => [], readProcs: async () => [], remote: router,
  });
  stops.push(async () => { await fleet.stop(); await tmux.killServer(); });
  await fleet.start();
  return { store, fleet };
}

const stops: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const s of stops.splice(0)) await s();
  sent.length = 0;
  cleanHomes();
});

runIf('the lifecycle of a robot that runs on the other machine', () => {
  it('neither machine\'s poll, revive, hooks or quit touches a robot the other runs', async () => {
    // the ids each machine reported for its windows, which name others on this machine's tmux
    const far = placed({ id: 'c_far', tmux: { windowId: '@1', paneId: '%1' }, agent });
    const farAsleep = placed({ id: 'c_far_asleep', agent: { ...agent, status: 'idle' }, revive: { command: `claude --resume ${SID}`, interrupted: true } });
    const atHome = robot({ id: 'c_home', tmux: { windowId: '@1', paneId: '%1' }, agent });
    const homeAsleep = robot({ id: 'c_home_asleep', agent: { ...agent, status: 'idle' }, revive: { command: `claude --resume ${SID}`, interrupted: true } });
    const home = await side(H, { c_far: far, c_far_asleep: farAsleep });
    const worker = await side(W, { c_home: atHome, c_home_asleep: homeAsleep }, H);

    await Promise.all([waitForPolls(home.fleet, 2), waitForPolls(worker.fleet, 2)]);
    await Promise.all([home.fleet.resumeInterrupted(), worker.fleet.resumeInterrupted()]);
    expect(home.store.state.robots).toEqual({ c_far: far, c_far_asleep: farAsleep });
    expect(worker.store.state.robots).toEqual({ c_home: atHome, c_home_asleep: homeAsleep });
    expect(sent).toEqual([]);
    expect((await home.fleet.loadScope([])).panes.has('c_far')).toBe(false);
    expect(home.fleet.sleepable('c_far', [])).toBe(false);

    // a hook naming the placed robot that reaches the home leaves its record to its machine
    expect(await home.fleet.onSocketEvent({ hook: { robotId: 'c_far', backend: 'claude', name: 'SessionStart', sessionId: SID } })).toBeUndefined();
    await home.fleet.stopAll();
    expect(home.store.state.robots.c_far).toEqual(far);
  });
});
