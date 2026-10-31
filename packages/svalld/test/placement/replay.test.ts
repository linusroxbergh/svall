import type { AsyncLocalStorage } from 'node:async_hooks';
import { execFileSync } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { Duplex, Writable } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Mutation, ROBOT_NOTE_MAX, cellKey, isLand, type FleetState, type Island, type Robot } from '@svall/protocol';
import { dispatch } from '../../src/api/methods.js';
import { docsDir } from '../../src/docs.js';
import { blockedCells, placementOk } from '../../src/layout.js';
import type { Transport } from '../../src/link/home.js';
import type { Tmux } from '../../src/tmux/tmux.js';
import { W, island, placed, robot, stopWorlds, until, world } from './world.js';

afterEach(async () => {
  vi.restoreAllMocks();
  await stopWorlds();
});

const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { encoding: 'utf8' });
const via = { ssh: 'w1', controlSocket: '/tmp/svall-501/1-abc' };
const SLEPT = 'started on w1 while this Mac slept';
const kanban = (home: string) => ({ root: path.join(home, 'src', 'kanban'), mainRoot: path.join(home, 'src', 'kanban'), branch: 'kb', isWorktree: false });

// a link onto w1's link.sock that loses the home's first ack of seq `lost()`, and the stream with it
function losing(sock: () => string, lost: () => number): Transport {
  let gone = false;
  return async () => {
    const s = net.connect(sock());
    await once(s, 'connect');
    const out = new Writable({
      write(chunk: Buffer, _enc, done) {
        if (!gone && String(chunk).includes(`{"t":"ack","seq":${lost()}}`)) { gone = true; s.destroy(); done(); return; }
        s.write(chunk, done);
      },
    });
    return { stream: Duplex.from({ readable: s, writable: out }), via };
  };
}

/** w1 running c_1 in a clone, its link to the home not started; the home holds c_1 too, and what it logs is in `logged`. */
function setup(o: { home?: Partial<FleetState>; lose?: () => number } = {}) {
  const typed: string[] = [];
  const killed: string[] = [];
  const logged: string[] = [];
  let n = 1;
  const tmux: Partial<Tmux> = {
    newWindow: async () => { n++; return { windowId: `@${n}`, paneId: `%${n}` }; },
    sendLine: async (_paneId, text) => { typed.push(text); },
    killWindow: async (windowId) => { killed.push(windowId); },
    listWindows: async () => [],
    serverPid: async () => undefined,
    screen: async () => ({ rows: [''], cursor: 0, shown: true, command: 'bash' }),
  };
  let sock = '';
  const w = world({
    home: { ...o.home, robots: { c_1: placed({ id: 'c_1' }), ...o.home?.robots } },
    worker: { machines: { [W]: { name: 'w1', reachable: true, since: 1 } } },
    tmux, homeLog: { info: (m) => logged.push(m), error: (m) => logged.push(m) },
    ...(o.lose && { connect: losing(() => sock, o.lose) }),
  });
  sock = w.worker.paths.linkSock;
  const clone = path.join(w.worker.paths.home, 'clone');
  fs.mkdirSync(clone);
  git(clone, 'init', '-q', '-b', 'main');
  git(clone, 'commit', '-q', '--allow-empty', '-m', 'first');
  w.worker.store.update((d) => { d.robots.c_1 = placed({ id: 'c_1', cwd: clone, tmux: { windowId: '@1', paneId: '%1' } }); });
  const call = (method: string, params: Record<string, unknown>) => dispatch({ id: 1, method, params }, w.worker.ctx);
  const create = async (p: Record<string, unknown> = {}) => (await call('robot.create', { islandId: 'i_1', cwd: clone, ...p }) as { result: Robot }).result;
  const journaled = () => w.worker.outbox.after(w.worker.outbox.acked()).filter((e) => e.kind === 'mutation').map((e) => Mutation.parse(e.data));
  const replayed = () => until(() => expect(w.home.store.state.machines?.[W]?.replayed?.seq).toBe(w.worker.outbox.last()));
  // a mutation from w1 taken as the link takes one, with no hold around it
  const apply = async (m: unknown) => {
    const staged = await w.home.replay.prepare(m, W);
    staged.change();
    staged.after();
  };
  return { w, clone, typed, killed, logged, call, create, journaled, replayed, apply };
}

describe('the home replaying what a worker did while it slept', () => {
  it('a robot created offline appears at home once, on its cell, with the slept note; a replay after a lost ack adds nothing', async () => {
    let seq = 0;
    // a crew the island would be laid out afresh for, which leaves the worker's cell free
    const { w, create, journaled, apply } = setup({ home: { robots: { c_x: robot({ id: 'c_x', cell: { x: 1, y: 3 } }) } }, lose: () => seq });
    const { id } = await create();
    const [m] = journaled();
    seq = w.worker.outbox.after(0).find((e) => e.kind === 'mutation')!.seq;
    await w.link();
    await until(() => expect(w.home.store.state.robots[id]).toMatchObject({ machine: W, placement: { generation: 0 }, islandId: 'i_1', cell: m.robot!.cell, note: SLEPT, noteSource: 'manual' }));
    const held = structuredClone(w.home.store.state.robots[id]);
    // the transport loses the create's ack with the stream; the worker sends it again on the next
    await until(() => expect(w.worker.outbox.acked()).toBe(w.worker.outbox.last()));
    expect(w.home.store.state.robots[id]).toEqual(held);
    // and the same mutation applied again adds nothing
    await apply(m);
    expect(w.home.store.state.robots[id]).toEqual(held);
    expect(Object.keys(w.home.store.state.robots)).toHaveLength(3);
  });

  it('a replayed create leaves the board column to the home, and types nothing here, its run included', async () => {
    const { w, create, journaled, logged, apply } = setup();
    await create();
    const [m] = journaled();
    await w.link();
    const r = { ...m.robot!, id: 'c_others', name: 'other', column: 'done', columnSource: 'manual' as const };
    // the home's tmux fails any call made to it, and the failure would be logged
    await apply({ ...m, id: 'mu_0000000001', params: { ...(m.params as object), command: 'claude', run: 'go on' }, robot: r });
    expect(w.home.store.state.robots.c_others).toMatchObject({ machine: W, name: 'other' });
    expect(w.home.store.state.robots.c_others).not.toHaveProperty('column');
    expect(w.home.store.state.robots.c_others).not.toHaveProperty('columnSource');
    expect(logged).toEqual([]);
  });

  it('a mutation that does not parse is logged, acked and skipped, and the next one applies', async () => {
    const { w, create, logged, replayed } = setup();
    w.worker.connection.journal('mutation', { id: 'x' });
    const { id } = await create();
    await w.link();
    await replayed();
    expect(w.home.store.state.robots[id]).toMatchObject({ machine: W, note: SLEPT });
    expect(logged).toHaveLength(1);
    expect(logged[0]).toMatch(/^w1: a mutation svalld cannot read is skipped/);
  });

  it('a context path this Mac does not have is left out and named in the note; the rest of the update applies', async () => {
    const { w, call, logged, replayed } = setup();
    const notes = path.join(w.worker.paths.home, 'notes.md');
    fs.writeFileSync(notes, 'notes\n');
    const url = { kind: 'other', ref: 'https://example.com/spec', label: 'spec', source: 'manual' };
    await call('robot.update', { id: 'c_1', note: 'reviewing', context: [{ kind: 'file', ref: notes, label: 'notes', source: 'manual' }, url] });
    // the file is on w1 alone
    fs.rmSync(notes);
    await w.link();
    await replayed();
    expect(w.home.store.state.robots.c_1).toMatchObject({
      note: `reviewing\nw1 added ${notes} to the context while this Mac slept; it is not on this Mac`, noteSource: 'manual', context: [url],
    });
    expect(logged).toEqual([]);
  });

  it('a mutation that cannot apply here says why in one line of its robot\'s note, and a line the replay writes is the user\'s', async () => {
    const { w, logged, apply } = setup({ home: { machines: { [W]: { name: 'w1', reachable: false, since: 1 } }, robots: { c_2: placed({ id: 'c_2', note: 'the scribe\'s' }) } } });
    await apply({ id: 'mu_0000000002', method: 'robot.update', params: { id: 'c_1', name: 5 }, base: { name: 'c_1' }, snapshotVersion: 0, at: 1 });
    expect(w.home.store.state.robots.c_1.note).toMatch(/^w1 changed this robot while this Mac slept; it could not be applied here: \S.*expected string/);
    expect(w.home.store.state.robots.c_1.note).not.toContain('\n');
    expect(w.home.store.state.robots.c_1.noteSource).toBe('manual');
    expect(logged).toHaveLength(1);
    // the scribe leaves a lost value where it was written
    await apply({ id: 'mu_0000000003', method: 'robot.update', params: { id: 'c_2', note: 'mine' }, base: { note: '' }, snapshotVersion: 0, at: 2 });
    expect(w.home.store.state.robots.c_2).toMatchObject({ note: 'the scribe\'s\nw1 set note to "mine" while this Mac slept; it had changed here since', noteSource: 'manual' });
  });

  it('an update journaled with a note past the cap a request may ask for still applies', async () => {
    const { w, logged, apply } = setup({ home: { machines: { [W]: { name: 'w1', reachable: false, since: 1 } } } });
    const note = 'x'.repeat(ROBOT_NOTE_MAX + 1);
    await apply({ id: 'mu_0000000002', method: 'robot.update', params: { id: 'c_1', note }, base: { note: '' }, snapshotVersion: 0, at: 1 });
    expect(w.home.store.state.robots.c_1.note).toBe(note);
    expect(logged).toEqual([]);
  });

  it('a create whose id is not a robot id is logged and not applied', async () => {
    const { w, create, journaled, logged, apply } = setup({ home: { machines: { [W]: { name: 'w1', reachable: false, since: 1 } } } });
    await create();
    const [m] = journaled();
    await apply({ ...m, id: 'mu_0000000004', robot: { ...m.robot!, id: '../x' } });
    expect(Object.keys(w.home.store.state.robots)).toEqual(['c_1']);
    expect(logged).toEqual(['w1: robot.create mu_0000000004 not applied: "../x" is not a robot id']);
  });

  it('an update of a robot that does not run on the sender is not applied, and its note says why', async () => {
    const { w, logged, apply } = setup({ home: { machines: { [W]: { name: 'w1', reachable: false, since: 1 } }, robots: { c_h: robot({ id: 'c_h' }) } } });
    await apply({ id: 'mu_0000000005', method: 'robot.update', params: { id: 'c_h', name: 'taken' }, base: { name: 'c_h' }, snapshotVersion: 0, at: 1 });
    expect(w.home.store.state.robots.c_h).toMatchObject({ name: 'c_h', note: 'w1 changed this robot while this Mac slept; it could not be applied here: it no longer runs on w1' });
    expect(logged).toEqual(['w1: robot.update mu_0000000005 not applied: it no longer runs on w1']);
  });

  it('a robot that keeps its cell on an island folded here unfolds it', async () => {
    const { w, create } = setup({ home: { islands: { i_1: { ...island, collapsed: true } } } });
    const { id } = await create();
    await w.link();
    await until(() => expect(w.home.store.state.robots[id]).toBeDefined());
    expect(w.home.store.state.islands.i_1.collapsed).toBeUndefined();
  });

  it('a robot whose cell was taken meanwhile is re-placed on the same island', async () => {
    const { w, create, journaled } = setup();
    const { id } = await create();
    const { cell } = journaled()[0].robot!;
    w.home.store.update((d) => { d.robots.c_h = robot({ id: 'c_h', cell }); });
    await w.link();
    await until(() => expect(w.home.store.state.robots[id]).toMatchObject({ islandId: 'i_1' }));
    const state = w.home.store.state;
    const at = state.robots[id].cell;
    expect(cellKey(at)).not.toBe(cellKey(state.robots.c_h.cell));
    expect(isLand(state.islands.i_1, at)).toBe(true);
    expect(blockedCells(state, 'i_1', id).has(cellKey(at))).toBe(false);
  });

  it('robots whose island the home deleted land on one "recovered from w1", worktree and transcript untouched', async () => {
    const { w, clone, create, killed } = setup({ home: { islands: { i_2: { ...island, id: 'i_2', name: 'b' } }, robots: { c_1: placed({ id: 'c_1', islandId: 'i_2' }) } } });
    const wt = path.join(clone, '.claude', 'worktrees', 'kb');
    git(clone, 'worktree', 'add', '-q', '-b', 'kb', wt);
    const made = await create({ cwd: wt });
    const second = await create();
    // the island comes in the same write as the robot it is made for
    let bare = false;
    w.home.store.subscribe(() => {
      const r = Object.values(w.home.store.state.islands).find((i) => i.name === 'recovered from w1');
      if (r && !Object.values(w.home.store.state.robots).some((c) => c.islandId === r.id)) bare = true;
    });
    await w.link();
    await until(() => expect(w.home.store.state.robots[second.id]).toBeDefined());
    const { islands, robots } = w.home.store.state;
    const recovered = Object.values(islands).filter((i) => i.name === 'recovered from w1');
    expect(recovered).toHaveLength(1);
    expect(robots[made.id]).toMatchObject({ islandId: recovered[0].id, machine: W, cwd: wt, tmux: made.tmux });
    expect(robots[second.id]).toMatchObject({ islandId: recovered[0].id, machine: W });
    expect(isLand(recovered[0], robots[made.id].cell) && isLand(recovered[0], robots[second.id].cell)).toBe(true);
    expect(cellKey(robots[made.id].cell)).not.toBe(cellKey(robots[second.id].cell));
    expect(bare).toBe(false);
    // the worker keeps the robot, its window and its worktree
    await until(() => expect(w.worker.store.state.robots[made.id]?.islandId).toBe(recovered[0].id));
    expect(killed).toEqual([]);
    expect(fs.existsSync(wt)).toBe(true);
    expect(git(clone, 'worktree', 'list', '--porcelain')).not.toContain('locked');
  });

  it('a robot whose island is full lands on "recovered from w1" too, and nothing is thrown or left unacked', async () => {
    const { w, create, journaled, killed, logged, replayed } = setup();
    const { id } = await create();
    const { cell } = journaled()[0].robot!;
    // an island too large for any push to clear hems in i_1 and the recovered island alike
    const big: Island = { ...island, id: 'i_big', name: 'big', position: { x: -100, y: -100 }, size: { w: 210, h: 210 } };
    const recovered: Island = { ...island, id: 'i_r', name: 'recovered from w1', position: { x: 0, y: 20 } };
    w.home.store.update((d) => { d.robots.c_h = robot({ id: 'c_h', cell }); d.islands.i_big = big; d.islands.i_r = recovered; });
    await w.link();
    await replayed();
    const state = w.home.store.state;
    expect(state.robots[id]).toMatchObject({ islandId: 'i_r', machine: W });
    expect(isLand(state.islands.i_r, state.robots[id].cell)).toBe(true);
    expect(logged).toEqual([expect.stringMatching(/^island recovered from w1: \d+ island\(s\) the search could not settle$/)]);
    expect(killed).toEqual([]);
    expect(w.worker.store.state.robots[id]).toBeDefined();
  });

  it('an update whose field the home changed since loses, and the lost value lands in the note; the other fields apply', async () => {
    let seq = 0;
    const { w, call, journaled, apply } = setup({ home: { robots: { c_1: placed({ id: 'c_1', note: 'mine', noteSource: 'manual' }) } }, lose: () => seq });
    await call('robot.update', { id: 'c_1', note: 'reviewing', name: 'kb2' });
    seq = w.worker.outbox.last();
    const [m] = journaled();
    const names: (string | undefined)[] = [];
    w.worker.store.subscribe(() => names.push(w.worker.store.state.robots.c_1?.name));
    await w.link();
    const note = 'mine\nw1 set note to "reviewing" while this Mac slept; it had changed here since';
    expect(w.home.store.state.robots.c_1).toMatchObject({ name: 'kb2', note });
    // the transport drops the update's ack and destroys the socket; the worker replays it on the next stream
    await until(() => expect(w.worker.outbox.acked()).toBe(w.worker.outbox.last()));
    await until(() => expect(w.home.store.state.machines?.[W]?.replayed?.seq).toBe(w.worker.outbox.last()));
    expect(w.home.store.state.robots.c_1.note).toBe(note);
    // the same update applied again changes nothing
    await apply(m);
    expect(w.home.store.state.robots.c_1).toMatchObject({ name: 'kb2', note });
    // no snapshot took the worker's change back before the home had it
    expect(names).not.toContain('c_1');
    await until(() => expect(w.worker.store.state.robots.c_1).toMatchObject({ name: 'kb2', note }));
  });

  it('an update whose name is taken loses that field alone', async () => {
    const { w, call, replayed } = setup({ home: { robots: { c_h: robot({ id: 'c_h', name: 'KB2' }) } } });
    const context = [{ kind: 'other', ref: 'https://example.com/spec', label: 'spec', source: 'manual' }];
    await call('robot.update', { id: 'c_1', name: 'kb2', note: 'reviewing', context });
    await w.link();
    await replayed();
    expect(w.home.store.state.robots.c_1).toMatchObject({
      name: 'c_1', note: 'reviewing\nw1 set name to "kb2" while this Mac slept; another robot has that name here', noteSource: 'manual', context,
    });
    expect(w.home.store.state.robots.c_h.name).toBe('KB2');
  });

  it('a close replays as a delete and its docs go; a close of a robot the home closed meanwhile is nothing', async () => {
    const { w, call, logged, replayed } = setup();
    w.worker.store.update((d) => { d.robots.c_2 = placed({ id: 'c_2', cell: { x: 5, y: 2 }, tmux: { windowId: '@9', paneId: '%9' } }); });
    const docs = docsDir(w.home.paths.docs, 'robot', 'c_1');
    fs.mkdirSync(docs, { recursive: true });
    fs.writeFileSync(path.join(docs, 'notes.md'), 'kept\n');
    expect(await call('robot.close', { id: 'c_1' })).toEqual({ id: 1, result: {} });
    expect(await call('robot.close', { id: 'c_2' })).toEqual({ id: 1, result: {} });
    await w.link();
    await replayed();
    expect(w.home.store.state.robots.c_1).toBeUndefined();
    expect(fs.existsSync(docs)).toBe(false);
    expect(logged).toEqual([]);
  });

  it('a run replays as a record: nothing is typed at home, and nothing on the worker again after a lost ack', async () => {
    let seq = 0;
    const { w, call, typed, logged } = setup({ lose: () => seq });
    expect(await call('robot.run', { id: 'c_1', text: 'go on' })).toEqual({ id: 1, result: { delivery: 'delivered' } });
    seq = w.worker.outbox.last();
    await w.link();
    await until(() => expect(w.worker.outbox.acked()).toBe(w.worker.outbox.last()));
    expect(typed).toEqual(['go on']);
    expect(logged).toEqual([]);
  });

  it('create, update and close of one robot journaled in that order land in that order even when the first apply is slow', async () => {
    const { w, create, call, logged, replayed } = setup();
    const { id } = await create();
    await call('robot.update', { id, note: 'later' });
    await call('robot.close', { id });
    const release = w.home.hold();
    setTimeout(release, 200);
    await w.link();
    await replayed();
    expect(w.home.store.state.robots[id]).toBeUndefined();
    expect(logged).toEqual([]);
  });

  it('an update of a robot the home closed while w1 was down is dropped, and the robot is told robot.forget after the replay', async () => {
    const { w, call, killed, logged } = setup();
    w.home.store.update((d) => { delete d.robots.c_1; });
    await call('robot.update', { id: 'c_1', note: 'reviewing' });
    await w.link();
    expect(w.home.store.state.robots.c_1).toBeUndefined();
    expect(logged).toEqual(['w1: c_1 is closed here; what w1 changed of it while this Mac slept is dropped']);
    await until(() => expect(w.worker.store.state.robots.c_1).toBeUndefined());
    expect(killed).toEqual(['@1']);
  });

  it('the hold a mutation is applied in touches no file: its stat comes before it, its docs go after the write', async () => {
    const { w, clone, create, call, replayed } = setup({
      home: { islands: { i_2: { ...island, id: 'i_2', name: 'b' } }, robots: { c_1: placed({ id: 'c_1', islandId: 'i_2' }), c_2: placed({ id: 'c_2', islandId: 'i_2', cell: { x: 5, y: 2 } }) } },
    });
    w.worker.store.update((d) => { d.robots.c_2 = placed({ id: 'c_2', cell: { x: 5, y: 2 }, tmux: { windowId: '@7', paneId: '%7' } }); });
    const spec = path.join(clone, 'spec.md');
    fs.writeFileSync(spec, 'spec\n');
    const docs = docsDir(w.home.paths.docs, 'robot', 'c_2');
    fs.mkdirSync(docs, { recursive: true });
    const made = await create();
    await call('robot.update', { id: 'c_1', context: [{ kind: 'file', ref: spec, label: 'spec', source: 'manual' }] });
    await call('robot.close', { id: 'c_2' });
    // the store's own record of a running hold, which a flush from inside one trips over
    const { inside } = w.home.store as unknown as { inside: AsyncLocalStorage<{ running: boolean }> };
    const touched: string[] = [];
    for (const k of ['statSync', 'existsSync', 'readFileSync', 'writeFileSync', 'appendFileSync', 'rmSync', 'mkdirSync', 'renameSync'] as const) {
      const real = fs[k] as (...a: unknown[]) => unknown;
      vi.spyOn(fs, k).mockImplementation(((...a: unknown[]) => { if (inside.getStore()?.running) touched.push(k); return real(...a); }) as never);
    }
    await w.link();
    await replayed();
    const { robots } = w.home.store.state;
    expect(w.home.store.state.islands[robots[made.id].islandId].name).toBe('recovered from w1');
    expect(robots.c_1.context).toMatchObject([{ ref: spec, kind: 'file' }]);
    expect(robots.c_2).toBeUndefined();
    expect(fs.existsSync(docs)).toBe(false);
    expect(touched).toEqual([]);
  });

  it('a robot created offline on a branch another robot holds is flagged in its note at reconnect', async () => {
    const { w, create } = setup({ home: { robots: { board: robot({ id: 'board', repo: kanban('/Users/ada') }) } } });
    const { id } = await create();
    // the worker's own clone, in its user folder as board's is in this Mac's
    w.worker.store.update((d) => { d.robots[id].repo = kanban(os.homedir()); });
    await w.link();
    expect(w.home.store.state.robots[id].note).toBe(`${SLEPT}\nshares branch kb with board`);
    expect(w.home.store.state.robots.board.note).toBe('');
  });

  it('a robot created while linked on a branch another robot holds is flagged once its repo is reported, and left to the next reconnect no more', async () => {
    const { w, create } = setup({ home: { robots: { board: robot({ id: 'board', repo: kanban('/Users/ada') }) } } });
    await w.link();
    const { id } = await create();
    w.worker.store.update((d) => { d.robots[id].repo = kanban(os.homedir()); });
    await until(() => expect(w.home.store.state.robots[id]?.note).toBe('shares branch kb with board'));
    expect(w.home.replay.created(W)).toEqual([]);
  });

  it('an island made offline lands at home once under its id, and a robot started on it there stands on it', async () => {
    const { w, call, create, journaled, logged, replayed, apply } = setup();
    const made = (await call('island.create', { name: 'docs' }) as { result: Island }).result;
    const { id } = await create({ islandId: made.id });
    const [m] = journaled();
    await w.link();
    await replayed();
    const { islands, robots } = w.home.store.state;
    expect(islands[made.id]).toMatchObject({ name: 'docs', seed: made.seed });
    expect(robots[id]).toMatchObject({ islandId: made.id, machine: W });
    expect(isLand(islands[made.id], robots[id].cell)).toBe(true);
    const held = structuredClone(islands);
    await apply(m);
    expect(w.home.store.state.islands).toEqual(held);
    expect(logged).toEqual([]);
  });

  it('an island made offline on a place taken here is re-placed, and a name taken here gets a number', async () => {
    const { w, call, replayed } = setup();
    const made = (await call('island.create', { name: 'docs' }) as { result: Island }).result;
    w.home.store.update((d) => { d.islands.i_h = { ...made, id: 'i_h', name: 'Docs' }; });
    await w.link();
    await replayed();
    const { islands } = w.home.store.state;
    expect(islands[made.id].name).toBe('docs 2');
    expect(islands[made.id].position).not.toEqual(made.position);
    expect(placementOk(w.home.store.state, islands[made.id])).toBe(true);
  });

  it('an island update keeps the value of a field the home changed since, and of a name another island has, and logs each; the other fields apply', async () => {
    const home = { islands: { i_1: island, i_2: { ...island, id: 'i_2', name: 'b', position: { x: 10, y: 0 } }, i_3: { ...island, id: 'i_3', name: 'c', position: { x: 20, y: 0 } } } };
    const { w, call, logged, replayed } = setup({ home });
    w.worker.store.update((d) => { Object.assign(d.islands, structuredClone(home.islands)); });
    await call('island.update', { id: 'i_2', name: 'notes', description: 'from w1', collapsed: true });
    await call('island.update', { id: 'i_3', name: 'Kb', description: 'kanban' });
    w.home.store.update((d) => {
      d.islands.i_2.description = 'from home';
      d.islands.i_2.descriptionSource = 'manual';
      d.islands.i_1.name = 'KB';
    });
    await w.link();
    await replayed();
    const { islands } = w.home.store.state;
    expect(islands.i_2).toMatchObject({ name: 'notes', description: 'from home', collapsed: true });
    expect(islands.i_3).toMatchObject({ name: 'c', description: 'kanban', descriptionSource: 'manual' });
    expect(logged).toEqual([
      'w1: island notes: w1 set description to "from w1" while this Mac slept; it had changed here since',
      'w1: island c: w1 set name to "Kb" while this Mac slept; another island has that name here',
    ]);
    await until(() => expect(w.worker.store.state.islands.i_2.description).toBe('from home'));
  });

  it('an update of an island the home deleted is dropped and logged', async () => {
    const { w, call, logged, replayed } = setup();
    await call('island.update', { id: 'i_1', name: 'renamed' });
    w.home.store.update((d) => { d.islands.i_2 = { ...island, id: 'i_2', name: 'b', position: { x: 10, y: 0 } }; for (const c of Object.values(d.robots)) c.islandId = 'i_2'; delete d.islands.i_1; });
    await w.link();
    await replayed();
    expect(w.home.store.state.islands.i_1).toBeUndefined();
    expect(logged).toEqual(['w1: island i_1 is deleted here; what w1 changed of it while this Mac slept is dropped']);
  });

  it('a delete of an island empty here takes it and its docs after the robot closed before it; one with a robot here is refused and logged', async () => {
    const home = { islands: { i_1: island, i_2: { ...island, id: 'i_2', name: 'b', position: { x: 10, y: 0 } } }, robots: { c_h: robot({ id: 'c_h', islandId: 'i_2' }) } };
    const { w, call, logged, replayed } = setup({ home });
    w.worker.store.update((d) => { d.islands.i_2 = structuredClone(home.islands.i_2); });
    const docs = docsDir(w.home.paths.docs, 'island', 'i_1');
    fs.mkdirSync(docs, { recursive: true });
    fs.writeFileSync(path.join(docs, 'notes.md'), 'kept\n');
    expect(await call('robot.close', { id: 'c_1' })).toEqual({ id: 1, result: {} });
    expect(await call('island.delete', { id: 'i_1' })).toEqual({ id: 1, result: {} });
    expect(await call('island.delete', { id: 'i_2' })).toEqual({ id: 1, result: {} });
    await w.link();
    await replayed();
    const { islands, robots } = w.home.store.state;
    expect(islands.i_1).toBeUndefined();
    expect(fs.existsSync(docs)).toBe(false);
    expect(islands.i_2).toEqual(home.islands.i_2);
    expect(robots.c_h.islandId).toBe('i_2');
    expect(logged).toEqual([expect.stringMatching(/^w1: island\.delete mu_[0-9a-z]{10} not applied: island b is not empty$/)]);
    await until(() => expect(w.worker.store.state.islands.i_2).toBeDefined());
  });

  it('an island made offline whose id is not an island id is logged and not applied', async () => {
    const { w, call, journaled, logged, apply } = setup({ home: { machines: { [W]: { name: 'w1', reachable: false, since: 1 } } } });
    await call('island.create', { name: 'docs' });
    const [m] = journaled();
    await apply({ ...m, id: 'mu_0000000006', island: { ...m.island!, id: '../x' } });
    expect(Object.keys(w.home.store.state.islands)).toEqual(['i_1']);
    expect(logged).toEqual(['w1: island.create mu_0000000006 not applied: "../x" is not an island id']);
  });
});
