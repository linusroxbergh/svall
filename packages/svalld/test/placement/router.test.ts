import { afterEach, describe, expect, it } from 'vitest';
import { dispatch } from '../../src/api/methods.js';
import { markDormant } from '../../src/dormancy.js';
import { updateAgents } from '../../src/placement/router.js';
import { H, W, placed, robot, stopWorlds, until, world } from './world.js';

afterEach(stopWorlds);

// the robot runs on w1; the home holds its record, tmux ids and all, as w1 last reported them
const onW1 = placed({ id: 'c_1', tmux: { windowId: '@1', paneId: '%1' } });
const UNREACHABLE = 'w1 cannot reach this Mac right now; try again when it is awake';

describe('routing calls for placed robots', () => {
  it('robot.run on the home for a robot placed on w1 goes over the link and returns its delivery', async () => {
    const asked: unknown[] = [];
    const w = world({ home: { robots: { c_1: onW1 } }, worker: { robots: { c_1: onW1 } }, far: { 'robot.run': async (p) => { asked.push(p); return { delivery: 'queued' }; } } });
    await w.link();
    expect(await dispatch({ id: 1, method: 'robot.run', params: { id: 'c_1', text: 'go on' } }, w.home.ctx)).toEqual({ id: 1, result: { delivery: 'queued' } });
    expect(asked).toEqual([{ id: 'c_1', text: 'go on', enter: true }]);
  });

  it("robot.send on the home for a robot placed on w1 goes over the link as a run of the message, named for its sender", async () => {
    const asked: unknown[] = [];
    const target = { ...onW1, agent: { kind: 'claude' as const, sessionId: 's', status: 'idle' as const, lastActivityAt: 1 } };
    const w = world({ home: { robots: { c_1: target, c_lead: robot({ id: 'c_lead', name: 'lead' }) } }, worker: { robots: { c_1: target } }, far: { 'robot.run': async (p) => { asked.push(p); return { delivery: 'delivered' }; } } });
    await w.link();
    expect(await dispatch({ id: 1, method: 'robot.send', params: { id: 'c_1', from: 'c_lead', text: 'review it' } }, w.home.ctx)).toEqual({ id: 1, result: { delivery: 'delivered' } });
    expect(asked).toEqual([{ id: 'c_1', text: '[from robot lead (c_lead); reply with svall robot send c_lead]\nreview it', enter: true }]);
  });

  it('robot.run while w1 is down answers not_reachable naming w1', async () => {
    const w = world({ home: { robots: { c_1: onW1 } }, connect: () => Promise.reject(new Error('connect ECONNREFUSED')) });
    w.home.links.start();
    await until(() => { if (w.home.store.state.machines?.[W]?.reachable !== false) throw new Error('w1 not marked down yet'); });
    expect(await dispatch({ id: 1, method: 'robot.run', params: { id: 'c_1', text: 'go on' } }, w.home.ctx))
      .toEqual({ id: 1, error: { code: 'not_reachable', message: 'w1 is not reachable' } });
  });

  it("on the worker, robot.read of a robot's last answer is read there with the home down", async () => {
    const idle = { ...onW1, agent: { kind: 'claude' as const, sessionId: 's', status: 'idle' as const, lastActivityAt: 1 } };
    const w = world({ worker: { robots: { c_1: idle }, machines: { [W]: { name: 'w1', reachable: true, since: 1 } } } });
    await w.worker.connection.start();
    expect(await dispatch({ id: 1, method: 'robot.read', params: { id: 'c_1', source: 'last' } }, w.worker.ctx))
      .toEqual({ id: 1, result: { text: '[no final message: its last turn was interrupted or ended after a tool call, or it has not had one]' } });
  });

  it('on the worker, robot.read and robot.update of its note answer locally with the home down; robot.update of its figure is refused with the one sentence', async () => {
    const captured: string[] = [];
    const w = world({
      worker: { robots: { c_1: onW1, c_home: robot({ id: 'c_home', tmux: { windowId: '@1', paneId: '%1' } }) }, machines: { [W]: { name: 'w1', reachable: true, since: 1 } } },
      tmux: { capture: async (paneId: string) => { captured.push(paneId); return Buffer.from('$ make test\nok\n'); } },
    });
    await w.worker.connection.start();
    expect(await dispatch({ id: 1, method: 'robot.read', params: { id: 'c_1' } }, w.worker.ctx)).toEqual({ id: 1, result: { text: '$ make test\nok\n' } });
    expect(captured).toEqual(['%1']);
    expect(await dispatch({ id: 2, method: 'state.get', params: {} }, w.worker.ctx)).toMatchObject({ result: { robots: { c_1: { machine: W } } } });
    expect(await dispatch({ id: 3, method: 'robot.update', params: { id: 'c_1', note: 'reviewing' } }, w.worker.ctx)).toMatchObject({ id: 3, result: { note: 'reviewing' } });
    expect(await dispatch({ id: 3, method: 'robot.update', params: { id: 'c_1', figure: 2 } }, w.worker.ctx))
      .toEqual({ id: 3, error: { code: 'not_reachable', message: UNREACHABLE } });
    // a robot the home runs is the home's to read, whatever ids the mirror holds for it
    expect(await dispatch({ id: 4, method: 'robot.read', params: { id: 'c_home' } }, w.worker.ctx)).toEqual({ id: 4, error: { code: 'not_reachable', message: UNREACHABLE } });
    expect(await dispatch({ id: 4, method: 'robot.prompts', params: { id: 'c_home' } }, w.worker.ctx)).toEqual({ id: 4, error: { code: 'not_reachable', message: UNREACHABLE } });
    expect(captured).toEqual(['%1']);
    expect(await dispatch({ id: 5, method: 'island.create', params: { name: 'x' } }, w.worker.ctx)).toEqual({ id: 5, error: { code: 'not_reachable', message: UNREACHABLE } });
  });

  it('on the worker, a call its mirror cannot answer is the home\'s, and the change comes back in the next snapshot', async () => {
    const w = world({ home: { robots: { c_1: onW1 } }, worker: { robots: { c_1: onW1 } } });
    await w.link();
    // a change to a robot here is the home's once the worker has read the home's first ack and has none left to send
    await until(() => { if (!w.worker.connection.connected()) throw new Error('w1 is not linked yet'); });
    await until(() => { if (w.worker.outbox.last() !== w.worker.outbox.acked()) throw new Error('not drained yet'); });
    expect(await dispatch({ id: 1, method: 'robot.update', params: { id: 'c_1', note: 'reviewing' } }, w.worker.ctx)).toMatchObject({ id: 1, result: { id: 'c_1', note: 'reviewing' } });
    expect(w.home.store.state.robots.c_1.note).toBe('reviewing');
    await until(() => { if (w.worker.store.state.robots.c_1.note !== 'reviewing') throw new Error('no snapshot yet'); });
  });

  it('robot.seen for a placed robot is taken where it runs, and the unread it clears comes back home', async () => {
    const unread = placed({ id: 'c_1', tmux: { windowId: '@1', paneId: '%1' }, unread: true });
    const w = world({ home: { robots: { c_1: unread } }, worker: { robots: { c_1: unread } } });
    await w.link();
    expect(() => w.home.fleet.markSeen('c_1')).toThrow('c_1 runs on w1');
    expect(await dispatch({ id: 1, method: 'robot.seen', params: { id: 'c_1' } }, w.home.ctx)).toMatchObject({ id: 1, result: { id: 'c_1', unread: false } });
    expect(w.worker.store.state.robots.c_1.unread).toBe(false);
    await until(() => { if (w.home.store.state.robots.c_1.unread) throw new Error('not reported yet'); });
  });

  it('a change the worker makes to a robot placed there with no hook behind it reaches the home', async () => {
    const w = world({ home: { robots: { c_1: onW1 } }, worker: { robots: { c_1: onW1 } } });
    await w.link();
    // as the worker's poll leaves a robot whose window died without a word
    w.worker.store.update((d) => { markDormant(d.robots.c_1); });
    await until(() => { if (w.home.store.state.robots.c_1.tmux) throw new Error('not reported yet'); });
    expect(w.home.store.state.robots.c_1.revive).toEqual({ command: '' });
  });

  it('on the worker, machines.list lists the home with no robots, and nothing the worker sends home gives the home an entry of its own', async () => {
    const w = world({ home: { robots: { c_1: onW1 } }, worker: { robots: { c_1: onW1 } } });
    await w.link();
    await until(() => { if (!w.worker.store.state.machines?.[H]) throw new Error('no snapshot yet'); });
    const listed = await dispatch({ id: 1, method: 'machines.list', params: {} }, w.worker.ctx) as { result: { machines: { id: string }[] } };
    expect(listed.result.machines.find((m) => m.id === H)).toEqual({ id: H, name: 'mac', reachable: true, robots: 0 });
    expect(listed.result.machines.find((m) => m.id === W)).toMatchObject({ name: 'w1', robots: 1 });
    w.worker.store.update((d) => { markDormant(d.robots.c_1); });
    await until(() => { if (w.home.store.state.robots.c_1.tmux) throw new Error('not reported yet'); });
    expect(Object.keys(w.home.store.state.machines ?? {})).toEqual([W]);
  });

  it('the home takes from a worker only calls about its robots, islands and tabs, and the worker only the params it can read', async () => {
    const w = world({ home: { robots: { c_1: onW1 } }, worker: { robots: { c_1: onW1 } } });
    await w.link();
    await until(() => { if (!w.worker.connection.connected()) throw new Error('w1 is not linked yet'); });
    for (const method of ['fleets.create', 'fleet.stop', 'mobile.set', 'fs.write', 'column.add', 'placing.set']) {
      await expect(w.worker.connection.call(method, {})).rejects.toMatchObject({ code: 'unauthorized', message: `${method} is not taken from a worker` });
    }
    await expect(w.home.links.call(W, 'robot.run', { id: 'c_1' })).rejects.toMatchObject({ code: 'invalid_params' });
  });
});

describe('updateAgents', () => {
  it('runs each agent\'s own update in turn, and the first that fails says why with the last line it printed', async () => {
    const ran: string[] = [];
    const ok = async (cmd: string, args: string[]) => { ran.push([cmd, ...args].join(' ')); return { code: 0, stdout: '', stderr: '' }; };
    await updateAgents(['claude', 'opencode'], ok);
    expect(ran).toEqual(['claude update', 'opencode upgrade']);

    const failing = async (cmd: string) => (cmd === 'claude' ? { code: 1, stdout: 'Checking for updates\n', stderr: 'fetching\nnetwork unreachable\n' } : { code: 0, stdout: '', stderr: '' });
    await expect(updateAgents(['claude', 'codex'], failing)).rejects.toThrow('claude update exited 1: network unreachable');
  });

  it('runs an agent\'s update once for two asks at the same time, both waiting on it', async () => {
    let runs = 0;
    let done!: () => void;
    const slow = async () => { runs++; await new Promise<void>((resolve) => { done = resolve; }); return { code: 0, stdout: '', stderr: '' }; };
    const both = Promise.all([updateAgents(['claude'], slow), updateAgents(['claude'], slow)]);
    await Promise.resolve();
    done();
    await both;
    expect(runs).toBe(1);
  });
});
