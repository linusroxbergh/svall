import crypto from 'node:crypto';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { MachineId, emptyState, type FleetState, type Mutation, type Robot } from '@svall/protocol';
import { Store } from '../../src/store.js';
import { applyReport, mergeSnapshot, ownedReport, type RobotSync, type Snapshot } from '../../src/worker/snapshot.js';
import { cleanHomes, makeHome } from '../helpers.js';

const me = MachineId.parse(crypto.randomUUID());
const other = MachineId.parse(crypto.randomUUID());
const agentHomes = { claude: '/Users/ada/.claude', codex: '/Users/ada/.codex', opencode: '/Users/ada/.config/opencode' };

const island = { id: 'i_1', name: 'a', description: '', instructions: '', context: [], position: { x: 0, y: 0 }, size: { w: 6, h: 4 }, seed: 1 };
const robot = (id: string, o: Partial<Robot> = {}): Robot => ({
  id, islandId: 'i_1', cell: { x: 0, y: 0 }, name: id, note: '', portrait: 'owl', instructions: '', cwd: '/tmp', context: [], shell: { lastOutputAt: 0 }, unread: false, ...o,
});
const fleet = (robots: Robot[], o: Partial<FleetState> = {}): FleetState =>
  ({ ...emptyState(), islands: { i_1: island }, robots: Object.fromEntries(robots.map((r) => [r.id, r])), ...o });
const snapshot = (state: FleetState): Snapshot => ({ version: 1, state, agentHomes, home: '/Users/ada' });

function storeWith(state: FleetState): { store: Store; file: string } {
  const file = path.join(makeHome(), 'state.json');
  const store = Store.load(file, () => {});
  store.update((d) => { Object.assign(d, structuredClone(state)); });
  return { store, file };
}

afterEach(cleanHomes);

describe('mergeSnapshot', () => {
  it('a snapshot replaces home-owned fields and keeps the worker-owned ones of robots placed here', () => {
    const here = robot('r_here', {
      machine: me, placement: { generation: 2 }, name: 'old', note: 'old note',
      cwd: '/home/ada/app/packages/cli', panePath: '/home/ada/app', tmux: { windowId: '@1', paneId: '%1' }, unread: true, shell: { lastOutputAt: 5 }, hint: 'codex-silent',
      agent: { kind: 'claude', sessionId: 's1', status: 'working', lastActivityAt: 1, brief: 'delivered here' },
    });
    const { store, file } = storeWith(fleet([here, robot('r_home', { name: 'old' })], { scribeOff: true, dormantAfterHours: 3 }));
    let updates = 0;
    store.subscribe(() => { updates++; });

    mergeSnapshot(store, snapshot(fleet([
      robot('r_here', {
        machine: me, placement: { generation: 2 }, name: 'new', note: 'new note', cwd: '/Users/ada/app', unread: false,
        revive: { command: 'claude --resume s0' }, agent: { kind: 'claude', sessionId: 's0', status: 'idle', lastActivityAt: 0, brief: 'the home has none' },
      }),
      robot('r_home', { name: 'new', tmux: { windowId: '@9', paneId: '%9' } }),
    ], { islands: { i_1: { ...island, name: 'b' } }, defaultCwd: '/srv', worktreesOff: true, mainAgent: 'codex' })), me);

    const after = store.state;
    expect(updates).toBe(1);
    expect(after.robots.r_here).toEqual({ ...here, name: 'new', note: 'new note' });
    expect(after.robots.r_home).toMatchObject({ name: 'new', tmux: { windowId: '@9', paneId: '%9' } });
    expect(after).toMatchObject({ islands: { i_1: { name: 'b' } }, defaultCwd: '/srv', worktreesOff: true, mainAgent: 'codex', scribeOff: true });
    expect(after).not.toHaveProperty('dormantAfterHours');
    expect(Store.load(file, () => {}).state.robots.r_here).toEqual(after.robots.r_here);
  });

  it('a robot placed here that the snapshot lacks stays until the home says forget', () => {
    const here = robot('r_here', { machine: me, placement: { generation: 1 }, tmux: { windowId: '@1', paneId: '%1' } });
    const { store } = storeWith(fleet([here, robot('r_home'), robot('r_there', { machine: other, placement: { generation: 1 } })]));

    mergeSnapshot(store, snapshot(fleet([robot('r_new')])), me);

    expect(Object.keys(store.state.robots).sort()).toEqual(['r_here', 'r_new']);
    expect(store.state.robots.r_here).toEqual(here);
  });

  it('keeps what a pending mutation changed here: the fields an update named, and a robot a close took away', () => {
    const placed = (id: string, o: Partial<Robot> = {}) => robot(id, { machine: me, placement: { generation: 1 }, ...o });
    const { store } = storeWith(fleet([placed('r_a', { name: 'mine', note: '' })]));
    const pending = [
      { id: 'mu_0000000001', method: 'robot.update' as const, params: { id: 'r_a', name: 'mine', note: '' }, snapshotVersion: 1, at: 1 },
      { id: 'mu_0000000002', method: 'robot.close' as const, params: { id: 'r_b' }, snapshotVersion: 1, at: 2 },
    ];

    mergeSnapshot(store, snapshot(fleet([
      placed('r_a', { name: 'theirs', note: 'theirs', noteSource: 'manual', instructions: 'theirs' }), placed('r_b'),
    ])), me, undefined, pending);

    expect(Object.keys(store.state.robots)).toEqual(['r_a']);
    expect(store.state.robots.r_a).toMatchObject({ name: 'mine', note: '', instructions: 'theirs' });
    expect(store.state.robots.r_a).not.toHaveProperty('noteSource');
  });

  it('an island the home made from a pending create comes as the home placed it, with the fields a later pending update named', () => {
    const made = { ...island, id: 'i_2', name: 'docs', position: { x: 10, y: 0 } };
    // the home took the create, under a number and at another place, and its ack is still on the way
    const placed = { ...made, name: 'docs 2', position: { x: 20, y: 0 } };
    const create: Mutation = { id: 'mu_0000000001', method: 'island.create', params: { name: 'docs' }, island: made, snapshotVersion: 0, at: 1 };
    const update: Mutation = { id: 'mu_0000000002', method: 'island.update', params: { id: 'i_2', name: 'notes', collapsed: true }, base: { name: 'docs', collapsed: false }, snapshotVersion: 0, at: 2 };
    const taken = fleet([], { islands: { i_1: island, i_2: placed } });
    const a = storeWith(fleet([], { islands: { i_1: island, i_2: made } })).store;
    mergeSnapshot(a, snapshot(taken), me, undefined, [create]);
    expect(a.state.islands.i_2).toEqual(placed);
    const b = storeWith(fleet([], { islands: { i_1: island, i_2: { ...made, name: 'notes', collapsed: true } } })).store;
    mergeSnapshot(b, snapshot(taken), me, undefined, [create, update]);
    expect(b.state.islands.i_2).toEqual({ ...placed, name: 'notes', collapsed: true });
  });

  it('takes the whole record from the snapshot for a robot that left this machine or came back at a new placement', () => {
    const { store } = storeWith(fleet([
      robot('r_left', { machine: me, placement: { generation: 1 }, cwd: '/home/ada/app' }),
      robot('r_back', { machine: me, placement: { generation: 1 }, cwd: '/home/ada/old', tmux: { windowId: '@1', paneId: '%1' } }),
    ]));

    mergeSnapshot(store, snapshot(fleet([
      robot('r_left', { placement: { generation: 2 }, cwd: '/Users/ada/app' }),
      robot('r_back', { machine: me, placement: { generation: 3 }, cwd: '/home/ada/new' }),
    ])), me);

    expect(store.state.robots.r_left).toEqual(robot('r_left', { placement: { generation: 2 }, cwd: '/Users/ada/app' }));
    expect(store.state.robots.r_back).toEqual(robot('r_back', { machine: me, placement: { generation: 3 }, cwd: '/home/ada/new' }));
  });

  it('a snapshot taken on a worker records the home under its id: reachable, its user home and the snapshot version', () => {
    const { store } = storeWith(fleet([]));
    const home = { id: other, name: 'mac', reachable: true };
    mergeSnapshot(store, { ...snapshot(fleet([])), version: 7 }, me, home);
    expect(store.state.machines?.[other]).toMatchObject({ name: 'mac', reachable: true, home: '/Users/ada', snapshot: { version: 7, at: expect.any(Number) } });

    // what else the worker holds of the home stays, and since moves only when reachable does
    store.update((d) => { d.machines![other] = { ...d.machines![other], reachable: false, since: 1, release: '1.2.3' }; });
    mergeSnapshot(store, { ...snapshot(fleet([])), version: 8 }, me, home);
    const back = store.state.machines![other];
    expect(back).toMatchObject({ reachable: true, release: '1.2.3', snapshot: { version: 8 } });
    expect(back.since).toBeGreaterThan(1);
    mergeSnapshot(store, { ...snapshot(fleet([])), version: 9 }, me, home);
    expect(store.state.machines![other]).toMatchObject({ since: back.since, snapshot: { version: 9 } });
  });
});

describe('applyReport', () => {
  it('applyReport writes the fields only at the matching generation and answers stale otherwise', () => {
    const { store: home } = storeWith(fleet([
      robot('r_1', { machine: me, placement: { generation: 2 }, name: 'kept', cwd: '/Users/ada/app', tmux: { windowId: '@7', paneId: '%7' } }),
      robot('r_2'),
    ]));
    const there = robot('r_1', {
      machine: me, placement: { generation: 2 }, name: 'the worker copy', cwd: '/home/ada/app', unread: true,
      agent: { kind: 'codex', sessionId: 's1', status: 'blocked', lastActivityAt: 1 }, second: { cwd: '/home/ada', unread: false },
    });
    const report = ownedReport(there);
    expect(report).toMatchObject({ robotId: 'r_1', generation: 2 });
    expect(report.fields).not.toHaveProperty('name');

    expect(applyReport(home, { ...report, generation: 1, fields: { ...report.fields, cwd: '/stale' } }, me)).toBe('stale');
    expect(applyReport(home, report, other)).toBe('stale');
    expect(applyReport(home, { ...report, robotId: 'r_2' }, me)).toBe('stale');
    expect(home.state.robots.r_1.cwd).toBe('/Users/ada/app');

    // a field the report leaves out, as tmux once the window is gone, is cleared on the home; one no worker owns is not taken
    expect(applyReport(home, { ...report, fields: { ...report.fields, name: 'taken over' } as RobotSync['fields'] }, me)).toBe('applied');
    expect(home.state.robots.r_1).toEqual({ ...there, name: 'kept' });
    expect(applyReport(home, { ...report, robotId: 'r_gone' }, me)).toBe('unknown');
  });

  it("leaves a robot's board column to the home: a report keeps it, and a snapshot brings the home's", () => {
    const at = { machine: me, placement: { generation: 1 } };
    const { store: home } = storeWith(fleet([robot('r_1', { ...at, column: 'review', columnSource: 'manual' })]));
    const report = ownedReport(robot('r_1', { ...at, unread: true }));
    expect(applyReport(home, { ...report, fields: { ...report.fields, column: 'todo' } as RobotSync['fields'] }, me)).toBe('applied');
    expect(home.state.robots.r_1).toMatchObject({ column: 'review', columnSource: 'manual', unread: true });

    const { store: worker } = storeWith(fleet([robot('r_1', { ...at, column: 'todo', unread: true })]));
    const columns = [{ id: 'todo', name: 'Backlog' }, { id: 'review', name: 'Review' }];
    mergeSnapshot(worker, snapshot({ ...home.state, columns }), me);
    expect(worker.state.columns).toEqual(columns);
    expect(worker.state.robots.r_1).toMatchObject({ column: 'review', columnSource: 'manual', unread: true });
  });
});
