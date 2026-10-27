import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { dispatch, systemInfo, type Ctx } from '../src/api/methods.js';
import { Config } from '../src/config.js';
import { NotFound } from '../src/errors.js';
import { Fleet } from '../src/fleet.js';
import { silentLogger } from '../src/log.js';
import { machineId } from '../src/machine.js';
import { resolvePaths } from '../src/paths.js';
import { PRIVATE, profileHome } from '../src/profile.js';
import { workspaceRoot } from '../src/resources/scan.js';
import { agentProber, type AgentRun } from '../src/sessions/registry.js';
import { Store } from '../src/store.js';
import type { Tmux } from '../src/tmux/tmux.js';
import { Workspace } from '../src/workspace/workspace.js';
import { TerminalHub } from '../src/terminals.js';
import { hasGit } from './git-fixture.js';
import { cleanHomes, makeHome, ownerOf } from './helpers.js';
import { moveWorld, type MoveWorld } from './placement/move-world.js';
import { W, island, placed, world } from './placement/world.js';

afterEach(cleanHomes);

// a fleet this machine owns, as a daemon with no gateway holds it
const owned = (store: Store, paths: ReturnType<typeof resolvePaths>) => {
  const config = Config.parse({});
  const ownership = ownerOf(paths.home, config.id);
  return { fleet: new Fleet({ store, tmux: {} as Tmux, paths, config, log: silentLogger, ownership }), ownership };
};

// a name every object inherits must find nothing, rather than the prototype
describe('names every object has', () => {
  it('answers a method named like one as unknown', async () => {
    for (const method of ['constructor', 'toString', '__proto__', 'hasOwnProperty']) {
      expect(await dispatch({ id: 1, method }, {} as Ctx)).toMatchObject({ id: 1, error: { code: 'unknown_method' } });
    }
  });

  it('finds no robot or island by such an id, and leaves every other object alone', async () => {
    const paths = resolvePaths(makeHome());
    const store = Store.load(paths.state, () => {});
    const ctx = { store, ...owned(store, paths) } as unknown as Ctx;
    for (const id of ['__proto__', 'constructor', 'toString']) {
      expect(await dispatch({ id: 1, method: 'robot.update', params: { id, name: 'pwned', instructions: 'pwned' } }, ctx)).toMatchObject({ error: { code: 'not_found' } });
      expect(await dispatch({ id: 2, method: 'island.update', params: { id, name: 'pwned', description: 'pwned' } }, ctx)).toMatchObject({ error: { code: 'not_found' } });
      expect(await dispatch({ id: 3, method: 'island.delete', params: { id } }, ctx)).toMatchObject({ error: { code: 'not_found' } });
    }
    expect(({} as { instructions?: string }).instructions).toBeUndefined();
    expect(({} as { description?: string }).description).toBeUndefined();
  });

  it('finds no robot by such an id for a hook or a statusline to report on', async () => {
    const paths = resolvePaths(makeHome());
    const store = Store.load(paths.state, () => {});
    const { fleet } = owned(store, paths);
    const before = structuredClone(store.state);
    for (const robotId of ['__proto__', 'constructor', 'toString']) {
      expect(await fleet.onSocketEvent({ hook: { robotId, backend: 'claude', name: 'SessionStart', sessionId: '11111111-1111-4111-8111-111111111111', pid: process.pid } })).toBeUndefined();
      expect(await fleet.onSocketEvent({ hook: { robotId, backend: 'claude', name: 'Stop', cwd: '/' } })).toBeUndefined();
      expect(await fleet.onSocketEvent({ status: { robotId, contextPct: 40 } })).toBeUndefined();
    }
    expect(store.state).toEqual(before);
    expect(({} as { agent?: unknown }).agent).toBeUndefined();
  });

  it('finds no robot by such an id for its folder to be read', () => {
    const store = Store.load(resolvePaths(makeHome()).state, () => {});
    const claude = { dir: '/nowhere/.claude', json: '/nowhere/.claude.json' };
    for (const id of ['__proto__', 'constructor', 'toString']) expect(() => workspaceRoot(id, store.state, claude)).toThrow(NotFound);
  });

  it('finds no island by such an id to put a robot on', async () => {
    const paths = resolvePaths(makeHome());
    const store = Store.load(paths.state, () => {});
    store.update((d) => {
      d.islands.i_a = { id: 'i_a', name: 'a', description: '', instructions: '', context: [], position: { x: 0, y: 0 }, size: { w: 7, h: 5 }, seed: 1 };
      d.robots.c_a = { id: 'c_a', islandId: 'i_a', cell: { x: 3, y: 2 }, name: 'a', portrait: 'fox', note: '', instructions: '', cwd: '/', context: [], shell: { lastOutputAt: 0 }, unread: false };
    });
    const ctx = { store, ...owned(store, paths) } as unknown as Ctx;
    for (const islandId of ['__proto__', 'constructor']) {
      expect(await dispatch({ id: 1, method: 'robot.create', params: { islandId, cwd: '/' } }, ctx)).toMatchObject({ error: { code: 'not_found' } });
      expect(await dispatch({ id: 2, method: 'robot.update', params: { id: 'c_a', islandId } }, ctx)).toMatchObject({ error: { code: 'not_found' } });
      expect(await dispatch({ id: 3, method: 'robot.move', params: { id: 'c_a', islandId } }, ctx)).toMatchObject({ error: { code: 'not_found' } });
    }
    expect(({} as { size?: unknown }).size).toBeUndefined();
    expect(store.state.robots.c_a.islandId).toBe('i_a');
  });
});

describe('the fleets beside this one', () => {
  const fleets = { list: async () => [], create: async () => '/u/.svall-work', start: async (home: string) => home };
  const ctx = (kind: 'app' | 'phone') => ({ fleets, fleet: { renameFleet() {}, async stopAll() {} }, viewer: { kind }, ownership: { assertOwner() {} } }) as unknown as Ctx;

  it('are refused to a phone', async () => {
    for (const [method, params] of [['fleets.list', {}], ['fleets.create', { name: 'work' }], ['fleets.start', { home: '/u/.svall-work' }], ['fleet.rename', { name: 'home' }], ['fleet.stop', {}]] as const) {
      expect(await dispatch({ id: 1, method, params }, ctx('phone'))).toMatchObject({ error: { code: 'forbidden' } });
    }
  });

  it('are listed, created, started and named for the app', async () => {
    expect(await dispatch({ id: 1, method: 'fleets.list' }, ctx('app'))).toEqual({ id: 1, result: { fleets: [] } });
    expect(await dispatch({ id: 2, method: 'fleets.create', params: { name: 'work' } }, ctx('app'))).toEqual({ id: 2, result: { home: '/u/.svall-work' } });
    expect(await dispatch({ id: 3, method: 'fleets.start', params: { home: '/u/.svall-side' } }, ctx('app'))).toEqual({ id: 3, result: { home: '/u/.svall-side' } });
    expect(await dispatch({ id: 4, method: 'fleet.rename', params: { name: 'home' } }, ctx('app'))).toEqual({ id: 4, result: {} });
    expect(await dispatch({ id: 5, method: 'fleet.stop', params: {} }, ctx('app'))).toEqual({ id: 5, result: {} });
  });

  it('are refused by a daemon off the Mac, which has no launchd to start them with, while its own fleet is still named', async () => {
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
    Object.defineProperty(process, 'platform', { value: 'linux' });
    try {
      for (const [method, params] of [['fleets.list', {}], ['fleets.create', { name: 'work' }], ['fleets.start', { home: '/u/.svall-work' }]] as const) {
        expect(await dispatch({ id: 1, method, params }, ctx('app'))).toEqual({ id: 1, error: { code: 'forbidden', message: `${method} answers only on a Mac` } });
      }
      expect(await dispatch({ id: 2, method: 'fleet.rename', params: { name: 'home' } }, ctx('app'))).toEqual({ id: 2, result: {} });
    } finally {
      Object.defineProperty(process, 'platform', platform);
    }
  });
});

describe('resources.delete', () => {
  it('sets aside only a row the shelf deletes, and resources.restore puts it back', async () => {
    const home = makeHome();
    const store = Store.load(resolvePaths(home).state, () => {});
    const claude = { dir: path.join(home, '.claude'), json: path.join(home, '.claude.json') };
    for (const rel of ['CLAUDE.md', 'settings.json', 'agents/critic.md', 'skills/tidy/SKILL.md']) {
      fs.mkdirSync(path.dirname(path.join(claude.dir, rel)), { recursive: true });
      fs.writeFileSync(path.join(claude.dir, rel), rel);
    }
    const workspace = new Workspace((id) => workspaceRoot(id, store.state, claude), silentLogger, () => [claude.json], [], path.join(home, 'trash'));
    const ctx = { store, workspace, claude, viewer: { kind: 'app' }, ownership: { assertOwner() {} } } as unknown as Ctx;
    const call = (method: string, params: unknown) => dispatch({ id: 1, method, params }, ctx) as Promise<{ result?: { token: string }; error?: { code: string } }>;
    const id = `r:${claude.dir}`;
    for (const rel of ['CLAUDE.md', 'settings.json', 'skills/tidy/SKILL.md', 'agents'])
      expect(await call('resources.delete', { id, path: rel })).toMatchObject({ error: { code: 'invalid' } });
    const agent = (await call('resources.delete', { id, path: 'agents/critic.md' })).result!.token;
    const skill = (await call('resources.delete', { id, path: 'skills/tidy' })).result!.token;
    expect(fs.readdirSync(claude.dir).sort()).toEqual(['CLAUDE.md', 'agents', 'settings.json', 'skills']);
    expect(fs.readdirSync(path.join(claude.dir, 'skills'))).toEqual([]);
    expect(await call('resources.restore', { token: agent })).toMatchObject({ result: {} });
    expect(await call('resources.restore', { token: skill })).toMatchObject({ result: {} });
    expect(fs.readFileSync(path.join(claude.dir, 'agents/critic.md'), 'utf8')).toBe('agents/critic.md');
    expect(fs.readFileSync(path.join(claude.dir, 'skills/tidy/SKILL.md'), 'utf8')).toBe('skills/tidy/SKILL.md');
  });
});

describe('a failed call', () => {
  // agents read the CLI's output, which prints the message as it comes
  it('names the params it refused in a line or two, not a JSON dump', async () => {
    const res = await dispatch({ id: 1, method: 'robot.wait', params: { id: 'c', until: ['foo'] } }, {} as Ctx);
    expect(res).toMatchObject({ error: { code: 'invalid_params' } });
    const { message } = (res as { error: { message: string } }).error;
    expect(message).toMatch(/until/);
    expect(message).not.toMatch(/^\s*\[/);
  });

  it('answers internal for a code no client knows, such as an errno', async () => {
    const fleet = { renameFleet() { throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' }); } };
    expect(await dispatch({ id: 1, method: 'fleet.rename', params: { name: 'x' } }, { fleet, viewer: { kind: 'app' }, ownership: { assertOwner() {} } } as unknown as Ctx))
      .toEqual({ id: 1, error: { code: 'internal', message: 'EACCES: permission denied' } });
  });
});

describe.skipIf(!hasGit)('a move asked through the API', () => {
  const worlds: MoveWorld[] = [];
  afterEach(async () => { for (const w of worlds.splice(0)) await w.stop(); });
  const started = async () => {
    const w = moveWorld();
    worlds.push(w);
    const home = await w.start();
    const ctx = { store: home.store, fleet: home.fleet, router: home.router, placement: home.placement, viewer: { kind: 'app' }, ownership: { assertOwner() {} } } as unknown as Ctx;
    return { home, ctx };
  };

  it('robot.moveCheck answers the sheet for a movable robot and the refusal for mission control', async () => {
    const { home, ctx } = await started();
    expect(await dispatch({ id: 1, method: 'robot.moveCheck', params: { id: 'c_1', machine: W } }, ctx)).toEqual({
      id: 1,
      result: {
        ok: true,
        sheet: {
          sessionBytes: expect.any(Number), branch: 'kanban', commits: 1, changedFiles: 2, untrackedFiles: 1, clone: 'clone', credentialFiles: ['.env'], stays: ['.env stays here'],
          interrupts: false, question: false, notInRepo: false,
        },
      },
    });

    home.store.update((d) => { d.islands.i_home = { ...island, id: 'i_home', kind: 'home' }; d.robots.c_1.islandId = 'i_home'; });
    const refusal = { reason: 'mission control stays on this Mac', action: 'move a robot from another island', details: [] };
    expect(await dispatch({ id: 2, method: 'robot.moveCheck', params: { id: 'c_1', machine: W } }, ctx)).toEqual({ id: 2, result: { ok: false, refusal } });
    expect(await dispatch({ id: 3, method: 'robot.moveTo', params: { id: 'c_1', machine: W } }, ctx)).toEqual({
      id: 3, error: { code: 'refused', message: 'mission control stays on this Mac; move a robot from another island', data: { refusal } },
    });
    expect(home.store.state.robots.c_1.machine).toBeUndefined();
  });

  it('robot.moveTo answers the move id once the robot runs there, and machines.list counts it', async () => {
    const { home, ctx } = await started();
    const moved = await dispatch({ id: 1, method: 'robot.moveTo', params: { id: 'c_1', machine: W } }, ctx) as { result: { moveId: string } };
    expect(moved.result.moveId).toMatch(/^mv_[0-9a-z]{10}$/);
    expect(home.store.state.robots.c_1.machine).toBe(W);
    expect(await dispatch({ id: 2, method: 'machines.list' }, ctx)).toEqual({ id: 2, result: { machines: [{ id: W, name: 'w1', reachable: true, release: '1.2.3', robots: 1 }] } });
    // a move that is done has nothing left to run on
    expect(await dispatch({ id: 3, method: 'robot.moveRetry', params: { moveId: moved.result.moveId } }, ctx)).toMatchObject({ id: 3, error: { code: 'invalid' } });
  });
});

describe('machines.refresh', () => {
  it('has the home link each machine enrolled since it started, and does nothing on a worker', async () => {
    let refreshed = 0;
    const ctx = { viewer: { kind: 'app' }, ownership: { assertOwner() {} }, links: { refresh: () => { refreshed++; } } } as unknown as Ctx;
    expect(await dispatch({ id: 1, method: 'machines.refresh' }, ctx)).toEqual({ id: 1, result: {} });
    expect(refreshed).toBe(1);
    expect(await dispatch({ id: 2, method: 'machines.refresh' }, { ...ctx, links: undefined })).toEqual({ id: 2, result: {} });
  });
});

describe('a move asked of a daemon that makes none', () => {
  it('is refused as a worker refuses what its home does', async () => {
    const ctx = { viewer: { kind: 'app' }, ownership: { assertOwner() {} } } as unknown as Ctx;
    for (const [method, params] of [['robot.moveCheck', { id: 'c_1', machine: W }], ['robot.moveTo', { id: 'c_1', machine: W }], ['robot.moveRetry', { moveId: 'mv_0123456789' }]] as const) {
      expect(await dispatch({ id: 1, method, params }, ctx)).toEqual({ id: 1, error: { code: 'not_on_worker', message: 'not on a worker' } });
    }
  });
});

describe('term.attach for a robot on another machine', () => {
  it("term.attach for a placed robot carries via with the worker's ssh destination and the master socket", async () => {
    const live = placed({ id: 'c_1', tmux: { windowId: '@3', paneId: '%3' } });
    const attached: string[][] = [];
    const tmux = {
      socket: '/home/ada/.svall/tmux.sock', binary: '/home/ada/.local/share/svall/current/bin/tmux',
      attachSession: async (session: string, windowId: string) => { attached.push([session, windowId]); },
    };
    const w = world({ home: { robots: { c_1: live } }, worker: { robots: { c_1: live } }, tmux });
    try {
      // the home's tmux is never asked: a call to it throws
      const terminals = new TerminalHub(w.home.fleet, {} as Tmux, w.home.store, silentLogger, { router: w.home.router, links: w.home.links });
      const ctx = { ...w.home.ctx, terminals } as Ctx;
      expect(await dispatch({ id: 1, method: 'term.attach', params: { id: 'c_1' } }, ctx)).toEqual({ id: 1, error: { code: 'not_reachable', message: 'w1 is not reachable' } });
      await w.link();
      expect(await dispatch({ id: 2, method: 'term.attach', params: { id: 'c_1' } }, ctx)).toEqual({
        id: 2, result: { socket: tmux.socket, session: 'v-c_1', tmux: tmux.binary, via: { ssh: 'w1', controlSocket: '/tmp/svall-501/1-abc' } },
      });
      expect(attached).toEqual([['v-c_1', '@3']]);
    } finally {
      await w.stop();
    }
  });

  it('answers not_reachable for a machine whose link went while the worker answered', async () => {
    const store = Store.load(resolvePaths(makeHome()).state, () => {});
    store.update((d) => { d.machines = { [W]: { name: 'w1', reachable: true, since: 0 } }; });
    const remote = { router: { placedAt: () => W, forward: async () => ({ socket: '/s', session: 'v-c_1', tmux: '/t' }) }, links: { for: () => undefined } };
    const terminals = new TerminalHub({ on() {} } as unknown as Fleet, {} as Tmux, store, silentLogger, remote as unknown as ConstructorParameters<typeof TerminalHub>[4]);
    await expect(terminals.attach('c_1')).rejects.toMatchObject({ code: 'not_reachable', message: 'w1 is not reachable' });
  });
});

describe('system.info', () => {
  it("asks this machine's agent CLIs afresh, which are otherwise probed once a minute at most and shared between callers", async () => {
    let calls = 0;
    const run: AgentRun = async (cmd, args) => {
      calls++;
      const line = [cmd, ...args].join(' ');
      if (line === 'claude --version') return { code: 0, stdout: '2.1.280 (Claude Code)\n' };
      if (line === 'claude auth status') return { code: 0, stdout: JSON.stringify({ loggedIn: true, configDirectory: '/cfg/claude' }) };
      throw Object.assign(new Error(`spawn ${cmd} ENOENT`), { code: 'ENOENT' });
    };
    let now = 0;
    const probe = agentProber({ run, read: async () => undefined, env: {}, homedir: '/home/t' }, 60_000, () => now);
    const [a, b] = await Promise.all([probe(), probe()]);
    expect(a).toBe(b);
    const once = calls;
    now = 59_999;
    await probe();
    expect(calls).toBe(once);
    now = 60_000;
    await probe();
    expect(calls).toBe(once * 2);

    const before = calls;
    const info = await systemInfo({ machineId: machineId(), agents: probe });
    // a login fixed a moment ago counts at the next move check
    expect(calls).toBe(before + once);
    expect(info.agentAdapters).toEqual([
      { kind: 'claude', version: '2.1.280', adapter: 1, home: '/cfg/claude', loggedIn: true, hooks: false },
      { kind: 'codex', adapter: 0, home: '/home/t/.codex', loggedIn: false, hooks: false },
      { kind: 'opencode', adapter: 0, home: path.join(profileHome(PRIVATE, '/home/t'), 'transcripts/opencode'), loggedIn: false, hooks: false },
    ]);
  });

  it("says this machine's lingering where loginctl answers, and nothing on a Mac or where it does not", async () => {
    const info = (linger?: () => Promise<{ user: string; on: boolean }>) => systemInfo({ machineId: machineId(), agents: async () => [], ...(linger && { linger }) });
    expect((await info(async () => ({ user: 'linus', on: false }))).linger).toEqual({ user: 'linus', on: false });
    expect((await info(async () => { throw new Error('loginctl is not installed'); })).linger).toBeUndefined();
    expect((await info()).linger).toBeUndefined();
  });
});
