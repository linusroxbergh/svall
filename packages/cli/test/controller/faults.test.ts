import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import type { Outcome } from '@svall/protocol';
import { armFailpoints } from '@svall/svalld/handover/failpoints';
import * as real from '../../../svalld/test/handover/fault-world.js';
import { cleanHomes, makeHome } from '../../../svalld/test/helpers.js';
import { runHandover, type CliDeps, type Ctx, type Transaction } from '../../src/commands/handover.js';
import type { Handover } from '../../src/controller/handover.js';
import { helperPaths } from '../../src/controller/helper.js';
import { MachineRegistry } from '../../src/controller/registry.js';
import { World, controller, keptCommit, opIndex, recover, settledOn, trift, type Fault } from './world.js';

afterEach(cleanHomes);

// ---- the Task 27 world: fake daemons and a gateway on the real compare-and-swap, every call of a run struck

const EVERY: Fault['kind'][] = ['death', 'lost', 'dropped', 'partition', 'duplicate', 'stale'];

/** What can strike a call: the store is the controller's own disk, and the transfer its own rsync, which it waits out before it runs another. */
const kindsOf = (op: string): Fault['kind'][] => (op.startsWith('store:') ? ['death'] : op.startsWith('transfer:') ? EVERY.slice(0, 4) : EVERY);

type Run = () => { w: World; go(): Promise<Outcome> };

/**
 * A move; one the user cancels once the destination has prepared, which aborts it; a move whose claim asks the source
 * about a kept commit; and runs whose Begin, cancelled meanwhile, or whose Commit goes unanswered, so the gateway is asked.
 */
const RUNS: Record<string, Run> = {
  move: () => {
    const w = new World();
    return { w, go: () => controller(w).start(trift, {}) };
  },
  'cancel once prepared': () => {
    const w = new World();
    const c = controller(w);
    const prepare = w.destination.answers['handover.prepare'];
    w.destination.answers['handover.prepare'] = ((p: never) => { const r = prepare(p); c.cancel(); return r; }) as never;
    return { w, go: () => c.start(trift, {}) };
  },
  'a kept commit': () => {
    const { w } = keptCommit({ reached: true, at: 'claim' });
    return { w, go: () => controller(w).start(trift, {}) };
  },
  'a cancel while Begin goes unanswered': () => {
    const w = new World();
    const c = controller(w);
    const begin = w.gateway.begin;
    w.gateway.begin = async (p) => {
      w.gateway.begin = begin;
      await begin(p);
      c.cancel();
      throw new Error('gateway begin: the connection dropped before the answer');
    };
    return { w, go: () => c.start(trift, {}) };
  },
  'a Commit whose answer is lost': () => {
    const w = new World();
    const commit = w.gateway.commit;
    w.gateway.commit = async (p) => {
      w.gateway.commit = commit;
      await commit(p);
      throw new Error('gateway commit: the connection dropped before the answer');
    };
    return { w, go: () => controller(w).start(trift, {}) };
  },
};

/** The calls each run makes, and those its cases strike: every one of a move's, and of any other run only those sent from a line of the controller the move never sends from. */
async function probeRuns(): Promise<Record<string, { ops: string[]; sites: (number | undefined)[]; at: number[]; committedAt: number }>> {
  const probe = async (make: Run) => { const { w, go } = make(); await go(); return w; };
  // a write to the controller's store is known by its name
  const key = (w: World, i: number) => w.sites[i] ?? w.ops[i];
  const m = await probe(RUNS.move);
  const move = new Set(m.ops.map((_, i) => key(m, i)));
  const out: Record<string, { ops: string[]; sites: (number | undefined)[]; at: number[]; committedAt: number }> = {};
  for (const [name, make] of Object.entries(RUNS)) {
    const p = await probe(make);
    out[name] = { ops: p.ops, sites: p.sites, at: p.ops.flatMap((_, i) => (name === 'move' || !move.has(key(p, i)) ? [i] : [])), committedAt: opIndex(p, 'gateway:commit') };
  }
  return out;
}
const RAN = await probeRuns();

describe('a fault of any kind at any call of a controller run', () => {
  for (const name of Object.keys(RUNS)) {
    it(`${name}: settles the fleet on exactly one machine, and after the commit on the destination, whatever strikes where`, async () => {
      const { ops, at: points, committedAt } = RAN[name];
      let cases = 0;
      for (const at of points) {
        for (const kind of kindsOf(ops[at])) {
          const { w, go } = RUNS[name]();
          w.fault = { at, kind };
          const what = `${kind} at ${ops[at]} (${at})`;
          const first = await go().catch((e: unknown) => ({ status: 'threw', error: String(e) }));
          expect((first as { status: string }).status, what).not.toBe('threw');
          expect(w.ops[at], what).toBe(ops[at]);
          const committed = w.moved();
          const outcomes = await recover(w);
          let where: string;
          try { where = settledOn(w); } catch (e) { throw new Error(`${what}: ${(e as Error).message}\n${JSON.stringify(first)}\n${JSON.stringify(outcomes)}\n${w.ops.join(' ')}`); }
          // a commit that took effect is final, whatever the controller saw of it
          if (committed) expect(where, what).toBe('destination');
          if (committedAt >= 0 && at > committedAt) expect(committed, what).toBe(true);
          expect(outcomes.at(-1)!.status, what).not.toBe('interrupted');
          cases++;
        }
      }
      expect(cases).toBeGreaterThan(name === 'move' ? 120 : 5);
    });

    it(`${name}: takes the fleet back with an abort from any point before the commit, and refuses one after it`, async () => {
      const { ops, at: points, committedAt } = RAN[name];
      for (const at of points) {
        for (const kind of kindsOf(ops[at])) {
          const { w, go } = RUNS[name]();
          const what = `${kind} at ${ops[at]} (${at})`;
          w.fault = { at, kind };
          await go();
          const committed = w.moved();
          const left = w.store.j !== undefined;
          const outcomes = await recover(w, 'abort');
          let where: string;
          try { where = settledOn(w); } catch (e) { throw new Error(`${what}: ${(e as Error).message}\n${JSON.stringify(outcomes)}\n${w.ops.join(' ')}`); }
          expect(where, what).toBe(committed ? 'destination' : 'source');
          if (committedAt >= 0 && at > committedAt) expect(committed, what).toBe(true);
          // an abort asked of a fleet that moved, with anything of it still open, is refused, and only a resume goes on
          if (committed && left) expect(outcomes[0], what).toMatchObject({ status: 'interrupted', safe: ['resume'] });
        }
      }
    });
  }
});

// ---- the real daemons behind their guard and the real gateway on its socket, every request of a run struck

type Script = {
  /** what happens before the run whose requests are struck */
  before?: (w: real.World) => Promise<void>;
  go: (w: real.World) => Promise<Outcome>;
  /** the label of the first request the cases strike, when an earlier one is another script's */
  from?: string;
  /** the label of the first request the cases leave alone, as a later script's */
  until?: string;
};

/** A first run a controller crash interrupts, once the source froze or once the gateway committed. */
const crashed = (at: 'controller.manifest' | 'controller.commit') => async (w: real.World): Promise<void> => {
  w.targets = [{ name: at, edge: 'after', nth: 1 }];
  await real.play(w, 'move');
};
const resume = (w: real.World): Promise<Outcome> => { const c = w.controller(); return w.run(() => c.resume()); };
const abort = (w: real.World): Promise<Outcome> => { const c = w.controller(); return w.run(() => c.abort()); };

/** A start from this machine whose controller dies as it would ask the gateway to record `at`. */
async function diesAt(w: real.World, at: string): Promise<void> {
  const a = party(w, 'mac', 'start');
  const life = w.lifeOfController(a.c);
  w.gate = async (g) => { if (g.life === life && g.label === at) life.dead = true; };
  await a.go();
  w.gate = undefined;
}

/** A handover whose controller died once the destination prepared, and whose journal no controller can read. */
const unreadable = async (w: real.World): Promise<void> => {
  await diesAt(w, 'gateway ready');
  fs.writeFileSync(path.join(w.ctlDir, 'handover.json'), '{"version":1,');
};

/** An abort here, before whose gateway abort a resume on trift takes the handover whole to trift. */
async function overtaken(w: real.World): Promise<Outcome> {
  const a = party(w, 'mac', 'abort');
  const held = w.lifeOfController(a.c);
  w.gate = async ({ life, label }) => {
    if (life !== held || label !== 'gateway abort') return;
    w.gate = undefined;
    await party(w, 'trift', 'resume').go();
  };
  try {
    return await a.go();
  } finally {
    w.gate = undefined;
  }
}

const SCRIPTS: Record<string, Script> = {
  move: { go: (w) => real.play(w, 'move') },
  'cancel once prepared': { go: (w) => real.play(w, 'abort') },
  'cancel during the transfer': { go: (w) => real.play(w, 'cancel') },
  // the rest of this resume is the move's again
  'resume once frozen': { before: crashed('controller.manifest'), go: resume, until: 'trift handover.claim' },
  'abort once frozen': { before: crashed('controller.manifest'), go: abort },
  'resume once committed': { before: crashed('controller.commit'), go: resume },
  // the journal is rebuilt from the daemons', and the destination asked to prepare again with nothing landed
  "resume from the daemons' journals once prepared": { before: unreadable, go: resume },
  // the gateway answers the abort at the next generation, and is asked where the fleet went
  'abort once prepared, overtaken by a resume on trift': { before: (w) => diesAt(w, 'gateway ready'), go: overtaken, from: 'gateway abort' },
};

/** Each script's requests, run once at collection: a request a script shares with the move before they part is the move's to strike. */
async function probeScripts(): Promise<Record<string, { labels: string[]; sites: (number | undefined)[]; at: number[] }>> {
  const out: Record<string, { labels: string[]; sites: (number | undefined)[]; at: number[] }> = {};
  for (const [name, s] of Object.entries(SCRIPTS)) {
    const w = await real.World.create();
    const disarm = armFailpoints((n, edge) => w.hit(n, edge));
    try {
      await s.before?.(w);
      const from = w.requests.length;
      await s.go(w);
      const labels = w.requests.slice(from);
      const move = out.move?.labels;
      const parted = s.before || !move ? 0 : labels.findIndex((l, i) => l !== move[i]);
      const [start, end] = [s.from ? labels.indexOf(s.from) : parted < 0 ? labels.length : parted, s.until ? labels.indexOf(s.until) : labels.length];
      if (start < 0 || end < 0) throw new Error(`${name}: its run sent no ${start < 0 ? s.from : s.until}, but ${labels.join(', ')}`);
      const at = labels.flatMap((_, i) => (i >= start && i < end ? [i] : []));
      if (!at.length) throw new Error(`${name}: its run sent no request of its own to strike`);
      out[name] = { labels, sites: w.sites.slice(from), at };
    } finally {
      disarm();
      await w.stop();
    }
  }
  return out;
}
const PROBED = await probeScripts();

/** The link carries rsync, which the controller waits out before it runs another, so no copy of one arrives twice or late. */
const messagesOf = (label: string): real.MessageKind[] =>
  (label.startsWith('link ') ? ['lost', 'dropped', 'partition'] : ['lost', 'dropped', 'duplicate', 'stale', 'partition']);

describe('a message fault at every request of the controller', () => {
  const world = real.worlds();

  for (const [name, s] of Object.entries(SCRIPTS)) {
    const { labels, at } = PROBED[name];
    for (const i of at) {
      for (const kind of messagesOf(labels[i])) {
        for (const prefer of ['resume', 'abort'] as const) {
          it(`${name}: ${kind} at ${labels[i]} (#${i}), then ${prefer}`, async () => {
            const w = world();
            await s.before?.(w);
            const k = w.requests.length + i;
            w.message = { at: k, kind };
            const first = await s.go(w);
            const holding = w.record().transaction?.id;
            const said = await w.recover(prefer);
            const why = () => `${JSON.stringify(first)}\n${said.join(' ')}\n${w.violations.join('\n')}\n${w.trace.join(' | ')}`;
            // an abort is reported only once the gateway has let go of the handover
            if (first.status === 'aborted') expect(holding, why()).not.toBe(first.transactionId);
            expect(w.requests[k], why()).toBe(labels[i]);
            expect(w.violations, why()).toEqual([]);
            // a request repeated or held back opens no second handover
            expect(w.transactions.size, why()).toBeLessThanOrEqual(1);
            let where: string;
            try { where = real.settledOn(w); } catch (e) { throw new Error(`${(e as Error).message}\n${why()}`); }
            if (w.everMoved) expect(where, why()).toBe('destination');
          });
        }
      }
    }
  }
});

// ---- an unknown Commit: the controller asks the gateway, and never gives the source its fleet back while it cannot say

describe('an unknown Commit', () => {
  const world = real.worlds();
  const COMMIT = PROBED.move.labels.indexOf('gateway commit');

  /** A move whose Commit meets `kind`; with `away`, the gateway is out of the controller's reach from the request after it until recovery. */
  async function unknown(w: real.World, kind: 'lost' | 'dropped', away: boolean): Promise<Outcome> {
    w.message = { at: COMMIT, kind };
    if (away) w.gate = async () => { if (w.requests.length > COMMIT) w.cut.add('gateway'); };
    try {
      return await real.play(w, 'move');
    } finally {
      w.gate = undefined;
    }
  }
  const sent = (w: real.World, label: string): number => w.requests.filter((r) => r === label).length;

  it('asks the gateway once the answer is lost after it committed, and goes on to the destination without sending the Commit again', async () => {
    const w = world();
    expect(await unknown(w, 'lost', false)).toMatchObject({ status: 'complete' });
    expect(w.requests[COMMIT + 1]).toBe('gateway get');
    expect(sent(w, 'gateway commit')).toBe(1);
    expect(sent(w, 'mac handover.abort')).toBe(0);
    expect(w.violations).toEqual([]);
    expect(real.settledOn(w)).toBe('destination');
  });

  it('asks the gateway once the Commit never reached it, and sends it again while the gateway holds it ready', async () => {
    const w = world();
    expect(await unknown(w, 'dropped', false)).toMatchObject({ status: 'complete' });
    expect(w.requests.slice(COMMIT, COMMIT + 3)).toEqual(['gateway commit', 'gateway get', 'gateway commit']);
    expect(sent(w, 'mac handover.abort')).toBe(0);
    expect(w.violations).toEqual([]);
    expect(real.settledOn(w)).toBe('destination');
  });

  for (const kind of ['lost', 'dropped'] as const) {
    for (const prefer of ['resume', 'abort'] as const) {
      it(`${kind === 'lost' ? 'after' : 'before'} the gateway committed, with the gateway then out of reach, stops with nothing safe, fences the source, and ${prefer} settles it once the gateway answers`, async () => {
        const w = world();
        expect(await unknown(w, kind, true)).toMatchObject({ status: 'interrupted', phase: 'commit', safe: [] });
        expect(w.moved()).toBe(kind === 'lost');
        expect(w.mac.can()).toBe(false);
        expect(w.trift.can()).toBe(false);
        // nothing a controller asks while the gateway cannot say moves the fleet anywhere
        const owners = () => [w.mac, w.trift].map((m) => m.current!.ownership.record());
        const before = owners();
        for (const act of [abort, resume]) {
          const again = await act(w);
          expect(again).toMatchObject({ status: 'interrupted', safe: [] });
        }
        expect(owners()).toEqual(before);
        expect(sent(w, 'mac handover.abort')).toBe(0);
        const said = await w.recover(prefer);
        expect(w.violations, said.join(' ')).toEqual([]);
        expect(real.settledOn(w)).toBe(kind === 'lost' || prefer === 'resume' ? 'destination' : 'source');
        if (kind === 'lost') expect(sent(w, 'mac handover.abort')).toBe(0);
      });
    }
  }
});

// ---- a cancel while Begin goes unanswered: an abort closes what the gateway may have opened

describe('a cancel while Begin goes unanswered', () => {
  const world = real.worlds();
  const BEGIN = PROBED.move.labels.indexOf('gateway begin');

  /** A start the user cancels as its Begin goes out, whose answer is lost; with `away`, the gateway then cannot be asked. */
  async function cancelled(w: real.World, away: boolean): Promise<Outcome> {
    const a = party(w, 'mac', 'start');
    w.message = { at: BEGIN, kind: 'lost' };
    w.gate = async () => {
      if (w.requests.length === BEGIN) a.c.cancel();
      if (away && w.requests.length > BEGIN) w.cut.add('gateway');
    };
    try {
      return await a.go();
    } finally {
      w.gate = undefined;
    }
  }

  it('asks the gateway whether it opened the handover, and aborts the one it did', async () => {
    const w = world();
    expect(await cancelled(w, false)).toMatchObject({ status: 'aborted', phase: 'begin' });
    expect(w.record().transaction).toBeUndefined();
    expect(w.violations).toEqual([]);
    expect(real.settledOn(w)).toBe('source');
  });

  it('with the gateway then out of reach, keeps its journal and offers the abort, which closes what the gateway opened once it answers', async () => {
    const w = world();
    const out = await cancelled(w, true);
    expect(out).toMatchObject({ status: 'interrupted', phase: 'begin', safe: ['abort'] });
    expect(w.record().transaction).toMatchObject({ phase: 'preparing' });
    expect(fs.existsSync(path.join(w.ctlDir, 'handover.json'))).toBe(true);
    // nothing was frozen, so the source runs its fleet meanwhile
    expect(w.mac.can()).toBe(true);
    const said = await w.recover('abort');
    expect(said).toContain('abort->aborted');
    expect(w.violations).toEqual([]);
    expect(real.settledOn(w)).toBe('source');
  });
});

// ---- a cancel whose abort the gateway does not answer: nothing is reported aborted while the gateway may hold the handover

describe('a cancel whose abort goes unanswered', () => {
  const world = real.worlds();
  const BEGIN = PROBED.move.labels.indexOf('gateway begin');

  it('before Freeze, keeps its journal and offers the abort, which closes the handover once the gateway answers', async () => {
    const w = world();
    const a = party(w, 'mac', 'start');
    w.gate = async () => { if (w.requests.length === BEGIN) a.c.cancel(); };
    w.message = { at: BEGIN + 1, kind: 'partition' };
    const out = await a.go();
    w.gate = undefined;
    expect(w.requests.slice(BEGIN)).toEqual(['gateway begin', 'gateway abort']);
    const tx = w.record().transaction;
    expect(tx).toMatchObject({ phase: 'preparing' });
    expect(out).toMatchObject({ status: 'interrupted', phase: 'begin', transactionId: tx!.id, safe: ['abort'] });
    expect(fs.existsSync(path.join(w.ctlDir, 'handover.json'))).toBe(true);
    expect(w.mac.can()).toBe(true);
    const said = await w.recover('abort');
    expect(said).toContain('abort->aborted');
    expect(w.violations).toEqual([]);
    expect(real.settledOn(w)).toBe('source');
  });
});

// ---- two controllers

type Act = 'start' | 'resume' | 'abort';
type Party = { c: Handover; go: () => Promise<Outcome> };

/** One controller's run, on this machine or on trift. */
function party(w: real.World, on: 'mac' | 'trift', act: Act): Party {
  const c = w.controller(on === 'mac' ? undefined : w.triftSeat);
  const go = act === 'start' ? () => c.start(real.TRIFT, real.choices(w)) : act === 'resume' ? () => c.resume() : () => c.abort();
  return { c, go: () => w.run(go, c) };
}

type Race = { before?: (w: real.World) => Promise<void>; outer: [on: 'mac' | 'trift', act: Act]; inner: [on: 'mac' | 'trift', act: Act] };

/** Two controllers on different machines: each pair meets at every request of the first, the second run whole there. */
const RACES: Record<string, Race> = {
  'a start here and a start on trift': { outer: ['mac', 'start'], inner: ['trift', 'start'] },
  'a start on trift and a start here': { outer: ['trift', 'start'], inner: ['mac', 'start'] },
  'a start here and an abort on trift': { outer: ['mac', 'start'], inner: ['trift', 'abort'] },
  'a start here and a resume on trift': { outer: ['mac', 'start'], inner: ['trift', 'resume'] },
  'a resume here and an abort on trift, once frozen': { before: crashed('controller.manifest'), outer: ['mac', 'resume'], inner: ['trift', 'abort'] },
  'an abort here and a resume on trift, once frozen': { before: crashed('controller.manifest'), outer: ['mac', 'abort'], inner: ['trift', 'resume'] },
  'a resume here and a resume on trift, once frozen': { before: crashed('controller.manifest'), outer: ['mac', 'resume'], inner: ['trift', 'resume'] },
  'an abort here and an abort on trift, once frozen': { before: crashed('controller.manifest'), outer: ['mac', 'abort'], inner: ['trift', 'abort'] },
};

/** The requests of each race's first controller, run alone at collection. */
async function probeRaces(): Promise<Record<string, string[]>> {
  const out: Record<string, string[]> = {};
  for (const [name, r] of Object.entries(RACES)) {
    const w = await real.World.create();
    const disarm = armFailpoints((n, edge) => w.hit(n, edge));
    try {
      await r.before?.(w);
      const from = w.requests.length;
      await party(w, ...r.outer).go();
      out[name] = w.requests.slice(from);
    } finally {
      disarm();
      await w.stop();
    }
  }
  return out;
}
const RACED = await probeRaces();

/** Runs `inner` whole while `outer` waits before its `at`th request, or both at once without `at`. */
async function race(w: real.World, outer: Party, inner: Party, at?: number): Promise<Outcome[]> {
  if (at === undefined) return Promise.all([outer.go(), inner.go()]);
  const held = w.lifeOfController(outer.c);
  let ran: Promise<Outcome> | undefined;
  w.gate = async ({ life, n }) => {
    if (life !== held || n !== at || ran) return;
    ran = inner.go();
    await ran.catch(() => undefined);
  };
  try {
    const first = await outer.go();
    expect(ran, 'the first controller never reached that request').toBeDefined();
    return [first, await ran!];
  } finally {
    w.gate = undefined;
  }
}

/** Both machines' controllers, each doing what status leaves safe, then where the fleet came to rest. */
async function settleBoth(w: real.World, outcomes: Outcome[]): Promise<'source' | 'destination'> {
  const said = [...await w.recover('resume'), '|', ...await w.recover('resume', w.triftSeat)];
  const why = `${JSON.stringify(outcomes)}\n${said.join(' ')}\n${w.violations.join('\n')}\n${w.trace.join(' | ')}`;
  expect(w.violations, why).toEqual([]);
  // at most one handover ever opened, and one the gateway committed was aborted by no one
  expect(w.transactions.size, why).toBeLessThanOrEqual(1);
  if (w.everMoved) expect(outcomes.map((o) => o.status), why).not.toContain('aborted');
  let where: 'source' | 'destination';
  try { where = real.settledOn(w); } catch (e) { throw new Error(`${(e as Error).message}\n${why}`); }
  if (w.everMoved) expect(where, why).toBe('destination');
  return where;
}

describe('two controllers on different machines', () => {
  const world = real.worlds();

  for (const [name, r] of Object.entries(RACES)) {
    it(`${name}, both at once`, async () => {
      const w = world();
      await r.before?.(w);
      const outcomes = await race(w, party(w, ...r.outer), party(w, ...r.inner));
      await settleBoth(w, outcomes);
    });

    RACED[name].forEach((label, at) => {
      if (label.startsWith('link ')) return;
      it(`${name}, the second whole before the first's ${label} (#${at})`, async () => {
        const w = world();
        await r.before?.(w);
        const outcomes = await race(w, party(w, ...r.outer), party(w, ...r.inner), at);
        await settleBoth(w, outcomes);
      });
    });
  }

  for (const same of [true, false]) {
    it(`two starts whose Begins reach the gateway together, ${same ? 'with the same choices' : 'the second also interrupting agents'}, open one handover, and the fleet settles once`, async () => {
      const w = world();
      let arrived = 0;
      let both!: () => void;
      const met = new Promise<void>((r) => { both = r; });
      w.gate = async ({ label }) => {
        if (label !== 'gateway begin' || arrived >= 2) return;
        if (++arrived === 2) both();
        await met;
      };
      // a start that ends before its Begin lets the other go on, so the count below fails instead of the wait timing out
      const meets = (p: Party): Party => ({ ...p, go: () => p.go().finally(both) });
      const second = party(w, 'trift', 'start');
      const outcomes = await race(w, meets(party(w, 'mac', 'start')), meets(same ? second : { ...second, go: () => w.run(() => second.c.start(real.TRIFT, { ...real.choices(w), interruptAfterMs: 0 }), second.c) }));
      w.gate = undefined;
      expect(arrived).toBe(2);
      // the gateway answers a Begin between the same machines at the same generation with the handover it holds, so both drive that one
      expect(await settleBoth(w, outcomes)).toBe('destination');
    });
  }
});

describe('two controllers on one machine', () => {
  const world = real.worlds();

  /** The command's view of controller `c` of world `w`, each call made in that controller's own process. */
  const transaction = (w: real.World, c: Handover): Transaction => {
    const run = <T>(work: () => Promise<T>): Promise<T> => w.run(work, c);
    return {
      handover: {
        start: (to, choices) => run(() => c.start(to, choices)),
        resume: () => run(() => c.resume()),
        abort: () => run(() => c.abort()),
        status: () => run(() => c.status()),
        choose: (choices) => c.choose(choices),
        cancel: () => c.cancel(),
        get finished() { return c.finished; },
      },
      secrets: () => [],
      close: async () => {},
    };
  };

  it('refuses a second start, resume or abort here at every request of a running one, before it reaches any party, and the first goes on', async () => {
    const w = world();
    // the command's fleet home holds fleet.json and the helper's lock, socket and events beside the world's
    const home = makeHome();
    fs.writeFileSync(path.join(home, 'fleet.json'), JSON.stringify({ id: real.fleetId, gatewayMachineId: real.TRIFT }));
    const registry = MachineRegistry.load(makeHome());
    registry.add({ name: 'trift', ssh: 'trift', platform: 'linux', arch: 'arm64', home: w.home, svallBase: path.join(w.home, '.local/share/svall'), gateway: true }, real.TRIFT);
    const tmpdir = makeHome();
    const cli = (connect: CliDeps['connect']) => {
      const out: string[] = [];
      const ctx: Ctx = {
        fleetHome: home, json: true,
        deps: {
          connect, registry: () => registry, stdin: new PassThrough(), stdout: { write: (x: string) => out.push(x) }, stderr: { write: () => true },
          signals: new EventEmitter(), launch: () => { throw new Error('no launcher in this test'); }, argv: () => [], tmpdir,
        },
      };
      return { ctx, result: () => out.join('').trim().split('\n').map((l) => JSON.parse(l) as { event: string; data: Outcome }).filter((e) => e.event === 'handover.result').at(-1)?.data };
    };
    const first = party(w, 'mac', 'start');
    const a = cli(() => transaction(w, first.c));
    const held = w.lifeOfController(first.c);
    const seconds: { label: string; job: string; code: number; reached: boolean; result?: Outcome }[] = [];
    w.gate = async ({ life, label }) => {
      if (life !== held || label.startsWith('link ')) return;
      for (const job of [{ kind: 'start', to: 'trift', choices: real.choices(w) }, { kind: 'resume' }, { kind: 'abort' }] as const) {
        let reached = false;
        const b = cli(() => { reached = true; throw new Error('the second run reached for the fleet'); });
        const { code } = await runHandover(job, b.ctx);
        seconds.push({ label, job: job.kind, code, reached, result: b.result() });
      }
    };
    expect(await runHandover({ kind: 'start', to: 'trift', choices: real.choices(w) }, a.ctx)).toEqual({ code: 0 });
    w.gate = undefined;
    expect(a.result()).toMatchObject({ status: 'complete' });
    expect(seconds).toHaveLength(3 * PROBED.move.labels.filter((l) => !l.startsWith('link ')).length);
    for (const s of seconds) {
      expect(s, `${s.job} at ${s.label}`).toMatchObject({ code: 1, reached: false, result: { status: 'interrupted', error: expect.stringContaining('already running here') } });
    }
    expect(w.violations).toEqual([]);
    expect(real.settledOn(w)).toBe('destination');
  });

  it('lets one of two processes racing for the lock take it, and tells the other it is held', async () => {
    const repo = path.join(import.meta.dirname, '../../../..');
    const script = path.join(makeHome(), 'take.mts');
    fs.writeFileSync(script, `import fs from 'node:fs';
import { helperPaths, takeLock } from ${JSON.stringify(path.join(repo, 'packages/cli/src/controller/helper.ts'))};
const [home, go] = process.argv.slice(2);
fs.writeFileSync(\`\${go}.\${process.pid}\`, '');
while (!fs.existsSync(go)) await new Promise((r) => setTimeout(r, 2));
try {
  const release = takeLock(helperPaths(home));
  process.stdout.write('took');
  await new Promise((r) => setTimeout(r, 500));
  release();
} catch (e) {
  process.stdout.write(e instanceof Error && e.name === 'Live' ? 'held' : \`failed: \${String(e)}\`);
}
`);
    for (let round = 0; round < 3; round++) {
      const home = makeHome();
      const go = path.join(home, 'go');
      const said = [0, 1].map(() => new Promise<string>((resolve) => {
        const child = spawn(path.join(repo, 'node_modules/.bin/tsx'), [script, home, go], { stdio: ['ignore', 'pipe', 'inherit'] });
        let out = '';
        child.stdout.on('data', (d: Buffer) => { out += d.toString(); });
        child.on('close', () => resolve(out));
      }));
      // both wait at the line before either may try
      while (fs.readdirSync(home).filter((f) => f.startsWith('go.')).length < 2) await new Promise((r) => setTimeout(r, 20));
      fs.writeFileSync(go, '');
      expect((await Promise.all(said)).sort(), `round ${round}`).toEqual(['held', 'took']);
      expect(fs.existsSync(helperPaths(home).lock)).toBe(false);
    }
  });
});

describe('a controller with no journal of its own', () => {
  const world = real.worlds();

  for (const at of ['gateway ready', 'gateway commit'] as const) {
    it(`on trift, resumes a handover whose controller died before ${at.split(' ')[1]} once the destination prepared, and takes it to the destination`, async () => {
      const w = world();
      await diesAt(w, at);
      expect(w.trift.current!.handover.journalState()).toMatchObject({ kind: 'open', journal: { phase: 'prepare' } });
      const out = await party(w, 'trift', 'resume').go();
      expect(out, w.trace.join(' | ')).toMatchObject({ status: 'complete' });
      await settleBoth(w, [out]);
    });
  }

  for (const edge of [undefined, 'before', 'after'] as const) {
    it(`here, resumes from the daemons' journals a handover whose own journal cannot be read${edge ? `, dying ${edge} it sets that journal aside` : ''}, once the destination prepared`, async () => {
      const w = world();
      await diesAt(w, 'gateway ready');
      fs.writeFileSync(path.join(w.ctlDir, 'handover.json'), '{"version":1,');
      if (edge) w.targets = [{ name: 'controller.journal', edge, nth: (w.hits.get(`controller.journal:${edge}`) ?? 0) + 1 }];
      const out = await party(w, 'mac', 'resume').go();
      if (edge) expect(w.struck).toHaveLength(1);
      else expect(out, w.trace.join(' | ')).toMatchObject({ status: 'complete' });
      const aside = () => fs.readdirSync(w.ctlDir).filter((f) => f.startsWith('handover.json.broken-'));
      expect(aside()).toHaveLength(edge === 'before' ? 0 : 1);
      await settleBoth(w, [out]);
      expect(aside()).toHaveLength(1);
    });
  }
});

// ---- what keeps a new request of the controller from going unstruck

describe('the requests the controller sends', () => {
  /** Each line of the controller's source that calls a daemon method or asks a gateway operation, with what it sends. */
  const sendable = (): Map<number, string> => {
    const lines = fs.readFileSync(path.join(import.meta.dirname, '../../src/controller/handover.ts'), 'utf8').split('\n');
    return new Map(lines.flatMap((l, i) => [...l.matchAll(/daemon\.call\('([\w.]+)'|gateway\.(\w+)\(/g)].map((m): [number, string] => [i + 1, m[1] ?? `gateway ${m[2]}`])));
  };

  it('are each struck, from every line that sends one, in one world or the other, and rsync over the link in the real one', () => {
    const struck = new Set([...Object.values(RAN).flatMap((r) => r.at.map((i) => r.sites[i])), ...Object.values(PROBED).flatMap((p) => p.at.map((i) => p.sites[i]))]);
    const sites = sendable();
    expect(sites.size).toBeGreaterThan(25);
    expect([...sites].filter(([line]) => !struck.has(line)).map(([line, what]) => `${what} (handover.ts:${line})`)).toEqual([]);
    const realOnes = Object.values(PROBED).flatMap((p) => p.at.map((i) => p.labels[i]));
    expect(realOnes).toEqual(expect.arrayContaining(['link rsync', 'link rsync --dry-run', 'link rsync --version']));
  });
});
