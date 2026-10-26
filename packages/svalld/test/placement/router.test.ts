import { afterEach, describe, expect, it } from 'vitest';
import { dispatch } from '../../src/api/methods.js';
import { markDormant } from '../../src/dormancy.js';
import { cleanHomes } from '../helpers.js';
import { H, W, placed, robot, until, world } from './world.js';

const worlds: { stop(): Promise<void> }[] = [];
afterEach(async () => {
  for (const w of worlds.splice(0)) await w.stop();
  cleanHomes();
});
const open = (o: Parameters<typeof world>[0]) => { const w = world(o); worlds.push(w); return w; };

// the robot runs on w1; the home holds its record, tmux ids and all, as w1 last reported them
const onW1 = placed({ id: 'c_1', tmux: { windowId: '@1', paneId: '%1' } });
const UNREACHABLE = 'w1 cannot reach this Mac right now; try again when it is awake';

describe('routing calls for placed robots', () => {
  it('robot.run on the home for a robot placed on w1 goes over the link and returns its delivery', async () => {
    const asked: unknown[] = [];
    const w = open({ home: { robots: { c_1: onW1 } }, worker: { robots: { c_1: onW1 } }, far: { 'robot.run': async (p) => { asked.push(p); return { delivery: 'queued' }; } } });
    await w.link();
    expect(await dispatch({ id: 1, method: 'robot.run', params: { id: 'c_1', text: 'go on' } }, w.home.ctx)).toEqual({ id: 1, result: { delivery: 'queued' } });
    expect(asked).toEqual([{ id: 'c_1', text: 'go on', enter: true }]);
  });

  it('robot.run while w1 is down answers not_reachable naming w1', async () => {
    const w = open({ home: { robots: { c_1: onW1 } }, connect: () => Promise.reject(new Error('connect ECONNREFUSED')) });
    w.home.links.start();
    await until(() => { if (w.home.store.state.machines?.[W]?.reachable !== false) throw new Error('w1 not marked down yet'); });
    expect(await dispatch({ id: 1, method: 'robot.run', params: { id: 'c_1', text: 'go on' } }, w.home.ctx))
      .toEqual({ id: 1, error: { code: 'not_reachable', message: 'w1 is not reachable' } });
  });

  it('on the worker, robot.read and robot.update of its note answer locally with the home down; robot.update of its figure is refused with the one sentence', async () => {
    const captured: string[] = [];
    const w = open({
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
    expect(await dispatch({ id: 6, method: 'handover.abort', params: {} }, w.worker.ctx))
      .toEqual({ id: 6, error: { code: 'not_on_worker', message: 'handover.abort does not answer on a worker' } });
  });

  it('on the worker, a call its mirror cannot answer is the home\'s, and the change comes back in the next snapshot', async () => {
    const w = open({ home: { robots: { c_1: onW1 } }, worker: { robots: { c_1: onW1 } } });
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
    const w = open({ home: { robots: { c_1: unread } }, worker: { robots: { c_1: unread } } });
    await w.link();
    expect(() => w.home.fleet.markSeen('c_1')).toThrow('c_1 runs on w1');
    expect(await dispatch({ id: 1, method: 'robot.seen', params: { id: 'c_1' } }, w.home.ctx)).toMatchObject({ id: 1, result: { id: 'c_1', unread: false } });
    expect(w.worker.store.state.robots.c_1.unread).toBe(false);
    await until(() => { if (w.home.store.state.robots.c_1.unread) throw new Error('not reported yet'); });
  });

  it('a change the worker makes to a robot placed there with no hook behind it reaches the home', async () => {
    const w = open({ home: { robots: { c_1: onW1 } }, worker: { robots: { c_1: onW1 } } });
    await w.link();
    // as the worker's poll leaves a robot whose window died without a word
    w.worker.store.update((d) => { markDormant(d.robots.c_1); });
    await until(() => { if (w.home.store.state.robots.c_1.tmux) throw new Error('not reported yet'); });
    expect(w.home.store.state.robots.c_1.revive).toEqual({ command: '' });
  });

  it('on the worker, machines.list lists the home with no robots, and nothing the worker sends home gives the home an entry of its own', async () => {
    const w = open({ home: { robots: { c_1: onW1 } }, worker: { robots: { c_1: onW1 } } });
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
    const w = open({ home: { robots: { c_1: onW1 } }, worker: { robots: { c_1: onW1 } } });
    await w.link();
    await until(() => { if (!w.worker.connection.connected()) throw new Error('w1 is not linked yet'); });
    for (const method of ['handover.abort', 'ownership.adopt', 'fleets.create', 'fleet.stop', 'mobile.set', 'fs.write', 'column.add', 'placing.set']) {
      await expect(w.worker.connection.call(method, {})).rejects.toMatchObject({ code: 'unauthorized', message: `${method} is not taken from a worker` });
    }
    await expect(w.home.links.call(W, 'robot.run', { id: 'c_1' })).rejects.toMatchObject({ code: 'invalid_params' });
  });
});
