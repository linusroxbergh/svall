import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, MachineId, type SetupRow } from '@svall/protocol';
import { answer, dispatch, systemInfo, type Ctx } from '../src/api/methods.js';
import { Config } from '../src/config.js';
import { NotFound } from '../src/errors.js';
import { Fleet } from '../src/fleet.js';
import { silentLogger } from '../src/log.js';
import { machineId } from '../src/machine.js';
import { resolvePaths } from '../src/paths.js';
import { readConsent } from '../src/placement/mirror-consent.js';
import { PRIVATE, profileHome } from '../src/profile.js';
import { workspaceRoot } from '../src/resources/scan.js';
import { agentProber, type AgentRun } from '../src/sessions/registry.js';
import { Store } from '../src/store.js';
import type { Tmux } from '../src/tmux/tmux.js';
import { Workspace } from '../src/workspace/workspace.js';
import { TerminalHub } from '../src/terminals.js';
import { hasGit } from './git-fixture.js';
import { cleanHomes, makeHome } from './helpers.js';
import { editJson, farHome, macHome, mirroredFiles, statsOf } from './placement/mirror-homes.js';
import { moveWorld, type MoveWorld } from './placement/move-world.js';
import { H, W, island, placed, robot, until, world } from './placement/world.js';

afterEach(cleanHomes);

// a fleet on this machine that is never started
const unstarted = (store: Store, paths: ReturnType<typeof resolvePaths>) => ({ fleet: new Fleet({ store, tmux: {} as Tmux, paths, config: Config.parse({}), log: silentLogger }) });

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
    const ctx = { store, ...unstarted(store, paths) } as unknown as Ctx;
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
    const { fleet } = unstarted(store, paths);
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
    const ctx = { store, ...unstarted(store, paths) } as unknown as Ctx;
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
  const ctx = (kind: 'app' | 'phone') => ({ fleets, fleet: { renameFleet() {}, async stopAll() {} }, viewer: { kind } }) as unknown as Ctx;

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
    const ctx = { store, workspace, claude, viewer: { kind: 'app' } } as unknown as Ctx;
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
    expect(await dispatch({ id: 1, method: 'fleet.rename', params: { name: 'x' } }, { fleet, viewer: { kind: 'app' } } as unknown as Ctx))
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
    const ctx = { store: home.store, fleet: home.fleet, router: home.router, placement: home.placement, viewer: { kind: 'app' } } as unknown as Ctx;
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
    const refusal = { reason: 'Mission control stays on this Mac', action: 'Move a robot from another island', details: [] };
    expect(await dispatch({ id: 2, method: 'robot.moveCheck', params: { id: 'c_1', machine: W } }, ctx)).toEqual({ id: 2, result: { ok: false, refusal } });
    expect(await dispatch({ id: 3, method: 'robot.moveTo', params: { id: 'c_1', machine: W } }, ctx)).toEqual({
      id: 3, error: { code: 'refused', message: 'Mission control stays on this Mac; move a robot from another island', data: { refusal } },
    });
    expect(home.store.state.robots.c_1.machine).toBeUndefined();
  });

  it('robot.moveTo answers the move id once the robot runs there, and machines.list counts it', async () => {
    const { home, ctx } = await started();
    const moved = await dispatch({ id: 1, method: 'robot.moveTo', params: { id: 'c_1', machine: W } }, ctx) as { result: { moveId: string } };
    expect(moved.result.moveId).toMatch(/^mv_[0-9a-z]{10}$/);
    expect(home.store.state.robots.c_1.machine).toBe(W);
    expect(await dispatch({ id: 2, method: 'machines.list' }, ctx)).toEqual({ id: 2, result: { machines: [{ id: W, name: 'w1', role: 'worker', platform: undefined, reachable: true, since: expect.any(Number), release: '1.2.3', robots: 1 }] } });
    // a move that is done has nothing left to run on
    expect(await dispatch({ id: 3, method: 'robot.moveRetry', params: { moveId: moved.result.moveId } }, ctx)).toMatchObject({ id: 3, error: { code: 'invalid' } });
  });
});

describe('machines.refresh', () => {
  it('has the home link each machine enrolled since it started, and does nothing on a worker', async () => {
    let refreshed = 0;
    const ctx = { viewer: { kind: 'app' }, links: { refresh: () => { refreshed++; } } } as unknown as Ctx;
    expect(await dispatch({ id: 1, method: 'machines.refresh' }, ctx)).toEqual({ id: 1, result: {} });
    expect(refreshed).toBe(1);
    expect(await dispatch({ id: 2, method: 'machines.refresh' }, { ...ctx, links: undefined })).toEqual({ id: 2, result: {} });
  });
});

describe('machines.limits and machines.setLimits', () => {
  const ME = '11111111-1111-4111-8111-111111111111';
  const FAR = '22222222-2222-4222-8222-222222222222';
  const report = (limits: object = {}) => ({ size: { cores: 12, memoryMb: 96_000 }, suggested: { cpus: 11, memoryMb: 94_976 }, limits, state: 'applied' });
  const base = (o: object = {}) => ({
    viewer: { kind: 'app' }, store: { state: { machines: { [FAR]: { name: 'studio', reachable: true } } } },
    fleetHome: () => ({ machine: ME, name: 'mac', mine: true, me: ME }), registered: () => new Map(), ...o,
  }) as unknown as Ctx;

  it('answers for the machine it runs on, and sets there what is asked, a null part left out', async () => {
    const set: unknown[] = [];
    const ctx = base({ limits: { read: () => Promise.resolve(report()), set: (l: object) => { set.push(l); return Promise.resolve(report(l)); } } });
    expect(await dispatch({ id: 1, method: 'machines.limits', params: { machine: ME } }, ctx)).toEqual({ id: 1, result: report() });
    expect(await dispatch({ id: 1, method: 'machines.limits', params: {} }, ctx)).toEqual({ id: 1, result: report() });
    expect(await dispatch({ id: 2, method: 'machines.setLimits', params: { machine: ME, cpus: null, memoryMb: 8192 } }, ctx)).toEqual({ id: 2, result: report({ memoryMb: 8192 }) });
    expect(await dispatch({ id: 3, method: 'machines.setLimits', params: { machine: ME, cpus: null, memoryMb: null } }, ctx)).toMatchObject({ result: { limits: {} } });
    expect(set).toEqual([{ memoryMb: 8192 }, {}]);
  });

  it('has no limit for a Mac, the one it runs on or a worker', async () => {
    const calls: unknown[] = [];
    const ctx = base({ registered: () => new Map([[FAR, { platform: 'darwin' }]]), links: { call: (...a: unknown[]) => { calls.push(a); return Promise.resolve(report()); } } });
    for (const machine of [ME, FAR]) {
      expect(await dispatch({ id: 1, method: 'machines.setLimits', params: { machine, cpus: 2, memoryMb: null } }, ctx)).toEqual({ id: 1, error: { code: 'not_supported', message: 'a limit is for a Linux machine' } });
    }
    expect(calls).toEqual([]);
  });

  it('asks a worker over its link, and says to upgrade one whose release knows no limit', async () => {
    const calls: unknown[][] = [];
    const ctx = base({ links: { call: (...a: unknown[]) => { calls.push(a.slice(0, 3)); return Promise.resolve(report({ cpus: 4 })); } } });
    expect(await dispatch({ id: 1, method: 'machines.limits', params: { machine: FAR } }, ctx)).toEqual({ id: 1, result: report({ cpus: 4 }) });
    expect(await dispatch({ id: 2, method: 'machines.setLimits', params: { machine: FAR, cpus: 4, memoryMb: null } }, ctx)).toEqual({ id: 2, result: report({ cpus: 4 }) });
    expect(calls).toEqual([[FAR, 'limits.get', {}], [FAR, 'limits.set', { cpus: 4 }]]);
    const old = base({ links: { call: () => Promise.reject(new ApiError('unknown_method', 'unknown method limits.get')) } });
    expect(await dispatch({ id: 3, method: 'machines.limits', params: { machine: FAR } }, old)).toEqual({ id: 3, error: { code: 'not_supported', message: 'studio\'s release has no limits yet; upgrade it from its ⋯ menu' } });
    expect(await dispatch({ id: 4, method: 'machines.limits', params: { machine: '33333333-3333-4333-8333-333333333333' } }, ctx)).toMatchObject({ error: { code: 'not_found' } });
  });

  it('on a worker answers for its own machine alone, asking its home nothing, as the home takes no limit from a worker', async () => {
    const sent: unknown[] = [];
    const router = { onWorker: true, toHome: (...a: unknown[]) => { sent.push(a); return Promise.resolve(report()); } };
    const ctx = base({ router, fleetHome: () => ({ machine: FAR, name: 'studio', mine: false, me: ME }), limits: { read: () => Promise.resolve(report({ cpus: 2 })) } });
    expect(await dispatch({ id: 1, method: 'machines.limits', params: { machine: ME } }, ctx)).toEqual({ id: 1, result: report({ cpus: 2 }) });
    expect(await dispatch({ id: 2, method: 'machines.limits', params: { machine: FAR } }, ctx)).toMatchObject({ id: 2, error: { code: 'not_found' } });
    expect(sent).toEqual([]);
    const home = base({ limits: { read: () => Promise.resolve(report()), set: () => Promise.resolve(report()) } });
    for (const method of ['machines.limits', 'machines.setLimits']) {
      await expect(answer(method, { machine: ME, cpus: 1, memoryMb: null }, home, FAR as MachineId)).rejects.toMatchObject({ code: 'unauthorized' });
    }
  });

  it('is no phone\'s to ask', async () => {
    const ctx = base({ viewer: { kind: 'phone' }, limits: { read: () => Promise.resolve(report()), set: () => Promise.resolve(report()) } });
    expect(await dispatch({ id: 1, method: 'machines.limits', params: { machine: ME } }, ctx)).toMatchObject({ error: { code: 'forbidden' } });
    expect(await dispatch({ id: 2, method: 'machines.setLimits', params: { machine: ME, cpus: 1, memoryMb: null } }, ctx)).toMatchObject({ error: { code: 'forbidden' } });
  });
});

describe('machines.setup and machines.consent', () => {
  let worker: ReturnType<typeof farHome>;
  let w: ReturnType<typeof world>;
  afterEach(() => w.stop());
  const byKey = (key: string) => (r: SetupRow) => r.key === key;
  const call = async (ctx: Ctx, method: 'machines.setup' | 'machines.consent' | 'machines.setVar', params: object): Promise<{ rows: SetupRow[] }> => {
    const res = await dispatch({ id: 1, method, params }, ctx);
    if ('error' in res) throw new Error(`${res.error.code}: ${res.error.message}`);
    return res.result as { rows: SetupRow[] };
  };
  const workerJson = () => JSON.parse(fs.readFileSync(worker.claudeJson, 'utf8'));
  // every file the mirror writes on the worker but the one that holds linear
  const others = () => statsOf(mirroredFiles(worker).filter((f) => f !== worker.claudeJson));
  const linked = async () => {
    worker = farHome();
    w = world({ mirror: { home: macHome(), worker } });
    await w.link();
    await w.home.links.pushMirror(W);
  };

  it('machines.consent on ticks a server\'s fields, mirrors only that change, and answers rows with the server ok and its keys on the worker', async () => {
    await linked();
    const before = others();
    const r = await call(w.home.ctx, 'machines.consent', { machine: W, item: 'claude:mcp:linear', fields: ['env.LINEAR_API_KEY'], on: true });
    expect(r.rows.find(byKey('claude:mcp:linear'))).toMatchObject({ status: 'ok', detail: 'copied', tick: { on: true } });
    expect(workerJson().mcpServers.linear.env.LINEAR_API_KEY).toBe('lin_api_1234567890');
    expect(others()).toEqual(before);
  });

  it('machines.consent off empties the copied keys there on the same call', async () => {
    await linked();
    await call(w.home.ctx, 'machines.consent', { machine: W, item: 'claude:mcp:linear', fields: ['env.LINEAR_API_KEY'], on: true });
    const r = await call(w.home.ctx, 'machines.consent', { machine: W, item: 'claude:mcp:linear', fields: [], on: false });
    expect(workerJson().mcpServers.linear.env).toEqual({ LINEAR_API_KEY: '${LINEAR_API_KEY}' });
    expect(r.rows.find(byKey('claude:mcp:linear'))).toMatchObject({ status: 'warn', detail: 'not copied', action: 'Tick to copy, or set LINEAR_API_KEY on w1: svall worker env LINEAR_API_KEY', tick: { on: false } });
  });

  it('machines.consent answers not_mirrored, naming no value, when the worker does not apply the change, and the untick stays saved', async () => {
    await linked();
    await call(w.home.ctx, 'machines.consent', { machine: W, item: 'claude:mcp:linear', fields: ['env.LINEAR_API_KEY'], on: true });
    w.worker.handlers['config.apply'] = async () => { throw new Error('ENOSPC: no space left on device'); };
    const res = await dispatch({ id: 1, method: 'machines.consent', params: { machine: W, item: 'claude:mcp:linear', fields: [], on: false } }, w.home.ctx);
    expect(res).toMatchObject({ id: 1, error: { code: 'not_mirrored', message: 'Saved; w1 has not taken it yet', data: { raw: expect.stringContaining('ENOSPC: no space left on device') } } });
    expect(JSON.stringify(res)).not.toContain('lin_api_1234567890');
    expect(readConsent(w.home.paths.mirrorConsent, W).size).toBe(0);
  });

  it('machines.consent answers not_mirrored while this Mac cannot read the item\'s file, the untick saved, and the next readable push empties the copy', async () => {
    const mac = macHome();
    worker = farHome();
    w = world({ mirror: { home: mac, worker } });
    await w.link();
    await w.home.links.pushMirror(W);
    await call(w.home.ctx, 'machines.consent', { machine: W, item: 'claude:mcp:linear', fields: ['env.LINEAR_API_KEY'], on: true });
    const good = fs.readFileSync(mac.claudeJson, 'utf8');
    fs.writeFileSync(mac.claudeJson, '{ "mcpServers": ');
    const res = await dispatch({ id: 1, method: 'machines.consent', params: { machine: W, item: 'claude:mcp:linear', fields: [], on: false } }, w.home.ctx);
    expect(res).toEqual({ id: 1, error: { code: 'not_mirrored', message: `this Mac cannot read ${mac.claudeJson}; w1 keeps its copy` } });
    expect(readConsent(w.home.paths.mirrorConsent, W).size).toBe(0);
    expect(workerJson().mcpServers.linear.env.LINEAR_API_KEY).toBe('lin_api_1234567890');
    fs.writeFileSync(mac.claudeJson, good);
    await w.home.mirror!.push(w.home.links.for(W)!);
    expect(workerJson().mcpServers.linear.env.LINEAR_API_KEY).toBe('${LINEAR_API_KEY}');
  });

  it('machines.consent with the link down saves the change, and the key rows say it takes effect when the machine links', async () => {
    worker = farHome();
    w = world({
      mirror: { home: macHome(), worker }, connect: async () => { throw new Error('connection refused'); },
      home: { machines: { [W]: { name: 'w1', reachable: false, since: 0 } } },
    });
    const { rows } = await call(w.home.ctx, 'machines.consent', { machine: W, item: 'claude:mcp:linear', fields: ['env.LINEAR_API_KEY'], on: true });
    expect(rows.find(byKey('claude:mcp:linear'))).toMatchObject({ detail: 'saved; applies when w1 is back', action: 'Check again', tick: { on: true } });
    expect(rows.find(byKey('codex:mcp:github'))).toMatchObject({ detail: 'not checked: w1 is not reachable', action: 'Tick to copy, or set GITHUB_TOKEN on w1: svall worker env GITHUB_TOKEN' });
  });

  it('machines.consent refuses a machine not in the fleet before it saves anything', async () => {
    await linked();
    const other = MachineId.parse(crypto.randomUUID());
    expect(await dispatch({ id: 1, method: 'machines.consent', params: { machine: other, item: 'claude:mcp:linear', fields: ['env.LINEAR_API_KEY'], on: true } }, w.home.ctx))
      .toEqual({ id: 1, error: { code: 'not_found', message: `no machine ${other}` } });
    expect(readConsent(w.home.paths.mirrorConsent, other).size).toBe(0);
  });

  it('machines.updateAgents asks the worker to run each update and answers once it has; a machine not in the fleet is not_found', async () => {
    await linked();
    const asked: unknown[] = [];
    w.worker.handlers['agents.update'] = async (p) => { asked.push(p); return {}; };
    expect(await dispatch({ id: 1, method: 'machines.updateAgents', params: { machine: W, kinds: ['claude', 'codex'] } }, w.home.ctx)).toEqual({ id: 1, result: {} });
    expect(asked).toEqual([{ kinds: ['claude', 'codex'] }]);

    w.worker.handlers['agents.update'] = async () => { throw new Error('claude update exited 1: no network'); };
    expect(await dispatch({ id: 2, method: 'machines.updateAgents', params: { machine: W, kinds: ['claude'] } }, w.home.ctx))
      .toMatchObject({ id: 2, error: { message: 'claude update exited 1: no network' } });
    const other = MachineId.parse(crypto.randomUUID());
    expect(await dispatch({ id: 3, method: 'machines.updateAgents', params: { machine: other, kinds: ['claude'] } }, w.home.ctx))
      .toEqual({ id: 3, error: { code: 'not_found', message: `no machine ${other}` } });
  });

  it('machines.updateAgents without a machine runs each update on this Mac', async () => {
    await linked();
    const bin = fs.mkdtempSync(path.join(w.home.paths.home, 'bin-'));
    const said = path.join(bin, 'said');
    fs.writeFileSync(path.join(bin, 'codex'), `#!/bin/sh\necho "codex $*" >> '${said}'\n`, { mode: 0o755 });
    const was = process.env.PATH;
    process.env.PATH = `${bin}:${was}`;
    try {
      expect(await dispatch({ id: 1, method: 'machines.updateAgents', params: { kinds: ['codex'] } }, w.home.ctx)).toEqual({ id: 1, result: {} });
    } finally { process.env.PATH = was; }
    expect(fs.readFileSync(said, 'utf8')).toBe('codex update\n');
  });

  it('machines.setVar writes the value into the worker\'s .env and answers the rows with the variable set; from this Mac, the value this Mac has; a bad value is refused without naming it', async () => {
    await linked();
    const r = await call(w.home.ctx, 'machines.setVar', { machine: W, name: 'REMOTE_TOKEN', value: 'rt_1234567890abcdef' });
    expect(fs.readFileSync(w.worker.paths.env, 'utf8')).toBe('REMOTE_TOKEN=rt_1234567890abcdef\n');
    expect(fs.statSync(w.worker.paths.env).mode & 0o777).toBe(0o600);
    expect(r.rows.find(byKey('var:REMOTE_TOKEN'))).toMatchObject({ status: 'ok', detail: 'set' });

    fs.writeFileSync(w.home.paths.env, 'E=from_mac_1234\n');
    const copied = await call(w.home.ctx, 'machines.setVar', { machine: W, name: 'E', fromMac: true });
    expect(fs.readFileSync(w.worker.paths.env, 'utf8')).toBe('REMOTE_TOKEN=rt_1234567890abcdef\nE=from_mac_1234\n');
    expect(copied.rows.find(byKey('var:E'))).toMatchObject({ status: 'ok' });
    // the rows say which variables this Mac has, for the row's Copy from this Mac
    expect(copied.rows.find(byKey('var:REMOTE_TOKEN'))?.here).toBeUndefined();

    expect(await dispatch({ id: 1, method: 'machines.setVar', params: { machine: W, name: 'NOPE', fromMac: true } }, w.home.ctx))
      .toMatchObject({ id: 1, error: { code: 'invalid_params', message: 'this Mac has no NOPE' } });
    const bad = await dispatch({ id: 2, method: 'machines.setVar', params: { machine: W, name: 'REMOTE_TOKEN', value: ' SECRETVAL' } }, w.home.ctx);
    expect(bad).toMatchObject({ id: 2, error: { code: 'invalid_params', message: expect.stringContaining('cannot be stored') } });
    expect(JSON.stringify(bad)).not.toContain('SECRETVAL');
    expect(fs.readFileSync(w.worker.paths.env, 'utf8')).not.toContain('SECRETVAL');
  });

  it('machines.setVar names the upgrade when the worker runs a release without env.set, and the machine when it is not in the fleet', async () => {
    await linked();
    delete w.worker.handlers['env.set'];
    expect(await dispatch({ id: 1, method: 'machines.setVar', params: { machine: W, name: 'X', value: 'v' } }, w.home.ctx))
      .toMatchObject({ id: 1, error: { code: 'not_mirrored', message: 'w1 runs a release that cannot take a variable from here; upgrade it under Machines' } });
    const other = MachineId.parse(crypto.randomUUID());
    expect(await dispatch({ id: 2, method: 'machines.setVar', params: { machine: other, name: 'X', value: 'v' } }, w.home.ctx))
      .toEqual({ id: 2, error: { code: 'not_found', message: `no machine ${other}` } });
  });

  it('machines.setup with the link down answers the plan rows, the probe-dependent ones saying not checked, within waitMs', async () => {
    worker = farHome();
    w = world({
      mirror: { home: macHome(), worker }, connect: async () => { throw new Error('connection refused'); },
      home: { machines: { [W]: { name: 'w1', reachable: false, since: 0 } } },
    });
    w.home.links.start();
    const started = Date.now();
    const { rows } = await call(w.home.ctx, 'machines.setup', { machine: W, waitMs: 500 });
    expect(Date.now() - started).toBeGreaterThanOrEqual(490);
    expect(Date.now() - started).toBeLessThan(1500);
    expect(rows.find(byKey('claude:mcp:linear'))).toMatchObject({ status: 'warn', detail: 'not checked: w1 is not reachable', action: 'Tick to copy, or set LINEAR_API_KEY on w1: svall worker env LINEAR_API_KEY' });
    expect(rows.find(byKey('var:REMOTE_TOKEN'))).toEqual({ key: 'var:REMOTE_TOKEN', status: 'warn', action: 'Check again', detail: 'not checked: w1 is not reachable' });
  });

  it('machines.setup waits for a link coming up and answers what the worker holds', async () => {
    worker = farHome();
    w = world({ mirror: { home: macHome(), worker } });
    await w.worker.connection.start();
    w.home.links.start();
    const started = Date.now();
    const { rows } = await call(w.home.ctx, 'machines.setup', { machine: W, waitMs: 5_000 });
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(rows.find(byKey('var:REMOTE_TOKEN'))).toMatchObject({ status: 'warn', detail: 'not set · remote reads it', action: 'svall worker env REMOTE_TOKEN', run: 'svall worker env REMOTE_TOKEN' });
  });

  it('machines.setup for a robot answers its agent\'s rows, a project\'s by its folder read under this Mac\'s home where it runs on the worker; an unknown robot is not_found', async () => {
    const mac = macHome();
    const app = path.join(mac.homedir, 'code/app');
    editJson(mac.claudeJson, (j) => { j.projects[app].mcpServers.db.env = { DB_KEY: 'db_key_1234567890' }; });
    const agent = (kind: 'claude' | 'codex') => ({ kind, sessionId: 's', status: 'idle' as const, lastActivityAt: 0 });
    w = world({
      mirror: { home: mac, worker: farHome() }, connect: async () => { throw new Error('connection refused'); },
      home: {
        machines: { [W]: { name: 'w1', reachable: false, since: 0, home: '/home/ada' } },
        robots: {
          c_there: placed({ id: 'c_there', cwd: '/home/ada/code/app/web', agent: agent('claude') }),
          c_here: placed({ id: 'c_here', machine: undefined, placement: undefined, cwd: path.join(mac.homedir, 'code/other'), agent: agent('claude') }),
          c_codex: placed({ id: 'c_codex', cwd: '/home/ada/code/app', agent: agent('codex') }),
          c_second: placed({
            id: 'c_second', machine: undefined, placement: undefined, cwd: path.join(mac.homedir, 'code/other'), agent: agent('claude'),
            second: { cwd: path.join(app, 'web'), agent: agent('codex'), unread: false },
          }),
          c_main: placed({
            id: 'c_main', machine: undefined, placement: undefined, cwd: path.join(mac.homedir, 'code/other'), agent: agent('claude'),
            repo: { root: path.join(mac.homedir, 'code/other'), mainRoot: app, branch: 'fix', isWorktree: true },
          }),
        },
      },
    });
    const keys = async (robot: string) => (await call(w.home.ctx, 'machines.setup', { machine: W, robot })).rows.map((r) => r.key);
    const db = `claude:mcp:db@${app}`;
    expect(await keys('c_there')).toContain(db);
    expect(await keys('c_there')).not.toContain('codex:mcp:github');
    expect(await keys('c_here')).not.toContain(db);
    expect(await keys('c_codex')).toEqual(['codex:mcp:github', 'codex:config']);
    // a second terminal's agent and folder count, and so does the checkout a worktree comes from
    expect(await keys('c_second')).toEqual(expect.arrayContaining([db, 'codex:mcp:github']));
    expect(await keys('c_main')).toContain(db);
    expect(await dispatch({ id: 1, method: 'machines.setup', params: { machine: W, robot: 'c_gone' } }, w.home.ctx)).toEqual({ id: 1, error: { code: 'not_found', message: 'no robot c_gone' } });
  });

  it('machines.setup on a worker answers not_on_worker, machines.consent from a worker is refused by the home, and a phone is refused both', async () => {
    await linked();
    const consent = { machine: W, item: 'claude:mcp:linear', fields: ['env.LINEAR_API_KEY'], on: true };
    expect(await dispatch({ id: 1, method: 'machines.setup', params: { machine: W } }, w.worker.ctx)).toEqual({ id: 1, error: { code: 'not_on_worker', message: 'not on a worker' } });
    expect(await dispatch({ id: 2, method: 'machines.consent', params: consent }, w.worker.ctx)).toMatchObject({ id: 2, error: { code: 'unauthorized' } });
    const phone = { ...w.home.ctx, viewer: { ...w.home.ctx.viewer, kind: 'phone' } } as Ctx;
    expect(await dispatch({ id: 3, method: 'machines.setup', params: { machine: W } }, phone)).toMatchObject({ id: 3, error: { code: 'forbidden' } });
    expect(await dispatch({ id: 4, method: 'machines.consent', params: consent }, phone)).toMatchObject({ id: 4, error: { code: 'forbidden' } });
    expect(readConsent(w.home.paths.mirrorConsent, W).size).toBe(0);
  });
});

describe('a move asked of a daemon that makes none', () => {
  it('is refused as a worker refuses what its home does', async () => {
    const ctx = { viewer: { kind: 'app' } } as unknown as Ctx;
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
        id: 2, result: { socket: tmux.socket, session: 'v-c_1', tmux: tmux.binary, machine: W, via: { ssh: 'w1', controlSocket: '/tmp/svall-501/1-abc' } },
      });
      expect(attached).toEqual([['v-c_1', '@3']]);
    } finally {
      await w.stop();
    }
  });

  it('refuses the terminal of a robot on a worker that dials in, which no ssh route from the home reaches, and asks that worker nothing', async () => {
    const live = placed({ id: 'c_1', name: 'kanban', tmux: { windowId: '@3', paneId: '%3' } });
    const attached: string[][] = [];
    const tmux = { socket: '/s', binary: '/t', attachSession: async (session: string, windowId: string) => { attached.push([session, windowId]); } };
    const w = world({ home: { robots: { c_1: live } }, worker: { robots: { c_1: live } }, tmux, dialIn: true });
    try {
      await w.link();
      expect(w.home.links.for(W)?.via()).toBeUndefined();
      expect(await dispatch({ id: 1, method: 'term.attach', params: { id: 'c_1' } }, w.home.ctx)).toEqual({
        id: 1, error: { code: 'elsewhere', message: 'kanban runs on w1; open it there' },
      });
      expect(attached).toEqual([]);
    } finally {
      await w.stop();
    }
  });

  it("a worker attaches its own robot's terminal itself, home away or not, naming itself, and refuses one elsewhere without asking its home", async () => {
    const here = placed({ id: 'c_1', tmux: { windowId: '@3', paneId: '%3' } });
    const home = robot({ id: 'c_2', name: 'scout', tmux: { windowId: '@4', paneId: '%4' } });
    const tmux = { socket: '/w/tmux.sock', binary: '/w/tmux', attachSession: async () => {} };
    const w = world({ home: { robots: { c_1: here, c_2: home } }, worker: { robots: { c_1: here, c_2: home } }, tmux });
    try {
      const mine = { id: 1, result: { socket: '/w/tmux.sock', session: 'v-c_1', tmux: '/w/tmux', machine: W } };
      expect(await dispatch({ id: 1, method: 'term.attach', params: { id: 'c_1' } }, w.worker.ctx)).toEqual(mine);
      await w.link();
      // named once the home's first snapshot lands
      await until(() => expect(w.worker.store.state.machines?.[H]?.name).toBe('mac'));
      expect(await dispatch({ id: 1, method: 'term.attach', params: { id: 'c_1' } }, w.worker.ctx)).toEqual(mine);
      expect(await dispatch({ id: 2, method: 'term.attach', params: { id: 'c_2' } }, w.worker.ctx)).toEqual({
        id: 2, error: { code: 'elsewhere', message: 'scout runs on mac; open it there' },
      });
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

describe('a window and the fleet\'s home', () => {
  const HOME = crypto.randomUUID() as MachineId;
  const W = crypto.randomUUID() as MachineId;
  const home = { machine: HOME, name: 'studio', mine: true, me: HOME };
  const local = (viewer: object, o: object = {}) => ({ viewer: { kind: 'app', loopback: true, ...viewer }, fleetHome: () => home, ...o }) as unknown as Ctx;

  it('fleet.home and home.connection answer the app alone, and home.connection only over loopback', async () => {
    for (const method of ['fleet.home', 'home.connection', 'home.fallback']) {
      const params = method === 'home.fallback' ? { on: true } : {};
      expect(await dispatch({ id: 1, method, params }, local({ kind: 'phone' }))).toMatchObject({ error: { code: 'forbidden' } });
    }
    const answer = vi.fn(() => Promise.resolve({ machine: HOME, name: 'studio', state: 'connected', token: 'held' }));
    expect(await dispatch({ id: 1, method: 'home.connection', params: {} }, local({ loopback: false }, { homeApi: { answer } }))).toMatchObject({ error: { code: 'forbidden' } });
    expect(answer).not.toHaveBeenCalled();
    expect(await dispatch({ id: 1, method: 'home.connection', params: { retry: true } }, local({}, { homeApi: { answer } }))).toMatchObject({ result: { token: 'held' } });
    expect(answer).toHaveBeenCalledWith(true);
  });

  it('a worker answers what is its window\'s itself, and sends no window\'s call home', async () => {
    const toHome = vi.fn(() => Promise.reject(new Error('sent home')));
    const answer = vi.fn(() => Promise.resolve({ machine: HOME, name: 'studio', state: 'connected', token: 'held' }));
    const router = { onWorker: true, homeConnected: true, toHome, runsHere: () => false, placedAt: () => HOME };
    const ctx = local({}, { router, store: { state: { robots: {} } }, homeApi: { answer }, fleetHome: () => ({ ...home, mine: false }), diagnostics: () => Promise.resolve('this machine') });
    expect(await dispatch({ id: 1, method: 'fleet.home', params: {} }, ctx)).toMatchObject({ result: { mine: false } });
    expect(await dispatch({ id: 2, method: 'home.connection', params: {} }, ctx)).toMatchObject({ result: { token: 'held' } });
    expect(await dispatch({ id: 3, method: 'home.fallback', params: { on: true } }, ctx)).toEqual({ id: 3, result: {} });
    expect(await dispatch({ id: 4, method: 'feedback.preview', params: {} }, ctx)).toEqual({ id: 4, result: { text: 'this machine' } });
    expect(toHome).not.toHaveBeenCalled();
    expect(await dispatch({ id: 5, method: 'robot.read', params: { id: 'c_1' } }, ctx)).toMatchObject({ error: { message: 'sent home' } });
    expect(toHome).toHaveBeenCalledTimes(1);
  });

  it('a home answers that it is the home, with no route and no token', async () => {
    expect(await dispatch({ id: 1, method: 'fleet.home', params: {} }, local({}))).toEqual({ id: 1, result: home });
    expect(await dispatch({ id: 1, method: 'home.connection', params: {} }, local({}))).toEqual({ id: 1, result: { machine: HOME, name: 'studio', state: 'connected' } });
  });

  it('a window in fallback gets the treatment of a phone: its changes wait on no link', async () => {
    const serves = vi.fn(() => false);
    const viewer = { kind: 'app', loopback: true };
    const ctx = { viewer, mutations: { serves }, fleet: { updateRobot: () => ({}) } } as unknown as Ctx;
    await dispatch({ id: 1, method: 'robot.update', params: { id: 'c_1', note: 'x' } }, ctx);
    expect(serves).toHaveBeenLastCalledWith('robot.update', expect.anything(), false);
    expect(await dispatch({ id: 2, method: 'home.fallback', params: { on: true } }, ctx)).toEqual({ id: 2, result: {} });
    await dispatch({ id: 3, method: 'robot.update', params: { id: 'c_1', note: 'x' } }, ctx);
    expect(serves).toHaveBeenLastCalledWith('robot.update', expect.anything(), true);
    await dispatch({ id: 4, method: 'home.fallback', params: { on: false } }, ctx);
    await dispatch({ id: 5, method: 'robot.update', params: { id: 'c_1', note: 'x' } }, ctx);
    expect(serves).toHaveBeenLastCalledWith('robot.update', expect.anything(), false);
  });

  it('a file of a robot on this worker is written here, not refused at the home', async () => {
    const write = vi.fn(() => ({ mtimeMs: 1 }));
    const toHome = vi.fn(() => Promise.reject(new Error('sent home')));
    const robots = { here: { id: 'here', machine: W }, far: { id: 'far' } };
    const router = { onWorker: true, runsHere: (r: { machine?: string }) => r.machine === W, placedAt: () => undefined, rootPlacedAt: () => undefined, toHome };
    const ctx = local({}, { store: { state: { robots } }, router, workspace: { write } });
    expect(await dispatch({ id: 1, method: 'fs.write', params: { id: 'here', path: 'a', text: 'x', mtimeMs: 0 } }, ctx)).toEqual({ id: 1, result: { mtimeMs: 1 } });
    expect(toHome).not.toHaveBeenCalled();
    await dispatch({ id: 2, method: 'fs.write', params: { id: 'far', path: 'a', text: 'x', mtimeMs: 0 } }, ctx);
    expect(toHome).toHaveBeenCalledTimes(1);
  });

  it('machines.list says what a move owes each worker, and when its last try ended', async () => {
    const machines = { [W]: { name: 'mac', reachable: false, since: 0 } };
    const owed = local({}, { store: { state: { machines, robots: {} } }, workersOwed: () => ({ [W]: { why: 'No route to host', tried: 5 } }) });
    expect(await dispatch({ id: 1, method: 'machines.list', params: {} }, owed)).toMatchObject({ result: { machines: [{ id: HOME }, { id: W, joining: 'No route to host', joinTried: 5 }] } });
  });

  it('machines.list names each role, platform and reachability, the home first, whichever machine answers', async () => {
    const machines = { [W]: { name: 'mac', reachable: true, since: 7, release: '0.21' } };
    const robots = { a: {}, b: { machine: W }, c: { machine: HOME } };
    const registered = () => new Map([[W, { platform: 'darwin', dial: 'worker' }]]);
    const onHome = await dispatch({ id: 1, method: 'machines.list', params: {} }, local({}, { store: { state: { machines, robots } }, registered }));
    expect(onHome).toMatchObject({ result: { machines: [
      { id: HOME, name: 'studio', role: 'home', reachable: true, robots: 2 },
      { id: W, name: 'mac', role: 'worker', platform: 'darwin', dialsIn: true, reachable: true, since: 7, robots: 1 },
    ] } });
    // the home answering for itself has no time it was last seen
    expect((onHome as { result: { machines: object[] } }).result.machines[0]).not.toHaveProperty('since');
    const away = local({}, { store: { state: { machines: { ...machines, [HOME]: { name: 'studio', reachable: false, since: 5, release: '0.20' } }, robots } }, registered, fleetHome: () => ({ ...home, mine: false }), router: { homeConnected: false } });
    expect(await dispatch({ id: 2, method: 'machines.list', params: {} }, away)).toMatchObject({ result: { machines: [{ id: HOME, role: 'home', reachable: false, since: 5, release: '0.20' }, { id: W, role: 'worker', since: 7 }] } });
  });
});

describe('mission control in a move of the home', () => {
  const placedWith = () => {
    const asked: unknown[] = [];
    return { asked, placement: { start: (_id: string, _to: string, o: { homeMove?: string }) => { asked.push(o.homeMove); return Promise.resolve('mv'); } } };
  };
  const ID = 'hm_abcdefghij';
  const moveTo = (ctx: Ctx) => dispatch({ id: 1, method: 'robot.moveTo', params: { id: 'c_1', machine: W, homeMove: ID } }, ctx);
  const freeze = (open: boolean, viewer: object) => ({ refusal: () => undefined, admit: () => undefined, mayMoveCrew: (id: string, who: object) => open && id === ID && who === viewer }) as never;

  it('an id no daemon opened, or one opened by another caller, lifts no guard', async () => {
    const viewer = { kind: 'app', loopback: true };
    for (const ctx of [{ viewer }, { viewer, freeze: freeze(false, viewer) }, { viewer, freeze: freeze(true, {}) }, { viewer: { kind: 'phone', loopback: false }, freeze: freeze(true, viewer) }]) {
      const { asked, placement } = placedWith();
      expect(await moveTo({ ...ctx, placement } as unknown as Ctx)).toMatchObject({ result: { moveId: 'mv' } });
      expect(asked).toEqual([undefined]);
    }
  });

  it('the caller that opened it has its id honoured', async () => {
    const viewer = { kind: 'app', loopback: true };
    const { asked, placement } = placedWith();
    await moveTo({ viewer, freeze: freeze(true, viewer), placement } as unknown as Ctx);
    expect(asked).toEqual([ID]);
  });

  it('opening one is not for a phone, nor for a call from past this machine', async () => {
    const opened: unknown[] = [];
    const held = { refusal: () => undefined, admit: () => undefined, open: (id: string) => { opened.push(id); }, status: () => ({}) };
    const open = (viewer: object) => dispatch({ id: 1, method: 'fleet.homeMove', params: { op: 'open', id: ID } }, { viewer, freeze: held } as unknown as Ctx);
    expect(await open({ kind: 'phone', loopback: true })).toMatchObject({ error: { code: 'forbidden' } });
    expect(await open({ kind: 'app', loopback: false })).toMatchObject({ error: { code: 'forbidden' } });
    expect(opened).toEqual([]);
    expect(await open({ kind: 'app', loopback: true })).toMatchObject({ result: {} });
    expect(opened).toEqual([ID]);
  });

  it('a freeze and a thaw answer only on this machine', async () => {
    const held = { refusal: () => undefined, admit: () => undefined, freeze: () => Promise.resolve({}), thaw: () => Promise.resolve() };
    for (const [method, params] of [['fleet.freeze', { id: ID, to: W }], ['fleet.thaw', { id: ID }]] as const) {
      expect(await dispatch({ id: 1, method, params }, { viewer: { kind: 'app', loopback: false }, freeze: held } as unknown as Ctx)).toMatchObject({ error: { code: 'forbidden' } });
    }
  });
});

describe('robot messages held for the user while the fleet moves', () => {
  it('take no answer past the cut, as the new home would ask again, and take one once it is off', async () => {
    const home = makeHome();
    const paths = resolvePaths(home);
    const store = Store.load(paths.state, () => {});
    store.update((d) => { d.robots.c_1 = { ...robot({ id: 'c_1' }), relayed: { n: 3, user: 'u1', held: 'h1' } }; });
    const { fleet } = unstarted(store, paths);
    fleet.holdForMove(true);
    await expect(fleet.answerPrompt('c_1', 'approve', 'h1')).rejects.toMatchObject({ code: 'frozen' });
    expect(store.state.robots.c_1.relayed?.held).toBe('h1');
    fleet.holdForMove(false);
    await fleet.answerPrompt('c_1', 'approve', 'h1');
    expect(store.state.robots.c_1.relayed).toBeUndefined();
  });
});

describe('a home that may freeze', () => {
  it('counts a call that may write from its admission to its answer, a failed one too, and a read not at all', async () => {
    const events: string[] = [];
    const freeze = { refusal: () => undefined, admit: (m: string) => (m === 'state.get' ? undefined : (events.push(`in ${m}`), () => events.push(`out ${m}`))) };
    const viewer = { kind: 'app', loopback: true };
    const placement = { start: () => { events.push('running'); return Promise.reject(new Error('refused')); } };
    expect(await dispatch({ id: 1, method: 'robot.moveTo', params: { id: 'c_1', machine: W } }, { viewer, freeze, placement } as unknown as Ctx)).toMatchObject({ error: {} });
    expect(events).toEqual(['in robot.moveTo', 'running', 'out robot.moveTo']);
  });

  it('refuses what a freeze refuses, without counting it', async () => {
    const events: string[] = [];
    const freeze = { refusal: () => new ApiError('frozen', 'the fleet is moving'), admit: () => { events.push('in'); return undefined; } };
    expect(await dispatch({ id: 1, method: 'robot.moveTo', params: { id: 'c_1', machine: W } }, { viewer: { kind: 'app', loopback: true }, freeze } as unknown as Ctx)).toMatchObject({ error: { code: 'frozen' } });
    expect(events).toEqual([]);
  });
});

describe('fleet.homeMove on a daemon that freezes nothing', () => {
  const moving = { moving: { id: 'hm_abcdefghij', to: '42aa0b1c-2d3e-4f50-8617-9a0b1c2d3e4f', name: 'mac', asks: false } };
  const worker = (homeWaits?: () => unknown) => ({ homeWaits, viewer: { kind: 'app', loopback: true } }) as unknown as Ctx;
  const ask = (op: string, ctx: Ctx) => dispatch({ id: 1, method: 'fleet.homeMove', params: { op } }, ctx);
  it('a worker answers its status with the move it owes the old home, or none', async () => {
    expect(await ask('status', worker(() => moving))).toMatchObject({ result: moving });
    expect(await ask('status', worker())).toMatchObject({ result: {} });
  });
  it('and takes nothing that only a home can do', async () => {
    expect(await ask('abort', worker(() => moving))).toMatchObject({ error: { code: 'not_on_worker' } });
  });
});
