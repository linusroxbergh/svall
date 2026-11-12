import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_CWD, emptyState, type MachineId } from '@svall/protocol';
import { arrangeIslands, deleteIsland, moveRobotTo, setStar, starRobotAt, newRobotOn, newRobotTarget, newIsland, newIslandAround, newNamedRobot, openSecondTerminal, reviveRobot, saveRobot, saveIsland, serveFleet, skillPrompt, startHomeAction, startHomeRobot } from '../src/actions.js';
import { ApiError, type Api } from '../src/api.js';
import { createAppStore } from '../src/store/index.js';
import { chr, fleet, isl } from './fixtures.js';

function ctx() {
  const calls: { method: string; params: unknown }[] = [];
  const api = {
    call: (method: string, params: unknown) => {
      calls.push({ method, params });
      return Promise.resolve(method === 'island.create' ? isl('i_new', 'home', 0) : {});
    },
  } as unknown as Api;
  const store = createAppStore(undefined);
  store.getState().setFleet(fleet());
  return { calls, api, store };
}

it('a new robot button starts beside a robot on the machine it starts on: the home it follows, else this Mac', async () => {
  const MAC = 'a1b2c3d4-0000-4000-8000-000000000001' as MachineId;
  const HOME = 'a1b2c3d4-0000-4000-8000-000000000002' as MachineId;
  const c = ctx();
  const f = fleet();
  f.defaultCwd = '/home/ada/projects';
  f.robots.c0.cwd = '/home/ada/far';
  f.robots.c1 = { ...f.robots.c1, cwd: '/Users/ada/here', machine: MAC };
  c.store.getState().setFleet(f);
  const started = async (island: string) => { await newRobotOn(c, island); return (c.calls.at(-1)?.params as { cwd: string }).cwd; };
  expect(await started('i_b')).toBe('/home/ada/far');
  c.store.getState().setVia({ machine: MAC, home: HOME, online: true });
  expect(await started('i_b')).toBe('/home/ada/far');
  // a home that dials this Mac has the daemon here serve the window, so a new robot starts here
  c.store.getState().setVia({ machine: MAC, home: HOME, online: true, served: true });
  expect(await started('i_b')).toBe('/Users/ada/here');
  c.store.getState().setVia({ machine: MAC, home: HOME });
  expect(await started('i_b')).toBe('/Users/ada/here');
});

describe('the + beside an island with no robot folder beside it', () => {
  const MAC = 'a1b2c3d4-0000-4000-8000-000000000001' as MachineId;
  const HOME = 'a1b2c3d4-0000-4000-8000-000000000002' as MachineId;
  const started = (c: ReturnType<typeof ctx>) => c.calls.filter((k) => k.method === 'robot.create');

  it.each([
    ['following a far home, with only a robot on this Mac there', { machine: MAC, home: HOME, online: true as const }, 'i_b', MAC],
    ['on a far home, on an island with no robot', { machine: MAC, home: HOME, online: true as const }, 'i_e', undefined],
    ['standing in for its home, with only the home\'s robot there', { machine: MAC, home: HOME }, 'i_a', undefined],
    ['on a Mac its home dials, with only the home\'s robot there', { machine: MAC, home: HOME, online: true as const, served: true as const }, 'i_a', undefined],
  ])('%s, asks for the folder and starts nothing', async (_, via, island, machine) => {
    const c = ctx();
    const f = fleet();
    f.defaultCwd = '/Users/ada/projects';
    if (machine) for (const id of ['c0', 'c1']) f.robots[id] = { ...f.robots[id], cwd: '/Users/ada/here', machine };
    c.store.getState().setFleet(f);
    c.store.getState().setVia(via);
    expect(await newRobotOn(c, island, 'k_review')).toBeUndefined();
    expect(started(c)).toEqual([]);
    const s = c.store.getState();
    expect([s.namingRobot, s.selectedIslandId, s.namingColumn]).toEqual([true, island, 'k_review']);
  });

  it('on a Mac home starts in the fleet\'s default as ever, with no dialog', async () => {
    const c = ctx();
    const f = fleet();
    f.defaultCwd = '/Users/ada/projects';
    c.store.getState().setFleet(f);
    await newRobotOn(c, 'i_e');
    expect(started(c).map((k) => k.params)).toEqual([expect.objectContaining({ islandId: 'i_e', cwd: '/Users/ada/projects' })]);
    expect(c.store.getState().namingRobot).toBe(false);
  });

  it('on mission control\'s island keeps its own folder, which the home has', async () => {
    const c = ctx();
    const f = fleet();
    f.home.cwd = '/home/ada/.svall/home';
    f.islands.home = isl('home', 'mission control', 0, { kind: 'home' });
    c.store.getState().setFleet(f);
    c.store.getState().setVia({ machine: MAC, home: HOME, online: true });
    await newRobotOn(c, 'home');
    expect(started(c).map((k) => k.params)).toEqual([expect.objectContaining({ islandId: 'home', cwd: '/home/ada/.svall/home' })]);
    expect(c.store.getState().namingRobot).toBe(false);
  });
});

it('new robot buttons use the chosen main agent and keep shell defaults for existing fleets', async () => {
  const c = ctx();
  await newRobotOn(c, 'i_a');
  expect(c.calls.at(-1)).toMatchObject({ method: 'robot.create', params: { islandId: 'i_a' } });
  expect((c.calls.at(-1)?.params as { command?: string }).command).toBeUndefined();
  c.store.getState().setFleet({ ...fleet(), mainAgent: 'codex', newRobotStart: 'agent' });
  await newRobotOn(c, 'i_a');
  expect(c.calls.at(-1)).toMatchObject({ method: 'robot.create', params: { command: 'codex' } });
  c.store.getState().selectIsland('i_a');
  await newNamedRobot(c, { name: '', note: '', refs: [] });
  expect(c.calls.at(-1)).toMatchObject({ method: 'robot.create', params: { command: 'codex' } });
});

describe('newRobotTarget', () => {
  it('lands beside the selected robot, in its cwd', async () => {
    const c = ctx();
    c.store.getState().setView('board');
    c.store.getState().select('c1');
    expect(await newRobotTarget(c)).toEqual({ islandId: 'i_b', cwd: '/tmp' });
  });

  it('takes the cwd of the robot it is beside, not the island first robot', async () => {
    const c = ctx();
    c.store.getState().setView('board');
    c.store.getState().applyPatch([{ op: 'replace', path: '/robots/c1/cwd', value: '/other' }]);
    c.store.getState().select('c1');
    expect(await newRobotTarget(c)).toEqual({ islandId: 'i_b', cwd: '/other' });
  });

  it('starts in the repo when the robot it is beside sits in a worktree', async () => {
    const c = ctx();
    c.store.getState().setView('board');
    c.store.getState().applyPatch([
      { op: 'replace', path: '/robots/c1/cwd', value: '/repo/.worktrees/wip' },
      { op: 'add', path: '/robots/c1/repo', value: { root: '/repo/.worktrees/wip', mainRoot: '/repo', branch: 'wip', isWorktree: true } },
    ]);
    c.store.getState().select('c1');
    expect(await newRobotTarget(c)).toEqual({ islandId: 'i_b', cwd: '/repo' });
  });

  it('falls back to the first robot with nothing selected', async () => {
    const c = ctx();
    c.store.getState().setView('board');
    expect(await newRobotTarget(c)).toEqual({ islandId: 'i_a', cwd: '/tmp' });
  });

  it('prefers the island selected on the map, in the fleet default cwd when it has no crew', async () => {
    const c = ctx();
    c.store.getState().selectIsland('i_e');
    expect(await newRobotTarget(c)).toEqual({ islandId: 'i_e', cwd: DEFAULT_CWD });
  });

  it('prefers the island selected on the board', async () => {
    const c = ctx();
    c.store.getState().setView('board');
    c.store.getState().selectIsland('i_e');
    expect(await newRobotTarget(c)).toEqual({ islandId: 'i_e', cwd: DEFAULT_CWD });
  });

  it('creates an island named after the default cwd when mission control is the only one', async () => {
    const c = ctx();
    c.store.getState().setView('board');
    c.store.getState().setFleet({ ...emptyState(), islands: { home: isl('home', 'mission control', 0, { kind: 'home' }) } });
    expect(await newRobotTarget(c)).toEqual({ islandId: 'i_new', cwd: DEFAULT_CWD, made: true });
    expect(c.calls).toEqual([{ method: 'island.create', params: { name: 'island' } }]);
  });

  it('takes the first hidden island when every island is hidden, rather than make another', async () => {
    const c = ctx();
    c.store.getState().setView('board');
    c.store.getState().setFleet({ ...emptyState(), islands: {
      home: isl('home', 'mission control', 0, { kind: 'home' }), i_x: isl('i_x', 'x', 0, { collapsed: true }),
    } });
    expect(await newRobotTarget(c)).toEqual({ islandId: 'i_x', cwd: DEFAULT_CWD });
    expect(c.calls).toEqual([]);
  });
});

describe('moveRobotTo', () => {
  it('joins an island through its header or inserts beside a robot', () => {
    const c = ctx();
    moveRobotTo(c, 'c1', { kind: 'island', id: 'i_a' });
    moveRobotTo(c, 'c1', { kind: 'robot', id: 'c2' });
    expect(c.calls).toEqual([
      { method: 'robot.move', params: { id: 'c1', islandId: 'i_a' } },
      { method: 'robot.reorder', params: { id: 'c1', targetId: 'c2', after: false } },
    ]);
  });

  it('ignores a robot dropped on itself', () => {
    const c = ctx();
    moveRobotTo(c, 'c1', { kind: 'robot', id: 'c1' });
    expect(c.calls).toEqual([]);
  });

  it('inserts a robot within its island instead of swapping cells', () => {
    const c = ctx();
    moveRobotTo(c, 'c1', { kind: 'robot', id: 'c0' }, false);
    expect(c.calls).toEqual([{ method: 'robot.reorder', params: { id: 'c1', targetId: 'c0', after: false } }]);
  });
});

describe('stars', () => {
  it('stars or unstars as asked, and sends nothing for the state a robot already has', () => {
    const c = ctx();
    setStar(c, 'c1', false);
    setStar(c, 'c1', true);
    c.store.getState().applyPatch([{ op: 'add', path: '/robots/c1/star', value: 0 }]);
    setStar(c, 'c1', true);
    setStar(c, 'c1', false);
    expect(c.calls).toEqual([
      { method: 'robot.star', params: { id: 'c1' } },
      { method: 'robot.unstar', params: { id: 'c1' } },
    ]);
  });

  it('places a star beside the starred one it is dropped on, first without one, and not on itself', () => {
    const c = ctx();
    starRobotAt(c, 'c1', 'c2', true);
    starRobotAt(c, 'c1');
    starRobotAt(c, 'c1', 'c1', false);
    expect(c.calls).toEqual([
      { method: 'robot.star', params: { id: 'c1', targetId: 'c2', after: true } },
      { method: 'robot.star', params: { id: 'c1' } },
    ]);
  });
});

describe('newNamedRobot', () => {
  const created = (calls: { method: string; params: unknown }[]) => ({
    call: (method: string, params: unknown) => {
      calls.push({ method, params });
      return Promise.resolve(method === 'robot.create' ? { id: 'c_new' } : {});
    },
  } as unknown as Api);

  it('creates the robot alone when it has neither note nor links', async () => {
    const calls: { method: string; params: unknown }[] = [];
    const store = createAppStore(undefined);
    store.getState().setFleet(fleet());
    store.getState().selectIsland('i_a');
    expect(await newNamedRobot({ api: created(calls), store }, { name: 'scribe', note: '', refs: [] })).toBe('c_new');
    expect(calls).toEqual([{ method: 'robot.create', params: { islandId: 'i_a', cwd: '/tmp', name: 'scribe' } }]);
  });

  it('writes the note and the links on once the robot exists, each link under its own kind', async () => {
    const calls: { method: string; params: unknown }[] = [];
    const store = createAppStore(undefined);
    store.getState().setFleet(fleet());
    store.getState().selectIsland('i_a');
    await newNamedRobot({ api: created(calls), store }, { name: '', note: 'read the spec', refs: ['~/spec.md', 'https://example.com/x'] });
    expect(calls).toEqual([
      { method: 'robot.create', params: { islandId: 'i_a', cwd: '/tmp' } },
      { method: 'robot.update', params: { id: 'c_new', note: 'read the spec', context: [
        { kind: 'file', ref: '~/spec.md', label: '', source: 'manual' },
        { kind: 'other', ref: 'https://example.com/x', label: '', source: 'manual' },
      ] } },
    ]);
  });

  it('keeps the robot and toasts when the fleet refuses the note', async () => {
    const store = createAppStore(undefined);
    store.getState().setFleet(fleet());
    const api = {
      call: (method: string) => (method === 'robot.create' ? Promise.resolve({ id: 'c_new' }) : Promise.reject(new Error('no such path'))),
    } as unknown as Api;
    expect(await newNamedRobot({ api, store }, { name: 'scribe', note: 'read the spec', refs: [] })).toBe('c_new');
    expect(store.getState().toast).toEqual({ text: 'no such path', tone: 'error' });
  });
});

describe('a write the fleet refuses', () => {
  // fire swallows the failure, as the real socket's does, so only a call can report it
  const refusing = () => {
    const api = { call: () => Promise.reject(new Error('svalld offline')), fire: () => {} } as unknown as Api;
    const store = createAppStore(undefined);
    store.getState().setFleet(fleet());
    return { api, store };
  };

  it('is reported on a toast when it saves, revives or deletes', async () => {
    type D = ReturnType<typeof refusing>;
    for (const act of [(d: D) => saveRobot(d, 'c0', { name: 'x' }), (d: D) => saveIsland(d, 'i_a', { name: 'x' }),
      (d: D) => reviveRobot(d, 'c0'), (d: D) => deleteIsland(d, 'i_e')]) {
      const d = refusing();
      act(d);
      await new Promise((r) => setTimeout(r, 0));
      expect(d.store.getState().toast?.text).toBe('svalld offline');
    }
  });
});

describe('an arrange the map makes on its own', () => {
  const arrange = async (e: Error, automatic: boolean) => {
    const store = createAppStore(undefined);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      arrangeIslands({ api: { call: () => Promise.reject(e) } as unknown as Api, store }, 1.5, undefined, automatic);
      await new Promise((r) => setTimeout(r, 0));
      return { toast: store.getState().toast?.text, logged: warn.mock.calls.map((c) => c[0] as string) };
    } finally {
      warn.mockRestore();
    }
  };

  it('says nothing when the fleet refuses it or svalld\'s restart cuts it off', async () => {
    expect(await arrange(new ApiError('frozen', 'the fleet is moving to studio; try again once it has'), true)).toEqual({ toast: undefined, logged: [] });
    expect(await arrange(new Error("Lost the connection to Svall's background service"), true)).toEqual({ toast: undefined, logged: [] });
  });

  it('logs any other failure, and one a person asks for says why on a toast', async () => {
    expect(await arrange(new ApiError('internal', 'arrange failed'), true)).toEqual({ toast: undefined, logged: ['island.arrange: arrange failed'] });
    expect(await arrange(new ApiError('frozen', 'the fleet is moving to studio; try again once it has'), false))
      .toEqual({ toast: 'the fleet is moving to studio; try again once it has', logged: [] });
  });
});

describe('openSecondTerminal', () => {
  it('closes the pane that waited on a second terminal the fleet did not open', async () => {
    const store = createAppStore(undefined);
    store.getState().setFleet(fleet());
    store.getState().setPanes('c0', { left: 'browser', right: 'terminal2' });
    openSecondTerminal({ api: { call: () => Promise.reject(new Error('svalld offline')) } as unknown as Api, store }, 'c0');
    await new Promise((r) => setTimeout(r, 0));
    expect(store.getState().ide.c0.panes).toEqual({ left: 'browser' });
    expect(store.getState().toast?.text).toBe('svalld offline');
  });
});

describe('an edit that never reached the fleet', () => {
  // the field that held it may be gone by the time the answer comes, so the toast keeps it to send again
  it('is kept on the toast to send again once svalld is back', async () => {
    const sent: unknown[] = [];
    let online = false;
    const api = { call: (_m: string, params: unknown) => { sent.push(params); return online ? Promise.resolve({}) : Promise.reject(new Error('svalld offline')); } } as unknown as Api;
    type D = Parameters<typeof saveRobot>[0];
    for (const save of [(d: D) => saveRobot(d, 'c0', { note: 'half a thought' }), (d: D) => saveIsland(d, 'i_a', { description: 'half a thought' })]) {
      online = false;
      sent.length = 0;
      const store = createAppStore(undefined);
      save({ api, store });
      await new Promise((r) => setTimeout(r, 0));
      expect(store.getState().toast).toMatchObject({ text: 'svalld offline', action: { label: 'Retry' } });
      online = true;
      store.getState().runToastAction();
      expect(sent).toHaveLength(2);
      expect(sent[1]).toEqual(sent[0]);
    }
  });

  it('is not offered again when the fleet refused it', async () => {
    const api = { call: () => Promise.reject(new ApiError('invalid', 'another robot is already called x')) } as unknown as Api;
    const store = createAppStore(undefined);
    saveRobot({ api, store }, 'c0', { name: 'x' });
    await new Promise((r) => setTimeout(r, 0));
    expect(store.getState().toast).toEqual({ text: 'another robot is already called x', tone: 'error' });
  });

  it('refused by a fleet moving its home, says it was not saved and where the fleet is going, by this window\'s names', async () => {
    const STUDIO = '22222222-2222-4222-8222-222222222222' as MachineId;
    const ME = '11111111-1111-4111-8111-111111111111' as MachineId;
    const store = createAppStore(undefined);
    store.getState().setFleet({ ...store.getState().fleet, machines: { [STUDIO]: { name: 'studio', reachable: true, since: 0 } } });
    store.getState().setShell({ home: '/h', log: [], op: false, machine: ME });
    const frozen = (to?: string) => ({ call: () => Promise.reject(new ApiError('frozen', 'the fleet is moving to linus-vault; try again once it has', to === undefined ? undefined : { to })) } as unknown as Api);
    expect(await saveRobot({ api: frozen(STUDIO), store }, 'c0', { note: 'half a thought' })).toBe(false);
    expect(store.getState().toast).toEqual({ text: 'Not saved: the fleet is moving to studio.', tone: 'error' });
    await saveIsland({ api: frozen(ME), store }, 'i_a', { name: 'x' });
    expect(store.getState().toast?.text).toBe('Not saved: the fleet is moving to this Mac.');
    await saveRobot({ api: frozen(), store }, 'c0', { note: 'half a thought' });
    expect(store.getState().toast?.text).toBe('the fleet is moving to linus-vault; try again once it has');
  });

  it.each(['not_reachable', 'timeout', 'stopping', 'internal'])('stays to send again when it failed as %s, which the fleet never weighed', async (code) => {
    const api = { call: () => Promise.reject(new ApiError(code, 'studio is not reachable')) } as unknown as Api;
    const store = createAppStore(undefined);
    expect(await saveRobot({ api, store }, 'c0', { note: 'half a thought' })).toBe(true);
    expect(store.getState().toast).toMatchObject({ text: 'studio is not reachable', action: { label: 'Retry' } });
  });

  it.each(['frozen', 'invalid', 'invalid_params', 'not_found', 'moving'])('is put back when the fleet refused it as %s', async (code) => {
    const api = { call: () => Promise.reject(new ApiError(code, 'refused')) } as unknown as Api;
    const store = createAppStore(undefined);
    expect(await saveIsland({ api, store }, 'i_a', { description: 'half a thought' })).toBe(false);
    expect(store.getState().toast).toEqual({ text: 'refused', tone: 'error' });
  });
});

describe('a crew member whose directory is gone', () => {
  type Call = { method: string; params: { cwd?: string } };
  // svalld's refusal of a cwd that is not a directory, as a removed worktree is
  const goneDir = (calls: Call[], message = 'cwd /tmp is not a directory') => ({
    call: (method: string, params: { cwd?: string }) => {
      calls.push({ method, params });
      if (method === 'robot.create' && params.cwd !== DEFAULT_CWD) return Promise.reject(new ApiError('invalid', message));
      return Promise.resolve({ id: 'c_new', name: 'c_new' });
    },
  } as unknown as Api);
  const store = () => { const s = createAppStore(undefined); s.getState().setFleet(fleet()); return s; };

  it('leaves a new robot on its island to start in the fleet default', async () => {
    const calls: Call[] = [];
    const s = store();
    await newRobotOn({ api: goneDir(calls), store: s }, 'i_b');
    expect(calls.map((c) => c.params)).toEqual([{ islandId: 'i_b', cwd: '/tmp' }, { islandId: 'i_b', cwd: DEFAULT_CWD }]);
    expect(s.getState().toast).toBeUndefined();
  });

  it('leaves a named robot beside it to start in the fleet default', async () => {
    const calls: Call[] = [];
    const s = store();
    s.getState().selectIsland('i_a');
    expect(await newNamedRobot({ api: goneDir(calls), store: s }, { name: 'scribe', note: '', refs: [] })).toBe('c_new');
    expect(calls.map((c) => c.params)).toEqual([{ islandId: 'i_a', cwd: '/tmp', name: 'scribe' }, { islandId: 'i_a', cwd: DEFAULT_CWD, name: 'scribe' }]);
  });

  it('on a far home, starts beside the robots there, never in the folder of a robot on this Mac', async () => {
    const calls: Call[] = [];
    const s = store();
    const MAC = '11111111-1111-4111-8111-111111111111' as MachineId;
    const STUDIO = '22222222-2222-4222-8222-222222222222' as MachineId;
    const f = fleet();
    Object.assign(f.robots.c0, { machine: MAC, cwd: '/Users/ada/code' });
    Object.assign(f.robots.c1, { cwd: '/home/linus/app' });
    s.getState().setFleet(f);
    s.getState().setVia({ machine: MAC, home: STUDIO, name: 'studio', online: true });
    const api = { call: (method: string, params: unknown) => { calls.push({ method, params } as Call); return Promise.resolve({ id: 'c_new' }); } } as never;
    await newRobotOn({ api, store: s }, 'i_b');
    expect(calls.map((c) => c.params)).toEqual([{ islandId: 'i_b', cwd: '/home/linus/app' }]);
    s.getState().select('c0');
    expect(await newRobotTarget({ api, store: s })).toEqual({ islandId: 'i_b', cwd: '/home/linus/app' });
    // standing in, it is this Mac's folder that counts
    s.getState().setVia({ machine: MAC, home: STUDIO, name: 'studio' });
    expect(await newRobotTarget({ api, store: s })).toEqual({ islandId: 'i_b', cwd: '/Users/ada/code' });
  });

  it('with no island yet names the fresh one for the folder chosen, and takes it back when that is refused', async () => {
    const calls: Call[] = [];
    const s = createAppStore(undefined);
    s.getState().setFleet(emptyState());
    const refused = Object.assign(new Error('cwd /srv/app is not a directory'), { code: 'not_a_folder' });
    const api = { call: (method: string, params: unknown) => { calls.push({ method, params } as Call); return method === 'robot.create' ? Promise.reject(refused) : Promise.resolve({ id: 'i_new' }); } } as never;
    await expect(newNamedRobot({ api, store: s }, { name: 'a', note: '', refs: [], cwd: '/srv/app' })).rejects.toBe(refused);
    expect(calls.map((c) => [c.method, c.params])).toEqual([
      ['island.create', { name: 'app' }], ['robot.create', expect.objectContaining({ islandId: 'i_new', cwd: '/srv/app' })], ['island.delete', { id: 'i_new' }],
    ]);
  });

  it('keeps the fresh island on any other refusal, as the next try may need it, and a delete that fails hides nothing', async () => {
    for (const [code, kept] of [['not_found', true], ['not_a_folder', false]] as const) {
      const calls: Call[] = [];
      const s = createAppStore(undefined);
      s.getState().setFleet(emptyState());
      const refused = Object.assign(new Error('no island i_new'), { code });
      const api = { call: (method: string, params: unknown) => {
        calls.push({ method, params } as Call);
        return method === 'island.create' ? Promise.resolve({ id: 'i_new' }) : Promise.reject(method === 'island.delete' ? new Error('the delete failed') : refused);
      } } as never;
      await expect(newNamedRobot({ api, store: s }, { name: 'a', note: '', refs: [], cwd: '/srv/app' })).rejects.toBe(refused);
      expect(calls.some((c) => c.method === 'island.delete')).toBe(!kept);
    }
  });

  it('answers a refused folder only once the fresh island has gone', async () => {
    const s = createAppStore(undefined);
    s.getState().setFleet(emptyState());
    let gone: (v: unknown) => void = () => {};
    const refused = Object.assign(new Error('no'), { code: 'not_a_folder' });
    const api = { call: (method: string) => (method === 'island.create' ? Promise.resolve({ id: 'i_new' }) : method === 'island.delete' ? new Promise((r) => { gone = r; }) : Promise.reject(refused)) } as never;
    let settled = false;
    const made = newNamedRobot({ api, store: s }, { name: 'a', note: '', refs: [], cwd: '/srv/app' }).catch(() => { settled = true; });
    await new Promise((r) => setTimeout(r, 0));
    expect(settled).toBe(false);
    gone({});
    await made;
    expect(settled).toBe(true);
  });

  it('leaves an island that was there when the folder chosen is refused', async () => {
    const calls: Call[] = [];
    const s = store();
    const api = { call: (method: string, params: unknown) => { calls.push({ method, params } as Call); return Promise.reject(new Error('no')); } } as never;
    await expect(newNamedRobot({ api, store: s }, { name: 'a', note: '', refs: [], cwd: '/srv/app' })).rejects.toThrow('no');
    expect(calls.map((c) => c.method)).toEqual(['robot.create']);
  });

  it('reports a mission control folder that is gone rather than start the agent somewhere else', async () => {
    const calls: Call[] = [];
    const s = store();
    await newRobotOn({ api: goneDir(calls, 'cwd /mc is not a directory'), store: s }, 'home');
    expect(calls).toHaveLength(1);
    expect(s.getState().toast?.text).toBe('cwd /mc is not a directory');
  });

  it('reports any other refusal without a second try', async () => {
    const calls: Call[] = [];
    const s = store();
    await newRobotOn({ api: goneDir(calls, 'island i_b is full'), store: s }, 'i_b');
    expect(calls).toHaveLength(1);
    expect(s.getState().toast?.text).toBe('island i_b is full');
  });
});

describe('deleteIsland', () => {
  it('keeps the island selected when the fleet refuses, and lets it go once it is gone', async () => {
    const refused = { api: { call: () => Promise.reject(new Error('island i_e has crew')) } as unknown as Api, store: createAppStore(undefined) };
    refused.store.getState().setFleet(fleet());
    refused.store.getState().selectIsland('i_e');
    deleteIsland(refused, 'i_e');
    await new Promise((r) => setTimeout(r, 0));
    expect(refused.store.getState().selectedIslandId).toBe('i_e');
    expect(refused.store.getState().toast?.text).toBe('island i_e has crew');

    const c = ctx();
    c.store.getState().selectIsland('i_e');
    // svalld sends the fleet's patch before it answers the call
    const call = c.api.call;
    c.api.call = ((method: string, params: unknown) => {
      if (method === 'island.delete') c.store.getState().applyPatch([{ op: 'remove', path: '/islands/i_e' }]);
      return call(method as never, params as never);
    }) as Api['call'];
    deleteIsland(c, 'i_e');
    await new Promise((r) => setTimeout(r, 0));
    expect(c.store.getState()).toMatchObject({ selectedIslandId: undefined, sideCardOpen: false });
  });
});

describe('serveFleet', () => {
  const status = (over: Record<string, unknown> = {}) => ({ serving: true, url: 'https://x.ts.net', port: 8443, logins: [], phones: [], ...over });

  it('takes the status the daemon answers with', async () => {
    const store = createAppStore(undefined);
    const api = { call: () => Promise.resolve(status()) } as unknown as Api;
    await serveFleet({ api, store }, true);
    expect(store.getState().mobile).toEqual(status());
    expect(store.getState().toast).toBeUndefined();
  });

  // a link that cannot be made resolves carrying its reason, so the success path has to toast too
  it('toasts the reason when the status carries one', async () => {
    const store = createAppStore(undefined);
    const api = { call: () => Promise.resolve(status({ serving: false, error: 'tailscale is not logged in' })) } as unknown as Api;
    await serveFleet({ api, store }, true);
    expect(store.getState().toast).toEqual({ text: 'tailscale is not logged in', tone: 'error' });
    expect(store.getState().mobileOpen).toBe(false);
  });

  it('toasts a rejection as well', async () => {
    const store = createAppStore(undefined);
    const api = { call: () => Promise.reject(new Error('svalld is gone')) } as unknown as Api;
    await serveFleet({ api, store }, false);
    expect(store.getState().toast).toEqual({ text: 'svalld is gone', tone: 'error' });
  });
});

describe('skillPrompt', () => {
  it("sends a button's skill to a codex crew as $name, and anything else as it is", () => {
    expect(skillPrompt('codex', '/svall-status')).toBe('$svall-status');
    expect(skillPrompt('codex -m gpt-6-luna', '/svall-organise now')).toBe('$svall-organise now');
    expect(skillPrompt('claude --model sonnet', '/svall-status')).toBe('/svall-status');
    expect(skillPrompt('codex', '/tmp/x is full')).toBe('/tmp/x is full');
    expect(skillPrompt('codex', 'regroup')).toBe('regroup');
  });
});

describe('home', () => {
  it('a new robot on home takes the home cwd', async () => {
    const c = ctx();
    c.store.getState().selectIsland('home');
    expect(await newRobotTarget(c)).toEqual({ islandId: 'home', cwd: '/mc' });
  });

  it('startHomeAction spawns a crew member with the command and prompt, and toasts', async () => {
    const calls: { method: string; params: unknown }[] = [];
    const api = { call: (method: string, params: unknown) => { calls.push({ method, params }); return Promise.resolve({ id: 'c_new', name: 'organise', runSent: true }); } } as unknown as Api;
    const store = createAppStore(undefined);
    store.getState().setFleet(fleet());
    await startHomeAction({ api, store }, { label: 'organise', prompt: '/svall-organise' });
    expect(calls).toEqual([{ method: 'robot.create', params: { islandId: 'home', cwd: '/mc', name: 'organise', command: 'claude --model opus', run: '/svall-organise' } }]);
    expect(store.getState()).toMatchObject({ selectedId: 'c_new', card: 'c_new' });
    expect(store.getState().toast).toEqual({ text: 'organise started', tone: 'ok' });
  });

  it("starts a codex crew member on the button's skill as $name", async () => {
    const calls: { method: string; params: unknown }[] = [];
    const api = { call: (method: string, params: unknown) => { calls.push({ method, params }); return Promise.resolve({ id: 'c_new', name: 'organise', runSent: true }); } } as unknown as Api;
    const store = createAppStore(undefined);
    store.getState().setFleet({ ...fleet(), home: { ...fleet().home, command: 'codex' } });
    await startHomeAction({ api, store }, { label: 'organise', prompt: '/svall-organise' });
    expect(calls[0].params).toMatchObject({ command: 'codex', run: '$svall-organise', name: 'organise' });
  });

  it('names the crew member as the fleet named it, when the label was already taken', async () => {
    const api = { call: () => Promise.resolve({ id: 'c_new', name: 'status 2', runSent: true }) } as unknown as Api;
    const store = createAppStore(undefined);
    store.getState().setFleet(fleet());
    await startHomeAction({ api, store }, { label: 'status', prompt: '/svall-status' });
    expect(store.getState().toast?.text).toBe('status 2 started');
  });

  it('says so when the prompt was not sent, and keeps it on the toast to send', async () => {
    const sent: unknown[] = [];
    const api = {
      call: (method: string, params: unknown) => {
        if (method !== 'robot.run') return Promise.resolve({ id: 'c_new', name: 'rename', runSent: false });
        sent.push({ method, params });
        return Promise.reject(new Error('c_new is dormant; revive it first'));
      },
      fire: () => {},
    } as unknown as Api;
    const store = createAppStore(undefined);
    store.getState().setFleet(fleet());
    await startHomeAction({ api, store }, { label: 'rename', prompt: '/svall-rename' });
    const toast = store.getState().toast;
    expect(toast?.text).toBe('rename started, prompt not sent');
    expect(toast?.action?.label).toBe('Send it');
    store.getState().runToastAction();
    expect(sent).toStrictEqual([{ method: 'robot.run', params: { id: 'c_new', text: '/svall-rename', enter: true } }]);
    // a send refused this time is said so too
    await new Promise((r) => setTimeout(r, 0));
    expect(store.getState().toast?.text).toBe('c_new is dormant; revive it first');
  });

  it('a free prompt starts an unnamed crew member and toasts with the name it got', async () => {
    const calls: { method: string; params: unknown }[] = [];
    const api = { call: (method: string, params: unknown) => { calls.push({ method, params }); return Promise.resolve({ id: 'c_new', name: 'bright otter', runSent: true }); } } as unknown as Api;
    const store = createAppStore(undefined);
    store.getState().setFleet(fleet());
    await startHomeRobot({ api, store }, { prompt: 'regroup the fleet' });
    expect(calls).toStrictEqual([{ method: 'robot.create', params: { islandId: 'home', cwd: '/mc', command: 'claude --model opus', run: 'regroup the fleet' } }]);
    expect(store.getState().toast).toEqual({ text: 'bright otter started', tone: 'ok' });
  });

  it('says so when svalld does not find the CLI mission control runs, and still starts the crew member', async () => {
    const calls: { method: string; params: unknown }[] = [];
    const api = { call: (method: string, params: unknown) => { calls.push({ method, params }); return Promise.resolve({ id: 'c_new', name: 'bright otter', runSent: true }); } } as unknown as Api;
    const store = createAppStore(undefined);
    store.getState().setFleet({ ...fleet(), agentsFound: ['codex'] });
    expect(await startHomeRobot({ api, store }, { prompt: 'regroup the fleet' })).toBe(true);
    expect(calls.map((c) => c.method)).toEqual(['robot.create']);
    expect(store.getState().toast).toEqual({ text: "Mission control runs claude, which Svall's background service doesn't find. Install it, then run svall-dev setup.", tone: 'error' });
  });

  it('reports failure and toasts when the fleet refuses', async () => {
    const api = { call: () => Promise.reject(new Error('no such island')) } as unknown as Api;
    const store = createAppStore(undefined);
    store.getState().setFleet(fleet());
    expect(await startHomeRobot({ api, store }, { prompt: 'regroup the fleet' })).toBe(false);
    expect(store.getState().toast).toEqual({ text: 'no such island', tone: 'error' });
  });

  it('does not steal a selection the user made while the agent was starting', async () => {
    const store = createAppStore(undefined);
    store.getState().setFleet(fleet());
    const api = {
      call: () => new Promise((r) => setTimeout(() => r({ id: 'c_new', name: 'bright otter', runSent: true }), 0)),
    } as unknown as Api;
    const started = startHomeRobot({ api, store }, { prompt: 'regroup the fleet' });
    store.getState().select('c1');
    await started;
    expect(store.getState().selectedId).toBe('c1');
  });

  it('selects the crew member as soon as the mirror has it, without waiting for the agent', async () => {
    const store = createAppStore(undefined);
    store.getState().setFleet(fleet());
    let settle = (v: unknown) => { void v; };
    const api = { call: () => new Promise((r) => { settle = r; }) } as unknown as Api;
    const started = startHomeRobot({ api, store }, { prompt: 'regroup the fleet' });
    // the daemon's patch lands long before it answers
    const f = fleet();
    f.robots.c_new = chr('c_new', 'home', { x: 1, y: 1 });
    store.getState().setFleet(f);
    expect(store.getState().selectedId).toBe('c_new');
    settle({ id: 'c_new', name: 'bright otter', runSent: true });
    await started;
    expect(store.getState().selectedId).toBe('c_new');
  });

  // the card of the one gone back to may hold a field being typed in, which a selection move would drop
  it('leaves the user on a robot they went back to while the agent was starting', async () => {
    const store = createAppStore(undefined);
    store.getState().setFleet(fleet());
    store.getState().select('c0');
    let settle = (v: unknown) => { void v; };
    const api = { call: () => new Promise((r) => { settle = r; }) } as unknown as Api;
    const started = startHomeRobot({ api, store }, { prompt: 'regroup the fleet' });
    const f = fleet();
    f.robots.c_new = chr('c_new', 'home', { x: 1, y: 1 });
    store.getState().setFleet(f);
    expect(store.getState().selectedId).toBe('c_new');
    store.getState().select('c0');
    settle({ id: 'c_new', name: 'bright otter', runSent: true });
    await started;
    expect(store.getState().selectedId).toBe('c0');
  });

  it('leaves a selection the user made before the crew member arrived', async () => {
    const store = createAppStore(undefined);
    store.getState().setFleet(fleet());
    const api = { call: () => new Promise(() => {}) } as unknown as Api;
    void startHomeRobot({ api, store }, { prompt: 'regroup the fleet' });
    store.getState().select('c1');
    const f = fleet();
    f.robots.c_new = chr('c_new', 'home', { x: 1, y: 1 });
    store.getState().setFleet(f);
    expect(store.getState().selectedId).toBe('c1');
  });

  it('selects the new crew member when the user picked nothing meanwhile', async () => {
    const store = createAppStore(undefined);
    store.getState().setFleet(fleet());
    const api = { call: () => Promise.resolve({ id: 'c_new', name: 'bright otter', runSent: true }) } as unknown as Api;
    await startHomeRobot({ api, store }, { prompt: 'regroup the fleet' });
    expect(store.getState().selectedId).toBe('c_new');
  });

  it('opens the terminal of a prompted crew member once the daemon answers, if it is still chosen', async () => {
    const store = createAppStore(undefined);
    store.getState().setFleet(fleet());
    store.getState().focus('c0');
    let settle = (v: unknown) => { void v; };
    const api = { call: () => new Promise((r) => { settle = r; }) } as unknown as Api;
    const started = startHomeRobot({ api, store }, { prompt: 'regroup the fleet', focus: true });
    const f = fleet();
    f.robots.c_new = chr('c_new', 'home', { x: 1, y: 1 });
    store.getState().setFleet(f);
    // the agent is still booting, so its terminal waits
    expect(store.getState()).toMatchObject({ selectedId: 'c_new', card: 'c0' });
    settle({ id: 'c_new', name: 'bright otter', runSent: true });
    await started;
    expect(store.getState()).toMatchObject({ selectedId: 'c_new', card: 'c_new' });
  });

  it('leaves the terminal of a robot the user went back to while a prompted crew member was starting', async () => {
    const store = createAppStore(undefined);
    store.getState().setFleet(fleet());
    store.getState().focus('c0');
    let settle = (v: unknown) => { void v; };
    const api = { call: () => new Promise((r) => { settle = r; }) } as unknown as Api;
    const started = startHomeRobot({ api, store }, { prompt: 'regroup the fleet', focus: true });
    const f = fleet();
    f.robots.c_new = chr('c_new', 'home', { x: 1, y: 1 });
    store.getState().setFleet(f);
    store.getState().focus('c0');
    settle({ id: 'c_new', name: 'bright otter', runSent: true });
    await started;
    expect(store.getState()).toMatchObject({ selectedId: 'c0', card: 'c0' });
  });
});

describe('a new island or robot', () => {
  const made: [string, (c: ReturnType<typeof ctx>) => unknown][] = [
    ['a robot on an island', (c) => newRobotOn(c, 'i_a')],
    ['a named robot', (c) => newNamedRobot(c, { name: 'n', note: '', refs: [] })],
    ['a crew member on mission control', (c) => startHomeRobot(c, { prompt: 'hi' })],
    ['an island', (c) => newIsland(c)],
    ['an island around a dragged robot', (c) => newIslandAround(c, 'c0', { x: 40, y: 0 })],
  ];
  it.each(made)('puts Settings away so it can be seen: %s', async (_what, make) => {
    const c = ctx();
    c.store.getState().toggleSettings(true);
    await make(c);
    expect(c.store.getState().settingsOpen).toBe(false);
    expect(c.calls.some((x) => x.method === 'robot.create' || x.method === 'island.create')).toBe(true);
  });
});

describe('a new robot', () => {
  function made() {
    const c = ctx();
    c.api.call = ((method: string, params: unknown) => {
      c.calls.push({ method, params });
      return Promise.resolve(method === 'robot.create' ? { id: 'c_new', name: 'n', runSent: true } : {});
    }) as Api['call'];
    // the user put the side card away before making one
    c.store.getState().toggleSideCard(false);
    return c;
  }
  const created = (c: ReturnType<typeof ctx>) => c.calls.find((x) => x.method === 'robot.create')?.params as { command?: string };

  it('opens its terminal and its side card, even when the side card was put away', async () => {
    const c = made();
    await newRobotOn(c, 'i_a');
    expect(c.store.getState()).toMatchObject({ card: 'c_new', selectedId: 'c_new', sideCardOpen: true, sideCardCollapsed: false });
  });

  it('opens the side card of a crew member started on mission control, without a terminal', async () => {
    const c = made();
    await startHomeRobot(c, { prompt: 'hi' });
    expect(c.store.getState()).toMatchObject({ card: undefined, selectedId: 'c_new', sideCardOpen: true });
  });

  it('opens the terminal and side card of a crew member the mission prompt started', async () => {
    const c = made();
    await startHomeRobot(c, { prompt: 'hi', focus: true });
    expect(c.store.getState()).toMatchObject({ card: 'c_new', selectedId: 'c_new', sideCardOpen: true });
  });

  it('starts the home command on mission control, and a shell anywhere else', async () => {
    const c = made();
    await newRobotOn(c, 'home');
    expect(created(c).command).toBe('claude --model opus');
    c.calls.length = 0;
    await newRobotOn(c, 'i_a');
    expect(created(c)).not.toHaveProperty('command');
  });

  it('follows the main agent for a named robot on mission control', async () => {
    const c = made();
    c.store.getState().applyPatch([{ op: 'replace', path: '/home/command', value: 'codex' }]);
    c.store.getState().selectIsland('home');
    await newNamedRobot(c, { name: 'n', note: '', refs: [] });
    expect(created(c).command).toBe('codex');
  });

  it('says so on mission control when svalld does not find the agent, and still starts it', async () => {
    const c = made();
    c.store.getState().applyPatch([{ op: 'add', path: '/agentsFound', value: ['codex'] }]);
    await newRobotOn(c, 'home');
    expect(created(c).command).toBe('claude --model opus');
    expect(c.store.getState().toast?.text).toMatch(/Mission control runs claude, which Svall's background service doesn't find/);
  });
});
