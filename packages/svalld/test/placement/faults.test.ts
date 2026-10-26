import { AsyncLocalStorage } from 'node:async_hooks';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FAILPOINTS, armFailpoints, type Edge, type Failpoint } from '../../src/failpoints.js';
import type { StartOptions } from '../../src/placement/move.js';
import { hasGit } from '../git-fixture.js';
import { cleanHomes } from '../helpers.js';
import { Crash, listed, moveWorld, state, until, type MoveWorld } from './move-world.js';
import { H, W } from './world.js';

type Scenario = 'out' | 'back' | 'abort' | 'journal';
type Side = 'home' | 'worker';
type Case = { name: Failpoint; edge: Edge; scenario: Scenario; dies: Side };

const POINTS: Failpoint[] = (Object.keys(FAILPOINTS) as Failpoint[]).filter((n) => /^(move|worker|home|source\.rest)\./.test(n));
type Point = Extract<Failpoint, `move.${string}` | `worker.${string}` | `home.${string}` | `source.rest.${string}`>;

// the side whose daemon reaches each point in each scenario's clean run; a point without an entry does not typecheck
const REACH: Record<Point, Partial<Record<Scenario, Side>>> = {
  'source.rest.terminated': { out: 'home' },
  'source.rest.terminate': { out: 'home' },
  'source.rest.forcekill': { out: 'home' },
  'source.rest.stopped': { out: 'home', back: 'worker', abort: 'home' },
  'source.rest.kill': { out: 'home', back: 'worker', abort: 'home' },
  'source.rest.server.journal': { out: 'home', back: 'worker' },
  'source.rest.server.kill': { out: 'home', back: 'worker' },
  'move.rest': { out: 'home', back: 'worker', abort: 'home' },
  'move.bundle': { out: 'home', back: 'worker', abort: 'home' },
  'move.journal.rest': { out: 'home', back: 'home', abort: 'home' },
  'move.journal.bundle': { out: 'home', back: 'home', abort: 'home' },
  'move.journal.prepare': { out: 'home', back: 'home', abort: 'home' },
  'move.journal.commit': { out: 'home', back: 'home' },
  'move.journal.activate': { out: 'home', back: 'home' },
  'move.journal.release': { out: 'home', back: 'home' },
  'move.journal.done': { out: 'home', back: 'home' },
  'move.journal.aborted': { abort: 'home' },
  'move.commit.state': { out: 'home', back: 'home' },
  'move.release.lock': { out: 'home' },
  'worker.prepare.worktree': { out: 'worker', abort: 'worker' },
  'worker.prepare.apply': { out: 'worker', abort: 'worker' },
  'worker.prepare.session': { out: 'worker', abort: 'worker' },
  'worker.prepare.journal': { out: 'worker' },
  'worker.activate.open': { out: 'worker' },
  'worker.activate.trust': { out: 'worker' },
  'worker.abort.remove': { abort: 'worker' },
  'worker.outbox.append': { out: 'worker', back: 'worker' },
  'worker.outbox.acked': { out: 'worker', back: 'worker', journal: 'worker' },
  'worker.outbox.trim': { out: 'worker', back: 'worker', journal: 'worker' },
  'home.event.applied': { out: 'home', back: 'home', journal: 'home' },
};

const CASES: Case[] = POINTS.flatMap((name) => (Object.entries(REACH[name as Point]) as [Scenario, Side][])
  .flatMap(([scenario, dies]) => (['before', 'after'] as const).map((edge) => ({ name, edge, scenario, dies }))));

const WORLDS: Record<Scenario, Parameters<typeof moveWorld>[0]> = {
  // c_1 is an OpenCode robot whose server outlives its window, and whose second terminal runs a job that holds on through a SIGTERM
  out: { opencode: true, busy: true },
  back: { opencode: true, busy: true },
  // the worker's OpenCode refuses c_1's session, which undoes the move
  abort: { opencode: true },
  journal: { second: true },
};

// each daemon boots, and is called, as its side, so a failpoint's hook knows which one reached it
const sides = new AsyncLocalStorage<Side>();
const on = <T>(side: Side, run: () => T): T => sides.run(side, run);

const worlds: MoveWorld[] = [];
let disarm: (() => void) | undefined;
// the side that died, its link's stop, and the boot of the worker the home was linked to then
let died: { side: Side; gone?: Promise<void>; boot?: string } | undefined;
afterEach(async () => {
  disarm?.();
  disarm = undefined;
  died = undefined;
  for (const w of worlds.splice(0)) await w.stop();
  cleanHomes();
});
const open = (o: Parameters<typeof moveWorld>[0] = {}): MoveWorld => { const w = moveWorld(o); worlds.push(w); return w; };

// fires `then` at a step's edge, once
const at = (name: Failpoint, edge: Edge, then: () => void): void => {
  let done = false;
  disarm = armFailpoints((n, e) => { if (!done && n === name && e === edge) { done = true; then(); } });
};

// the worker's outbox is acked to its end, and the home holds every event in it
const drained = (w: MoveWorld): boolean =>
  w.worker.outbox.after(w.worker.outbox.acked()).length === 0 && (w.home.store.state.machines?.[W]?.replayed?.seq ?? 0) === w.worker.outbox.last();

const journaled = (w: MoveWorld): string[] => (fs.existsSync(w.homePaths.moves) ? fs.readdirSync(w.homePaths.moves) : [])
  .filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -'.json'.length));

// moves `id` to w1 and waits until it runs there as the home last said
async function moved(w: MoveWorld, id: string, o: StartOptions = {}): Promise<void> {
  await on('home', () => w.home.placement.start(id, W, o));
  await until(() => {
    const c = w.worker.store.state.robots[id];
    expect([!!c?.tmux, c?.moving, drained(w)]).toEqual([true, undefined, true]);
  });
}

// the side's daemon stops: what it does after throws, and its link goes down with it
function down(w: MoveWorld, side: Side): Promise<void> | undefined {
  if (side === 'home') {
    w.home.life.dead = true;
    w.home.links.stop();
    w.home.placement.stop();
    return undefined;
  }
  const gone = w.worker.connection.stop();
  w.worker.life.dead = true;
  return gone;
}

// a world for `s` with what `s` holds before its run
async function boot(s: Scenario): Promise<MoveWorld> {
  const w = open(WORLDS[s]);
  await on('worker', () => w.bootWorker());
  await on('home', () => w.bootHome());
  if (s === 'back') await moved(w, 'c_1', { interruptAfterMs: 0 });
  if (s === 'abort') w.opencode.far.failImports = 1;
  if (s === 'journal') {
    await moved(w, 'c_1');
    await moved(w, 'c_2');
    // this Mac sleeps, and meanwhile c_1 and c_2 report a status each and c_2 is closed there
    down(w, 'home');
    await on('worker', async () => {
      for (const id of ['c_1', 'c_2']) w.worker.store.update((d) => { d.robots[id].agent!.status = 'working'; });
      await w.worker.mutations.serve('robot.close', { id: 'c_2' });
    });
  }
  return w;
}

// a move out, its return, a move out the worker refuses, or this Mac waking to what the worker journaled meanwhile
const act = (w: MoveWorld, s: Scenario): Promise<unknown> => on('home', () => {
  if (s === 'out') return w.home.placement.start('c_1', W, { interruptAfterMs: 0 });
  if (s === 'back') return w.home.placement.start('c_1', H);
  if (s === 'abort') return w.home.placement.start('c_1', W);
  return w.bootHome();
});

// a run to its end: the robot up where it ends, and the worker's outbox drained
async function clean(w: MoveWorld, s: Scenario): Promise<void> {
  if (s === 'abort') await expect(act(w, s)).rejects.toThrow(`OpenCode did not import session`);
  else await act(w, s);
  const ends = s === 'out' ? w.worker : w.home;
  await until(() => expect([drained(w), s === 'journal' || !!ends.store.state.robots.c_1?.tmux]).toEqual([true, true]));
}

// every edge of a point reached from here on, with the side that reached it
function recordPoints(): Set<string> {
  const hit = new Set<string>();
  disarm = armFailpoints((name, edge) => { if (edge !== 'threw' && POINTS.includes(name)) hit.add(`${name}:${edge}:${sides.getStore()}`); });
  return hit;
}

// the side `k` names dies the first time it reaches `k`'s edge
function crashAt(w: MoveWorld, k: Case): void {
  disarm = armFailpoints((name, edge) => {
    if (died || name !== k.name || edge !== k.edge || sides.getStore() !== k.dies) return;
    // what the home took of the event it dies writing was in its memory alone
    if (name === 'home.event.applied' && edge === 'before') w.applied.pop();
    died = { side: k.dies, boot: w.home.links.for(W)?.hello()?.bootId, gone: down(w, k.dies) };
    throw new Crash(`${k.dies} died at ${name}:${edge}`);
  });
}

// a run that `k` cuts short, and the side that died booted again from what it left on disk and linked again
async function crashed(w: MoveWorld, k: Case): Promise<void> {
  crashAt(w, k);
  const ran = act(w, k.scenario).catch(() => {});
  await until(() => expect(died?.side).toBe(k.dies));
  if (k.dies === 'home') await on('home', () => w.bootHome());
  else {
    await died!.gone;
    await on('worker', () => w.bootWorker());
    await until(() => {
      const link = w.home.links.for(W);
      expect([link?.synced, link?.hello()?.bootId === died!.boot]).toEqual([true, false]);
    });
  }
  await ran;
}

describe('the placement failpoints', () => {
  it('strikes both edges of every move, rest, worker and outbox failpoint', () => {
    expect(new Set(CASES.map((k) => `${k.name}:${k.edge}`))).toEqual(new Set(POINTS.flatMap((n) => [`${n}:before`, `${n}:after`])));
  });

  for (const s of ['out', 'back', 'abort', 'journal'] as const) {
    it.skipIf(!hasGit)(`reaches, in a clean ${s} run, each point CASES names for it, on the side it names`, async () => {
      const w = await boot(s);
      const hit = recordPoints();
      await clean(w, s);
      const named = CASES.filter((k) => k.scenario === s).map((k) => `${k.name}:${k.edge}:${k.dies}`);
      expect(named.filter((x) => !hit.has(x))).toEqual([]);
      // and names every point the run reaches
      expect([...hit].filter((x) => !named.includes(x))).toEqual([]);
    });
  }
});

describe.skipIf(!hasGit)('a crash of either side during a move', () => {
  for (const k of CASES.filter((c) => c.scenario !== 'journal')) {
    it(`a ${k.dies} that dies at ${k.name}:${k.edge} moving ${k.scenario} ends with the move done or aborted and the robot on exactly one machine`, async () => {
      const w = await boot(k.scenario);
      const earlier = journaled(w);
      const opens = (box: MoveWorld['mac1']) => box.opened.filter((n) => n === 'c_1').length;
      const opened = { mac: opens(w.mac1), far: opens(w.vault) };
      await crashed(w, k);
      await on('home', () => w.home.placement.recoverMoves());

      const [id] = journaled(w).filter((x) => !earlier.includes(x));
      const phase = (): string => (id ? w.home.placement.status(id).phase : 'never journaled');
      await until(() => expect(['done', 'aborted', 'never journaled']).toContain(phase()));
      const [from, to] = k.scenario === 'back' ? [W, undefined] : [undefined, W];
      const here = w.home.store.state.robots.c_1;
      expect(here.moving).toBeUndefined();
      expect(here.machine).toBe(phase() === 'done' ? to : from);
      const [box, other, there] = here.machine === W ? [w.vault, w.mac1, w.worker.store] : [w.mac1, w.vault, w.home.store];
      const windows = (b: MoveWorld['mac1'], name: string) => [...b.windows.values()].filter((x) => x.name === name);
      for (const name of WORLDS[k.scenario]?.busy ? ['c_1', 'c_1-2'] : ['c_1']) {
        expect([...windows(w.mac1, name), ...windows(w.vault, name)]).toHaveLength(1);
        expect(windows(box, name)).toHaveLength(1);
      }
      // the machine it does not run on never opened it, and the one it runs on names its window
      expect(opens(other)).toBe(other === w.mac1 ? opened.mac : opened.far);
      await until(() => expect(there.state.robots.c_1?.tmux?.windowId).toBe(windows(box, 'c_1')[0].windowId));
      await until(() => expect(w.worker.store.state.robots.c_1?.machine).toBe(here.machine));
      // no OpenCode server a closed window left runs on beside it
      expect([...w.mac1.left, ...w.vault.left]).toEqual([]);
      // where it runs is unlocked, and what it left is locked by the move that took it; a move out undone leaves nothing there
      const far = fs.existsSync(w.clone) ? listed(w, w.clone, w.farWt) : undefined;
      const [mine, left] = here.machine === W ? [far, listed(w, w.main, w.wt)] : [listed(w, w.main, w.wt), far];
      expect(mine).toEqual({});
      if (phase() === 'done') expect(left?.locked).toBe(`moved to ${k.scenario === 'back' ? 'mac' : 'w1'} ${id}`);
      else if (k.scenario === 'back') expect(left?.locked).toMatch(/^moved to w1 mv_/);
      else expect([left, fs.existsSync(w.farWt)]).toEqual([undefined, false]);
      // a move deletes nothing on its source
      expect(fs.existsSync(k.scenario === 'back' ? w.farWt : w.wt)).toBe(true);
      // and loses no event the worker journaled
      await until(() => expect(drained(w)).toBe(true));
    });
  }
});

describe.skipIf(!hasGit)('a crash while this Mac takes what the worker journaled', () => {
  for (const k of CASES.filter((c) => c.scenario === 'journal')) {
    it(`a ${k.dies} that dies at ${k.name}:${k.edge} loses no journaled event, and the home applies each once and in seq order`, async () => {
      const w = await boot('journal');
      const before = w.applied.length;
      await crashed(w, k);
      await until(() => expect(drained(w)).toBe(true));

      expect(w.applied.slice(before)).toEqual(['robot.sync c_1', 'robot.sync c_2', 'robot.close c_2']);
      const { outbox } = w.worker;
      expect(w.home.store.state.machines?.[W]?.replayed?.seq).toBe(outbox.last());
      expect(outbox.after(outbox.acked())).toEqual([]);
      expect(Object.hasOwn(w.home.store.state.robots, 'c_2')).toBe(false);
    });
  }
});

describe.skipIf(!hasGit)('a crash of the home during a move', () => {
  it('a worker linked again after a crash at move.journal.activate starts the robot only once it holds the commit\'s snapshot', async () => {
    const w = open();
    const first = await w.start();
    at('move.journal.activate', 'before', () => { first.life.dead = true; throw new Crash('svalld died'); });
    await expect(first.placement.start('c_1', W)).rejects.toThrow(Crash);
    first.links.stop();
    const [file] = fs.readdirSync(w.homePaths.moves).filter((f) => f.endsWith('.json'));
    const id = file.slice(0, -'.json'.length);
    // what the worker holds of the robot is its own prepare's, marked so
    expect(w.worker.store.state.robots.c_1).toMatchObject({ machine: W, placement: { generation: 1 }, moving: { id, phase: 'prepare' } });
    let held: unknown;
    at('worker.activate.open', 'before', () => { held = structuredClone(w.worker.store.state.robots.c_1.moving); });

    // the link answers at once and syncs late: the move runs on as it answers, and waits for the sync
    const again = await w.bootHome(undefined, { syncAfterMs: 1500 });

    await until(() => { expect(again.placement.status(id).phase).toBe('done'); });
    expect(held).toEqual({ id, to: W, phase: 'activate' });
    expect(w.vault.opened).toEqual(['c_1']);
  });

  it('a return cut short before its commit leaves the robot on the worker and the Mac worktree locked, and the next return goes through', async () => {
    const w = open();
    const first = await w.start();
    await first.placement.start('c_1', W);
    w.g(w.farWt, 'commit', '-qm', 'staged work');
    fs.appendFileSync(path.join(w.farWt, 'b.txt'), 'more\n');
    at('move.journal.commit', 'before', () => { first.life.dead = true; throw new Crash('svalld died'); });
    await expect(first.placement.start('c_1', H)).rejects.toThrow(Crash);
    first.links.stop();
    disarm?.();

    const again = await w.bootHome();
    await again.placement.recoverMoves();
    const here = again.store.state.robots.c_1;
    expect(here).toMatchObject({ machine: W });
    expect(here.moving).toBeUndefined();
    expect(listed(w, w.main, w.wt)?.locked).toMatch(/^moved to w1 mv_/);
    await until(() => { expect(w.worker.store.state.robots.c_1?.tmux).toBeDefined(); });
    expect(w.vault.opened).toEqual(['c_1', 'c_1']);

    const there = state(w, w.farWt);
    await again.placement.start('c_1', H);
    expect(state(w, w.wt)).toEqual(there);
    expect(again.store.state.robots.c_1.machine).toBeUndefined();
  });
});
