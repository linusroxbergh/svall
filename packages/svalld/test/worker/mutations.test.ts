import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HOME_ISLAND, Mutation, type FleetState, type Robot } from '@svall/protocol';
import { dispatch } from '../../src/api/methods.js';
import type { Tmux } from '../../src/tmux/tmux.js';
import { cleanHomes } from '../helpers.js';
import { H, W, island, placed, robot, until, world } from '../placement/world.js';

const worlds: { stop(): Promise<void> }[] = [];
afterEach(async () => {
  vi.useRealTimers();
  for (const w of worlds.splice(0)) await w.stop();
  cleanHomes();
});

const UNREACHABLE = 'w1 cannot reach this Mac right now; try again when it is awake';
const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { encoding: 'utf8' });

/** w1, its link to the home not started, running c_1 in a worktree of `clone`, with mission control and a tmux that records the windows it opens, the text it types and the windows it kills. */
function setup(o: { home?: Partial<FleetState> } = {}) {
  const opened: string[] = [];
  const typed: string[] = [];
  const killed: string[] = [];
  let n = 1;
  const tmux: Partial<Tmux> = {
    newWindow: async (name) => { opened.push(name); n++; return { windowId: `@${n}`, paneId: `%${n}` }; },
    sendLine: async (_paneId, text) => { typed.push(text); },
    killWindow: async (windowId) => { killed.push(windowId); },
    listWindows: async () => [],
    serverPid: async () => undefined,
    screen: async () => ({ rows: [''], cursor: 0, shown: true, command: 'bash' }),
  };
  const w = world({ ...o, worker: { machines: { [W]: { name: 'w1', reachable: true, since: 1 } } }, tmux });
  worlds.push(w);
  const clone = path.join(w.worker.paths.home, 'clone');
  const wt = path.join(clone, '.claude', 'worktrees', 'c_1');
  fs.mkdirSync(clone);
  git(clone, 'init', '-q', '-b', 'main');
  git(clone, 'commit', '-q', '--allow-empty', '-m', 'first');
  git(clone, 'worktree', 'add', '-q', '-b', 'c_1', wt);
  w.worker.store.update((d) => {
    d.robots.c_1 = placed({ id: 'c_1', cwd: wt, tmux: { windowId: '@1', paneId: '%1' }, repo: { root: wt, mainRoot: clone, branch: 'c_1', isWorktree: true } });
    d.islands[HOME_ISLAND] = { ...island, id: HOME_ISLAND, kind: 'home', name: 'mission control', position: { x: 20, y: 0 } };
  });
  const create = (p: Record<string, unknown> = {}) => dispatch({ id: 1, method: 'robot.create', params: { islandId: 'i_1', cwd: clone, ...p } }, w.worker.ctx);
  const call = (method: string, params: Record<string, unknown>) => dispatch({ id: 1, method, params }, w.worker.ctx);
  const mutations = () => w.worker.outbox.after(w.worker.outbox.acked()).filter((e) => e.kind === 'mutation').map((e) => Mutation.parse(e.data));
  return { w, clone, wt, opened, typed, killed, create, call, mutations };
}

const madeIn = (r: unknown): Robot => (r as { result: Robot }).result;
const drained = (w: ReturnType<typeof setup>['w']) => until(() => { if (!w.worker.mutations.drained()) throw new Error('the home has not acked it all yet'); });

describe('a worker serving its robots while the home is away', () => {
  it('robot.create from a worker pane makes the robot here with machine set from the first write, the slept note as the user\'s, and journals a mutation carrying the record', async () => {
    const { w, clone, opened, create, mutations } = setup();
    const first: Robot[] = [];
    w.worker.store.subscribe(() => {
      for (const c of Object.values(w.worker.store.state.robots)) if (c.id !== 'c_1' && !first.some((f) => f.id === c.id)) first.push(c);
    });
    const r = await create({ name: 'reviewer' });
    expect(r).toMatchObject({ result: { name: 'reviewer', machine: W, placement: { generation: 0 }, note: 'started on w1 while this Mac slept', noteSource: 'manual' } });
    const { id } = madeIn(r);
    expect(first.map((c) => [c.id, c.machine, c.placement])).toEqual([[id, W, { generation: 0 }]]);
    expect(opened).toEqual([id]);
    expect(mutations()).toMatchObject([{ method: 'robot.create', params: { islandId: 'i_1', cwd: clone, name: 'reviewer' }, robot: { id, machine: W }, snapshotVersion: 0 }]);
  });

  it('a create whose start line fails leaves no robot and journals nothing', async () => {
    const { w, create, mutations } = setup();
    w.worker.tmux.sendLine = async () => { throw new Error('the pane is gone'); };
    expect(await create({ command: 'claude' })).toMatchObject({ error: { message: 'the pane is gone' } });
    expect(Object.keys(w.worker.store.state.robots)).toEqual(['c_1']);
    expect(mutations()).toEqual([]);
  });

  it('state.get and robot.show answer from the store with the new robot in them while the home is away', async () => {
    const { create, call } = setup();
    const { id } = madeIn(await create());
    expect(Object.keys((await call('state.get', {}) as { result: FleetState }).result.robots)).toContain(id);
    expect(await call('robot.show', { id })).toMatchObject({ result: { text: expect.stringContaining(`You are Svall robot ${id}`) } });
  });

  it('a cwd outside the clones is refused with its path; mission control is refused; the sixth create since the last ack is refused with the quota sentence', async () => {
    const { create, opened } = setup();
    await expect(create({ cwd: os.tmpdir() })).resolves.toMatchObject({ error: { code: 'invalid', message: `${os.tmpdir()} is not inside a clone on w1; start it in one` } });
    await expect(create({ islandId: HOME_ISLAND })).resolves.toMatchObject({ error: { message: 'mission control stays on this Mac; start it on another island' } });
    for (let i = 0; i < 5; i++) expect(await create()).toMatchObject({ result: { machine: W } });
    await expect(create()).resolves.toMatchObject({ error: { code: 'invalid', message: 'w1 has started 5 robots since this Mac last answered; wait for it' } });
    expect(opened).toHaveLength(5);
  });

  it('the quota opens again once the home has acked', async () => {
    const { w, create } = setup();
    for (let i = 0; i < 5; i++) await create();
    await expect(create()).resolves.toMatchObject({ error: { code: 'invalid' } });
    w.worker.outbox.ack(w.worker.outbox.last());
    expect(await create()).toMatchObject({ result: { machine: W, note: 'started on w1 while this Mac slept' } });
  });

  it('robot.update of name, note, context and instructions is served with their base; figure is refused with the one sentence', async () => {
    const { call, mutations } = setup();
    const context = [{ kind: 'other', ref: 'https://example.com/spec', label: 'spec', source: 'manual' }];
    const update = { id: 'c_1', name: 'scout', note: 'reviewing', context, instructions: 'be brief' };
    expect(await call('robot.update', update)).toMatchObject({ result: { name: 'scout', note: 'reviewing', noteSource: 'manual', context, instructions: 'be brief' } });
    expect(mutations()).toMatchObject([{ method: 'robot.update', params: update, base: { name: 'c_1', note: '', context: [], instructions: '' }, snapshotVersion: 0 }]);
    expect(await call('robot.update', { id: 'c_1', figure: 2 })).toMatchObject({ error: { code: 'not_reachable', message: UNREACHABLE } });
    expect(await call('robot.update', { id: 'c_1', note: 'x', islandId: 'i_1' })).toMatchObject({ error: { code: 'not_reachable', message: UNREACHABLE } });
    expect(mutations()).toHaveLength(1);
  });

  it('robot.close of a robot here kills its window, locks its worktree "closed robot <id>" and journals; robot.run types once and journals its delivery', async () => {
    const { w, clone, typed, killed, call, mutations } = setup();
    expect(await call('robot.run', { id: 'c_1', text: 'go on' })).toEqual({ id: 1, result: { delivery: 'delivered' } });
    expect(typed).toEqual(['go on']);
    expect(await call('robot.close', { id: 'c_1' })).toEqual({ id: 1, result: {} });
    expect(killed).toEqual(['@1']);
    expect(w.worker.store.state.robots.c_1).toBeUndefined();
    expect(git(clone, 'worktree', 'list', '--porcelain')).toContain('locked closed robot c_1');
    expect(mutations()).toMatchObject([
      { method: 'robot.run', params: { id: 'c_1', text: 'go on', enter: true }, delivery: 'delivered' },
      { method: 'robot.close', params: { id: 'c_1' } },
    ]);
  });

  it('island.create and robot.update of a home robot are still refused with the one sentence', async () => {
    const { w, call, mutations } = setup();
    w.worker.store.update((d) => { d.robots.c_home = robot({ id: 'c_home', cell: { x: 3, y: 0 } }); });
    expect(await call('island.create', { name: 'x' })).toEqual({ id: 1, error: { code: 'not_reachable', message: UNREACHABLE } });
    expect(await call('robot.update', { id: 'c_home', note: 'x' })).toEqual({ id: 1, error: { code: 'not_reachable', message: UNREACHABLE } });
    expect(await call('robot.close', { id: 'c_home' })).toEqual({ id: 1, error: { code: 'not_reachable', message: UNREACHABLE } });
    expect(mutations()).toEqual([]);
  });

  it('while linked but not drained, update of a robot here is served locally; once drained it goes to the home', async () => {
    const { w, call } = setup({ home: { robots: { c_1: placed({ id: 'c_1' }) } } });
    const update = (note: string) => call('robot.update', { id: 'c_1', note });
    expect(await update('offline')).toMatchObject({ result: { note: 'offline' } });
    const release = w.home.hold();
    const linking = w.link();
    await until(() => { if (!w.worker.connection.connected()) throw new Error('not linked yet'); });
    expect(await update('held')).toMatchObject({ result: { note: 'held' } });
    expect(w.home.store.state.robots.c_1.note).toBe('');
    release();
    await linking;
    await drained(w);
    expect(await update('home')).toMatchObject({ result: { note: 'home' } });
    expect(w.home.store.state.robots.c_1.note).toBe('home');
    expect(w.home.received.map((e) => Mutation.parse(e.data).params)).toEqual([{ id: 'c_1', note: 'offline' }, { id: 'c_1', note: 'held' }]);
  });

  it('an acked mutation is recorded in journal/applied.ndjson with what it changed, before the outbox trims it', async () => {
    const { w, create, call } = setup({ home: { robots: { c_1: placed({ id: 'c_1' }) } } });
    // the file keeps its last 500 lines
    fs.writeFileSync(w.worker.paths.applied, Array.from({ length: 499 }, (_, i) => `${JSON.stringify({ n: i })}\n`).join(''));
    const made = madeIn(await create());
    await call('robot.update', { id: 'c_1', note: 'reviewing' });
    const entries = w.worker.outbox.after(0).filter((e) => e.kind === 'mutation');
    const [m, u] = entries.map((e) => Mutation.parse(e.data));
    const held: string[] = [];
    const record = w.worker.mutations.acked.bind(w.worker.mutations);
    vi.spyOn(w.worker.mutations, 'acked').mockImplementation((dropped) => { held.push(fs.readFileSync(w.worker.paths.outbox, 'utf8')); record(dropped); });
    await w.link();
    await drained(w);
    expect(held.some((text) => text.includes(m.id) && text.includes(u.id))).toBe(true);
    const lines = fs.readFileSync(w.worker.paths.applied, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as unknown);
    expect(lines).toHaveLength(500);
    expect(lines[0]).toEqual({ n: 1 });
    expect(lines.slice(-2)).toEqual([
      { id: m.id, seq: entries[0].seq, method: 'robot.create', at: m.at, changed: { robotId: made.id, islandId: 'i_1', cell: made.cell } },
      { id: u.id, seq: entries[1].seq, method: 'robot.update', at: u.at, changed: { robotId: 'c_1', note: 'reviewing' } },
    ]);
  });

  it('the brief says context as of <time> once the snapshot is an hour old and the home is unreachable', async () => {
    const now = Date.now();
    const { w, call } = setup({ home: { robots: { c_1: placed({ id: 'c_1' }) } } });
    w.worker.store.update((d) => { d.machines![H] = { name: 'mac', reachable: true, since: 1, snapshot: { version: 1, at: now } }; });
    const brief = async () => (await call('robot.show', { id: 'c_1' }) as { result: { text: string } }).result.text;
    expect(await brief()).not.toContain('context as of');
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(now + 61 * 60_000);
    const text = await brief();
    expect(text).toContain(`context as of ${new Date(now).toISOString()}; mac is not reachable`);
    expect(text.split('\n').slice(0, 2)).toEqual(['# Svall context', `context as of ${new Date(now).toISOString()}; mac is not reachable`]);
    vi.useRealTimers();
    await w.link();
    expect(await brief()).not.toContain('context as of');
    expect(await brief()).not.toContain('is not reachable');
  });
});
