import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Robot } from '@svall/protocol';
import { dispatch } from '../../src/api/methods.js';
import { REST_BYTES, REST_MS } from '../../src/scribe/eligible.js';
import type { RunScribe } from '../../src/scribe/run.js';
import { SETTLE_MS, SPACING_MS } from '../../src/scribe/scribe.js';
import { SLEPT_NOTE } from '../../src/worker/mutations.js';
import { cleanHomes, makeHome } from '../helpers.js';
import { placed, robot, until, world } from '../placement/world.js';

const worlds: { stop(): Promise<void> }[] = [];
afterEach(async () => {
  vi.useRealTimers();
  for (const w of worlds.splice(0)) await w.stop();
  cleanHomes();
});

const PLAN = 'https://docs.example/plan';
const line = (text: string) => JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text }] } });
// a transcript naming the plan, grown by `bytes`
const grow = (file: string, bytes: number) => fs.appendFileSync(file, [line(`working on ${PLAN}`), line('x'.repeat(bytes))].join('\n') + '\n');

// a robot whose agent has rested 46 s, its transcript in `dir`
const resting = (make: typeof robot, id: string, dir: string, o: Partial<Robot> = {}): Robot => make({
  id, cwd: `/repo/${id}`, tmux: { windowId: `@${id}`, paneId: `%${id}` },
  agent: { kind: 'claude', sessionId: 's', status: 'idle', lastActivityAt: Date.now() - 46_000, transcriptPath: path.join(dir, `${id}.jsonl`) }, ...o,
});

// answers each robot's pass by the directory its prompt names, an island's with nothing; `ran` lists what it was asked
const runner = (answers: Record<string, object>, ran: string[]): RunScribe => async (_system, prompt) => {
  const id = /^Directory: \/repo\/(\S+)$/m.exec(prompt)?.[1] ?? prompt.split('\n')[0];
  ran.push(id);
  return JSON.stringify(answers[id] ?? {});
};

const kb = { name: { value: 'kb', reason: 'generated' }, note: 'building the board', links: [] };

// a home whose scribe is on, linked to w1; `asked` lists the scribe.run calls w1 takes
async function open(o: Parameters<typeof world>[0]) {
  const w = world(o);
  worlds.push(w);
  w.home.store.update((d) => { delete d.scribeAsk; });
  const asked: Record<string, unknown>[] = [];
  const run = w.worker.handlers['scribe.run'];
  w.worker.handlers['scribe.run'] = (p) => { asked.push(p as Record<string, unknown>); return run(p); };
  await w.link();
  await until(() => { if (!w.worker.connection.connected()) throw new Error('w1 is not linked yet'); });
  return { w, asked, scribe: w.home.fleet['scribe'], own: w.worker.fleet['scribe'] };
}

describe('the scribe on a placed robot', () => {
  it('the home asks the worker for a placed robot\'s pass on its schedule, and writes the answer itself: name, note and links, the slept note left alone', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const dir = makeHome();
    const robots = {
      c_1: resting(placed, 'c_1', dir, { name: 'golden heron' }),
      c_2: resting(placed, 'c_2', dir, { name: 'reviewer', note: SLEPT_NOTE('w1'), noteSource: 'manual' }),
    };
    const ran: string[] = [];
    const answers = { c_1: kb, c_2: { note: 'something else', links: [] } };
    const { w, asked, scribe } = await open({ home: { robots }, worker: { robots }, scribe: { worker: runner(answers, ran) } });
    for (const id of ['c_1', 'c_2']) grow(path.join(dir, `${id}.jsonl`), 4000);

    scribe.tick();
    await until(() => expect(w.home.store.state.robots.c_1).toMatchObject({ name: 'kb', note: 'building the board' }));
    vi.advanceTimersByTime(SPACING_MS);
    scribe.tick();
    await until(() => expect(asked.map((a) => a.id)).toEqual(['c_1', 'c_2']));
    await scribe.settled();
    expect(ran).toEqual(['c_1', 'c_2']);
    expect(w.home.store.state.robots.c_2.note).toBe('started on w1 while this Mac slept');
    // the worker wrote nothing of it: its copy is the home's
    await until(() => expect(w.worker.store.state.robots.c_1).toMatchObject({ name: 'kb', note: 'building the board' }));
  });

  it('idle placed robots whose workers skip them leave the minute to a robot here, and one is asked again once its agent has done something', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const dir = makeHome();
    const robots = {
      c_1: resting(placed, 'c_1', dir, { name: 'golden heron' }), c_2: resting(placed, 'c_2', dir, { name: 'reviewer' }), c_h: resting(robot, 'c_h', dir),
    };
    // what a transcript holds as the worker starts was there for the passes before it
    for (const id of ['c_1', 'c_2']) grow(path.join(dir, `${id}.jsonl`), 4000);
    const ran: string[] = [];
    const { w, asked, scribe } = await open({
      home: { robots }, worker: { robots }, scribe: { home: runner({ c_h: { note: 'tidying the docs' } }, ran), worker: runner({ c_1: kb }, ran) },
    });
    grow(path.join(dir, 'c_h.jsonl'), 4000);
    const pass = async () => { scribe.tick(); await scribe.settled(); };

    for (let n = 0; n < 3; n++) await pass();
    expect(asked.map((a) => a.id)).toEqual(['c_1', 'c_2']);
    expect(w.home.store.state.robots.c_h.note).toBe('tidying the docs');
    for (let n = 0; n < 3; n++) {
      vi.advanceTimersByTime(SPACING_MS);
      await pass();
    }
    expect(asked).toHaveLength(2);

    // c_1's agent takes a turn on w1 and rests again
    const at = Date.now() - 46_000;
    grow(path.join(dir, 'c_1.jsonl'), 4000);
    w.worker.store.update((d) => { d.robots.c_1.agent!.lastActivityAt = at; });
    await until(() => expect(w.home.store.state.robots.c_1.agent?.lastActivityAt).toBe(at));
    for (let n = 0; n < 3; n++) {
      vi.advanceTimersByTime(SPACING_MS);
      await pass();
    }
    expect(asked.map((a) => a.id)).toEqual(['c_1', 'c_2', 'c_1']);
    expect(ran.filter((id) => id.startsWith('c_'))).toEqual(['c_h', 'c_1']);
    expect(w.home.store.state.robots.c_1.name).toBe('kb');
  });

  it('a placed robot whose worker is away is asked again once a robot at rest would be, leaving the minute to the next robot', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const dir = makeHome();
    const robots = { c_1: resting(placed, 'c_1', dir, { name: 'golden heron' }) };
    const w = world({ home: { robots }, worker: { robots } });
    worlds.push(w);
    w.home.store.update((d) => { delete d.scribeAsk; });
    const far = vi.spyOn(w.home.router, 'scribe');
    const scribe = w.home.fleet['scribe'];
    const pass = async () => { scribe.tick(); await scribe.settled(); };

    await pass();
    await pass();
    expect(far).toHaveBeenCalledTimes(1);
    expect(w.home.store.state.scribeError).toBeUndefined();
    vi.advanceTimersByTime(REST_MS);
    await pass();
    expect(far).toHaveBeenCalledTimes(2);
  });

  it('a robot moved here while its worker answered has the change carried into its brief, as a robot here does', async () => {
    const dir = makeHome();
    const robots = { c_1: resting(placed, 'c_1', dir, { name: 'golden heron' }) };
    let moveHome = () => {};
    const worker: RunScribe = async () => { moveHome(); return JSON.stringify({ note: 'building the board' }); };
    const { w, scribe } = await open({ home: { robots }, worker: { robots }, scribe: { worker } });
    moveHome = () => w.home.store.update((d) => {
      const c = d.robots.c_1;
      delete c.machine;
      delete c.placement;
      c.agent!.brief = w.home.fleet['render'](d.islands.i_1, c);
    });
    grow(path.join(dir, 'c_1.jsonl'), 4000);

    scribe.tick();
    await scribe.settled();
    const c = w.home.store.state.robots.c_1;
    expect(c.note).toBe('building the board');
    expect(c.agent!.brief).toBe(w.home.fleet['render'](w.home.store.state.islands.i_1, c));
  });

  it('a pass that fails on the worker shows the end of what its child printed in the home\'s scribe error', async () => {
    const dir = makeHome();
    const robots = { c_1: resting(placed, 'c_1', dir, { name: 'golden heron' }) };
    const stderr = `${'x'.repeat(600)}Invalid API key`;
    const fail: RunScribe = async () => { throw new Error('claude -p exited 1', { cause: stderr }); };
    const { w, scribe } = await open({ home: { robots }, worker: { robots }, scribe: { worker: fail } });
    grow(path.join(dir, 'c_1.jsonl'), 4000);

    scribe.tick();
    await scribe.settled();
    expect(w.home.store.state.scribeError?.message).toBe(`claude -p exited 1: ${stderr.slice(-500)}`);
  });

  it('the worker runs no pass of its own and never an island', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const dir = makeHome();
    const robots = { c_1: resting(placed, 'c_1', dir, { name: 'golden heron' }) };
    const ran: string[] = [];
    const { w, scribe, own } = await open({ home: { robots }, worker: { robots }, scribe: { worker: runner({ c_1: kb }, ran) } });
    grow(path.join(dir, 'c_1.jsonl'), 4000);

    for (let n = 0; n < 3; n++) {
      own.tick();
      vi.advanceTimersByTime(SPACING_MS);
    }
    await own.settled();
    expect(ran).toEqual([]);
    await expect(w.worker.fleet.sweep({})).rejects.toThrow('the scribe is off');
    // asked by the home, it passes the robot, and its island stays the home's to describe
    scribe.tick();
    await until(() => expect(ran).toEqual(['c_1']));
    vi.advanceTimersByTime(SETTLE_MS);
    own.tick();
    await own.settled();
    expect(ran).toEqual(['c_1']);
    expect(w.worker.store.state.islands.i_1.description).toBe('');
  });

  it('scribe.sweep at home lists the worker\'s robots\' lines beside its own, and a columns sweep places a placed robot at home', async () => {
    const dir = makeHome();
    const robots = { c_1: resting(placed, 'c_1', dir, { name: 'golden heron' }), c_h: resting(robot, 'c_h', dir) };
    const ran: string[] = [];
    const { w, asked } = await open({
      home: { robots }, worker: { robots },
      scribe: {
        home: runner({ c_h: { note: 'tidying the docs', column: 'Done' } }, ran),
        worker: runner({ c_1: { ...kb, links: [{ url: PLAN, label: 'plan' }], column: 'In review' } }, ran),
      },
    });
    // under what a pass at rest needs, which a sweep does not ask
    grow(path.join(dir, 'c_1.jsonl'), REST_BYTES / 4);
    grow(path.join(dir, 'c_h.jsonl'), REST_BYTES / 4);

    const swept = await dispatch({ id: 1, method: 'scribe.sweep', params: {} }, w.home.ctx);
    expect(asked).toEqual([{ id: 'c_1', sweep: true }]);
    expect(swept).toMatchObject({ result: { lines: expect.arrayContaining(['golden heron → kb', 'kb  note: building the board', 'kb  links: plan', 'c_h  note: tidying the docs']) } });
    expect(w.home.store.state.robots.c_1.context).toEqual([{ kind: 'other', ref: PLAN, label: 'plan', source: 'scribe' }]);
    // the board is not in the prompt while placing waits to be turned on, so neither column moves
    expect(w.home.store.state.robots.c_1.column).toBeUndefined();

    const placedNow = await dispatch({ id: 2, method: 'scribe.sweep', params: { columns: true } }, w.home.ctx);
    expect(asked[1]).toEqual({ id: 'c_1', only: 'columns', columns: w.home.store.state.columns, sweep: true });
    expect(placedNow).toMatchObject({ result: { lines: expect.arrayContaining(['kb  column: In review', 'c_h  column: Done']) } });
    expect(w.home.store.state.robots.c_1.column).toBe('review');
    await until(() => expect(w.worker.store.state.robots.c_1.column).toBe('review'));
  });
});
