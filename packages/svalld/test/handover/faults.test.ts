import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Blocker, Outcome } from '@svall/protocol';
import { writeDurable } from '../../src/handover/durable.js';
import { FAILPOINTS, armFailpoints, boundary, type Edge, type Failpoint } from '../../src/handover/failpoints.js';
import { Store } from '../../src/store.js';
import { cleanHomes, makeHome } from '../helpers.js';
import { G, MAC, TRIFT, World, als, choices, fleetId, play, settledOn, worlds, type Scenario, type Target } from './fault-world.js';

afterEach(cleanHomes);

const REPO = path.join(import.meta.dirname, '../../../..');
const NAMES = Object.keys(FAILPOINTS) as Failpoint[];

describe('the failpoint registry', () => {
  it('runs a step as it is while nothing arms it', async () => {
    expect(boundary('source.freeze.journal', () => 7)).toBe(7);
    await expect(boundary('source.freeze.surrender', async () => 8)).resolves.toBe(8);
  });

  it('calls the armed hook on both edges of a step, after a promise only once it fulfils, and tells it of a step that throws', async () => {
    const seen: string[] = [];
    const disarm = armFailpoints((name, edge) => { seen.push(`${name}:${edge}`); });
    try {
      boundary('source.freeze.journal', () => seen.push('step'));
      await boundary('source.freeze.surrender', async () => { seen.push('async step'); });
      await boundary('source.rest.kill', async () => { throw new Error('tmux went away'); }).catch(() => seen.push('refused'));
      expect(() => boundary('source.rest.stopped', () => { throw new Error('disk full'); })).toThrow('disk full');
    } finally {
      disarm();
    }
    boundary('source.freeze.digest', () => seen.push('disarmed'));
    expect(seen).toEqual([
      'source.freeze.journal:before', 'step', 'source.freeze.journal:after',
      'source.freeze.surrender:before', 'async step', 'source.freeze.surrender:after',
      'source.rest.kill:before', 'source.rest.kill:threw', 'refused',
      'source.rest.stopped:before', 'source.rest.stopped:threw', 'disarmed',
    ]);
  });

  it('stops a step at the edge where its hook throws', () => {
    const ran: Edge[] = [];
    const disarm = armFailpoints((_name, edge) => { if (edge === 'before') throw new Error('crashed'); });
    try {
      expect(() => boundary('source.freeze.journal', () => ran.push('after'))).toThrow('crashed');
    } finally {
      disarm();
    }
    expect(ran).toEqual([]);
  });

  it('cannot be armed in a release', () => {
    process.env.SVALL_RELEASE_ROOT = makeHome();
    try {
      expect(() => armFailpoints(() => {})).toThrow(/release/);
    } finally {
      delete process.env.SVALL_RELEASE_ROOT;
    }
  });

  it('names every failpoint where a step of the code runs it', () => {
    const sources = ['packages/svalld/src', 'packages/cli/src'].flatMap((dir) => (fs.readdirSync(path.join(REPO, dir), { recursive: true }) as string[])
      .filter((f) => f.endsWith('.ts') && !f.endsWith('failpoints.ts')).map((f) => fs.readFileSync(path.join(REPO, dir, f), 'utf8')));
    expect(NAMES.filter((name) => !sources.some((text) => text.includes(`'${name}'`)))).toEqual([]);
  });
});

/**
 * Where each step runs, and how many times: the scenario whose first run reaches it, the times it runs there, and a
 * crash that has to come first for the step to run at all, with what changes while that party is down. A failpoint
 * without an entry here does not typecheck.
 */
/** `resumes`: a crash there that is resumed has to finish the move, as a step that is idempotent does. */
type Reach = { scenario: Scenario; times: number; after?: Target; setup?: (w: World) => void; resumes?: true };
const REACH: Record<Failpoint, Reach> = {
  'source.freeze.journal': { scenario: 'move', times: 1 },
  'source.freeze.surrender': { scenario: 'move', times: 1 },
  'source.rest.terminated': { scenario: 'move', times: 1 },
  'source.rest.terminate': { scenario: 'move', times: 1 },
  'source.rest.forcekill': { scenario: 'move', times: 1 },
  'source.rest.stopped': { scenario: 'move', times: 1 },
  'source.rest.kill': { scenario: 'move', times: 5 },
  'source.rest.server.journal': { scenario: 'move', times: 1 },
  'source.rest.server.kill': { scenario: 'move', times: 1 },
  'source.freeze.export': { scenario: 'move', times: 1 },
  'source.freeze.manifest': { scenario: 'move', times: 1 },
  'source.freeze.digest': { scenario: 'move', times: 1 },
  // only a source that died between its journal and its surrender starts by surrendering
  'source.startup.surrender': { scenario: 'move', times: 0, after: { name: 'source.freeze.journal', edge: 'after', nth: 1 } },
  'source.abort.journal': { scenario: 'abort', times: 1 },
  'source.revive': { scenario: 'abort', times: 5 },
  'source.release.manifest': { scenario: 'abort', times: 1 },
  'source.release.journal': { scenario: 'abort', times: 1 },
  'source.release.unfreeze': { scenario: 'abort', times: 1 },
  'source.release.activate': { scenario: 'abort', times: 1 },
  'source.complete.seal': { scenario: 'move', times: 1 },
  'source.complete.install': { scenario: 'move', times: 1 },
  'source.complete.deactivate': { scenario: 'move', times: 1 },
  'source.complete.manifest': { scenario: 'move', times: 1 },
  'source.complete.journal': { scenario: 'move', times: 1 },
  'destination.claim.seal': { scenario: 'move', times: 1 },
  'destination.claim.root': { scenario: 'move', times: 7 },
  'destination.claim.archive': { scenario: 'move', times: 1 },
  'destination.verify.journal': { scenario: 'move', times: 1 },
  'destination.verify.landed': { scenario: 'move', times: 1 },
  'destination.verify.record': { scenario: 'move', times: 1 },
  'destination.prepare.seal': { scenario: 'move', times: 1 },
  'destination.prepare.delete': { scenario: 'move', times: 2, resumes: true },
  'destination.prepare.import': { scenario: 'move', times: 2, resumes: true },
  'destination.prepare.state': { scenario: 'move', times: 1, resumes: true },
  'destination.prepare.journal': { scenario: 'move', times: 1 },
  'destination.prepare.stage': { scenario: 'move', times: 1 },
  'destination.activate.install': { scenario: 'move', times: 1 },
  'destination.commit.journal': { scenario: 'move', times: 1 },
  'destination.promote.fleet': { scenario: 'move', times: 1 },
  'destination.promote.state': { scenario: 'move', times: 1 },
  'destination.activate.journal': { scenario: 'move', times: 1 },
  'destination.activate.fleet': { scenario: 'move', times: 1 },
  // only an activation retried over a window whose agent has since exited back to its shell closes a window first
  'destination.activate.kill': {
    scenario: 'move', times: 0, after: { name: 'destination.activate.open', edge: 'after', nth: 4 },
    setup: (w) => { for (const x of w.trift.windows.values()) if (x.name === 'c_di') delete x.job; },
  },
  'destination.activate.open': { scenario: 'move', times: 5 },
  'destination.activate.record': { scenario: 'move', times: 5 },
  'destination.complete.seal': { scenario: 'move', times: 1 },
  'destination.complete.clear': { scenario: 'move', times: 1 },
  'destination.complete.journal': { scenario: 'move', times: 1 },
  'destination.abort.stage': { scenario: 'cancel', times: 1 },
  'destination.abort.seal': { scenario: 'abort', times: 1 },
  'destination.abort.clear': { scenario: 'abort', times: 1 },
  'destination.abort.journal': { scenario: 'abort', times: 1 },
  'gateway.begin.write': { scenario: 'move', times: 1 },
  'gateway.ready.write': { scenario: 'move', times: 1 },
  'gateway.commit.write': { scenario: 'move', times: 1 },
  'gateway.abort.write': { scenario: 'abort', times: 1 },
  'gateway.complete.write': { scenario: 'move', times: 1 },
  'gateway.commit.respond': { scenario: 'move', times: 1 },
  'controller.journal': { scenario: 'move', times: 14 },
  'controller.manifest': { scenario: 'move', times: 1 },
  'controller.landed': { scenario: 'move', times: 1 },
  'controller.clear': { scenario: 'move', times: 1 },
  'controller.rsync': { scenario: 'move', times: 9 },
  'controller.verify': { scenario: 'move', times: 9 },
  'controller.commit': { scenario: 'move', times: 1 },
};

type Case = Target & Omit<Reach, 'times'>;

// every run of each step
const CASES: Case[] = NAMES.flatMap((name) => {
  const { times, ...reach } = REACH[name];
  return (['before', 'after'] as const).flatMap((edge) => Array.from({ length: Math.max(1, times) }, (_, i) => ({ name, edge, nth: i + 1, ...reach })));
});

const label = (k: Target): string => `${k.name}:${k.edge}#${k.nth}`;

describe('the guard on steps outside every failpoint', () => {
  const world = worlds();

  it('watches a party after one of its steps throws, and whatever it renames, links or removes under the homes', async () => {
    const w = world();
    w.controller();
    await w.run(async () => {
      await boundary('controller.commit', async () => { throw new Error('the gateway refused'); }).catch(() => {});
      writeDurable(path.join(w.ctlDir, 'stray.json'), {});
    });
    const stage = path.join(w.mac.paths.handoverDir, 'stage-x.json');
    als.run(w.mac.current!.life, () => {
      writeDurable(stage, {});
      fs.rmSync(stage);
    });
    expect(w.violations).toEqual([
      'rename of ctl/stray.json by the controller ran outside every failpoint',
      'rename of mac/handover/stage-x.json by the source ran outside every failpoint',
      'removal of mac/handover/stage-x.json by the source ran outside every failpoint',
    ]);
  });
});

describe('a crash at every failpoint', () => {
  const world = worlds();

  it('strikes both edges of every failpoint in the registry', () => {
    expect(new Set(CASES.map((k) => `${k.name}:${k.edge}`))).toEqual(new Set(NAMES.flatMap((n) => [`${n}:before`, `${n}:after`])));
  });

  for (const scenario of ['move', 'abort', 'cancel'] as const) {
    it(`reaches each step of the ${scenario} run as many times as its entry says, while nothing crashes`, async () => {
      const w = world();
      const out = await play(w, scenario);
      expect(out.status).toBe(scenario === 'move' ? 'complete' : 'aborted');
      expect(w.violations).toEqual([]);
      expect(settledOn(w)).toBe(scenario === 'move' ? 'destination' : 'source');
      const ran = (name: Failpoint) => w.hits.get(`${name}:before`) ?? 0;
      for (const name of NAMES.filter((n) => REACH[n].scenario === scenario)) expect(ran(name), name).toBe(REACH[name].times);
      for (const name of NAMES) expect(w.hits.get(`${name}:after`) ?? 0, name).toBe(ran(name));
    });
  }

  for (const k of CASES) {
    for (const [prefer, heal] of [['resume', 'crashed'], ['abort', 'all']] as const) {
      it(`${label(k)} (${k.scenario}), then ${prefer} after restarting ${heal === 'all' ? 'every party' : 'what died'}`, async () => {
        const w = world();
        w.targets = [...(k.after ? [k.after] : []), { name: k.name, edge: k.edge, nth: k.nth }];
        const first = await play(w, k.scenario);
        k.setup?.(w);
        await w.heal(heal);
        const said = await w.recover(prefer);
        const why = () => `${JSON.stringify(first)}\n${said.join(' ')}\n${w.violations.join('\n')}\n${w.trace.join(' | ')}`;
        expect(w.struck, why()).toEqual([...(k.after ? [label(k.after)] : []), label(k)]);
        expect(w.violations, why()).toEqual([]);
        let where: string;
        try { where = settledOn(w); } catch (e) { throw new Error(`${(e as Error).message}\n${why()}`); }
        if (w.everMoved || (k.resumes && prefer === 'resume')) expect(where, why()).toBe('destination');
      });
    }
  }
});

describe('a freeze asked again that refuses', () => {
  const world = worlds();

  it('leaves no manifest behind that a freeze before it wrote and did not live to answer', async () => {
    const w = world();
    w.targets = [{ name: 'source.freeze.manifest', edge: 'after', nth: 1 }];
    await play(w, 'move');
    // meanwhile the user keeps cy on the source, so the freeze asked again refuses
    Store.load(w.mac.paths.state, () => {}).update((d) => { d.characters.c_cy.keepHere = true; });
    const said = await w.recover('resume');
    expect(said, w.violations.join('\n')).toContain('resume->blocked');
    expect(w.violations).toEqual([]);
    expect(settledOn(w)).toBe('source');
  });
});

describe('a handover after a cancelled one', () => {
  const world = worlds();

  it("carries di's Claude with the flags the source revived it with", async () => {
    const w = world();
    expect(await play(w, 'cancel')).toMatchObject({ status: 'aborted' });
    expect(await play(w, 'move')).toMatchObject({ status: 'complete' });
    expect(w.violations).toEqual([]);
    expect(settledOn(w)).toBe('destination');
  });
});

describe('a source an editor saves into after the freeze', () => {
  const world = worlds();
  const ada = (w: World, file = '') => path.join(w.home, 'work/ada', file);
  // the transfer copies mission control's root first, then ada's, then bo's
  const saving = (w: World, also?: (nth: number) => void) => {
    w.onHit = (key) => {
      if (key !== 'controller.rsync:before') return;
      const nth = w.hits.get(key)!;
      if (nth === 2) fs.appendFileSync(ada(w, 'notes.md'), 'saved after the freeze\n');
      also?.(nth);
    };
  };
  const diverged = (name: string, shows = '') =>
    expect.objectContaining({ code: 'destination_diverged', message: expect.stringContaining(`/work/${name} changed while this machine did not own the fleet: ${shows}`) });
  // what ada's copy comes to hold after the transfer verified it, and how the claim asked again describes it
  type Change = [what: string, change: (w: World) => void, shows: string];
  const edit: Change = ['an edit', (w) => fs.appendFileSync(ada(w, 'notes.md'), 'edited since\n'), '1 changed (notes.md)'];

  /**
   * A transfer that verifies ada and stops on bo, which a watcher writes into before every copy; the user goes on, `change`
   * made meanwhile, and cancels at the next decision, then the handover is aborted. Returns each decision's blockers.
   */
  const goingOn = async (w: World, change?: (w: World) => void): Promise<Blocker[][]> => {
    const decided: Blocker[][] = [];
    let watching = false;
    saving(w, (nth) => { watching = nth === 3; });
    w.gate = async ({ label }) => { if (watching && label === 'link rsync') fs.appendFileSync(path.join(w.home, 'work/bo/index.ts'), '// again\n'); };
    w.decide = async (blockers) => {
      decided.push(blockers);
      if (decided.length > 1) return 'cancel';
      change?.(w);
      return choices(w);
    };
    const out = await play(w, 'move');
    [w.gate, w.decide] = [undefined, undefined];
    expect(out).toMatchObject({ status: 'blocked', phase: 'transfer' });
    expect(decided[0]).toEqual([expect.objectContaining({ code: 'external_writer', message: expect.stringContaining('/work/bo kept changing') })]);
    await w.recover('abort');
    expect(w.violations).toEqual([]);
    expect(settledOn(w)).toBe('source');
    return decided;
  };

  /** A controller that dies as the transfer reaches bo, once it verified ada; `change` is made, and the handover resumed, cancelling at any decision. */
  const resumed = async (w: World, change?: (w: World) => void): Promise<{ said: string[]; decided: Blocker[][] }> => {
    saving(w);
    w.targets = [{ name: 'controller.rsync', edge: 'before', nth: 3 }];
    await play(w, 'move');
    change?.(w);
    const decided: Blocker[][] = [];
    w.decide = async (blockers) => { decided.push(blockers); return 'cancel'; };
    const said = await w.recover('resume');
    w.decide = undefined;
    expect(w.violations, said.join(' ')).toEqual([]);
    return { said, decided };
  };

  it('takes again the copy of ada the transfer verified, and still refuses bo, whose copy no pass verified', async () => {
    const w = world();
    expect((await goingOn(w))[1]).toEqual([diverged('bo', '1 changed (index.ts)')]);
  });

  for (const [what, change, shows] of [edit, ['a removal', (w) => fs.rmSync(ada(w, 'notes.md')), '1 removed (notes.md)']] as Change[]) {
    it(`refuses ada again, for ${what} made in its copy after the transfer verified it, when the user goes on`, async () => {
      const w = world();
      const decided = await goingOn(w, change);
      expect(decided[1]).toHaveLength(2);
      expect(decided[1]).toEqual(expect.arrayContaining([diverged('ada', shows), diverged('bo')]));
    });
  }

  it('takes again the copy of ada the transfer verified when a controller that died during the transfer is resumed', async () => {
    const w = world();
    const { said, decided } = await resumed(w);
    expect(decided).toEqual([]);
    expect(settledOn(w), said.join(' ')).toBe('destination');
    expect(fs.readFileSync(ada(w, 'notes.md'), 'utf8')).toBe('ada\nsaved after the freeze\n');
  });

  for (const [what, change, shows] of [edit, ['an added file', (w) => fs.writeFileSync(ada(w, 'mine.txt'), 'mine\n'), '1 added (mine.txt)']] as Change[]) {
    it(`refuses ada again, for ${what} made in its copy after the transfer verified it, when a controller that died during the transfer is resumed`, async () => {
      const w = world();
      const held = () => fs.readdirSync(ada(w)).map((f) => [f, fs.readFileSync(ada(w, f), 'utf8')]);
      let before: string[][] = [];
      const { said, decided } = await resumed(w, (x) => { change(x); before = held(); });
      // the change is refused and kept
      expect(decided, said.join(' ')).toEqual([[diverged('ada', shows)]]);
      expect(settledOn(w)).toBe('source');
      expect(held()).toEqual(before);
    });
  }
});

describe('a destination that restarts between its activation and its complete', () => {
  const world = worlds();

  it('runs the fleet once the controller completes the handover there', async () => {
    const w = world();
    const c = w.controller();
    let restarted = false;
    w.gate = async ({ label }) => {
      if (label !== 'trift handover.complete' || restarted) return;
      restarted = true;
      w.trift.current!.life.dead = true;
      await w.boot(w.trift);
    };
    const out = await w.run(() => c.start(TRIFT, choices(w)));
    w.gate = undefined;
    expect(restarted).toBe(true);
    expect(out.status).toBe('complete');
    expect(w.violations).toEqual([]);
    expect(settledOn(w)).toBe('destination');
  });
});

/** What each party holds while the gateway is away: each daemon started again from its disk, and what status allows. */
async function whileAway(w: World): Promise<{ source: boolean; destination: boolean; safe: string[] }> {
  for (const m of [w.mac, w.trift]) {
    m.current!.life.dead = true;
    await w.boot(m);
  }
  const c = w.controller();
  const { verdict } = await w.run(() => c.status());
  // nothing a controller asks while the gateway cannot say who owns the fleet changes anything
  const before = [w.mac, w.trift].map((m) => fs.readFileSync(m.paths.owner, 'utf8'));
  for (const act of ['resume', 'abort'] as const) {
    const out = await w.run(() => (act === 'abort' ? c.abort() : c.resume()));
    if (verdict.standing !== 'none') expect(out.status, act).toBe('interrupted');
  }
  expect([w.mac, w.trift].map((m) => fs.readFileSync(m.paths.owner, 'utf8'))).toEqual(before);
  return { source: w.mac.can(), destination: w.trift.can(), safe: verdict.safe };
}

describe('the gateway lost', () => {
  const world = worlds();
  // where the gateway goes away, who may run the fleet until it comes back, and where each way on then takes it
  type Loss = { when: string; at?: string; first: Partial<Outcome>; source: boolean; destination: boolean; settles: Record<'resume' | 'abort', 'source' | 'destination'> };
  const losses: Loss[] = [
    { when: 'before Begin', first: { status: 'interrupted' }, source: true, destination: false, settles: { resume: 'source', abort: 'source' } },
    {
      when: 'during Freeze', at: 'source.freeze.surrender:after', first: { status: 'interrupted', phase: 'transfer' }, source: false, destination: false,
      settles: { resume: 'destination', abort: 'source' },
    },
    {
      when: 'after Ready', at: 'controller.commit:before', first: { status: 'interrupted', phase: 'commit' }, source: false, destination: false,
      settles: { resume: 'destination', abort: 'source' },
    },
    {
      when: 'after Commit', at: 'gateway.commit.respond:after', first: { status: 'interrupted', phase: 'activate' }, source: false, destination: false,
      settles: { resume: 'destination', abort: 'destination' },
    },
    {
      when: 'during Complete', at: 'destination.complete.journal:after', first: { status: 'complete', pending: ['source', 'gateway'] } as Partial<Outcome>,
      source: false, destination: true, settles: { resume: 'destination', abort: 'destination' },
    },
  ];

  for (const loss of losses) {
    for (const prefer of ['resume', 'abort'] as const) {
      it(`${loss.when} leaves the fleet on at most one machine until it returns, and then ${prefer} settles it`, async () => {
        const w = world();
        if (loss.at) w.onHit = (key) => { if (key === loss.at) { w.onHit = undefined; w.loseGateway(); } };
        else w.loseGateway();
        const c = w.controller();
        const first = await w.run(() => c.start(TRIFT, choices(w)));
        w.onHit = undefined;
        expect(first).toMatchObject(loss.first);
        const away = await whileAway(w);
        expect({ source: away.source, destination: away.destination }).toEqual({ source: loss.source, destination: loss.destination });
        expect(away.safe).toEqual([]);
        await w.startGateway();
        const said = await w.recover(prefer);
        const why = `${JSON.stringify(first)}\n${said.join(' ')}\n${w.violations.join('\n')}`;
        expect(w.violations, why).toEqual([]);
        expect(settledOn(w), why).toBe(loss.settles[prefer]);
      });
    }
  }
});

describe('a preflight of a Claude running in bypass mode', () => {
  const world = worlds();

  it("warns before anything moves that di's Claude will ask trift to accept the bypass mode it runs in, until trift's Claude has accepted it", async () => {
    const w = world();
    const di = [...w.mac.windows.values()].find((x) => x.name === 'c_di')!;
    const warned = async () => {
      const c = w.controller();
      return (await w.run(() => c.preflight(TRIFT, choices(w)))).warnings.filter((x) => x.code === 'claude_bypass').map((x) => x.entity?.id);
    };
    expect(await warned()).toEqual([]);
    di.job = ['claude --dangerously-skip-permissions'];
    expect(await warned()).toEqual(['c_di']);
    fs.writeFileSync(path.join(w.claudeHome, 'settings.json'), JSON.stringify({ skipDangerousModePermissionPrompt: true }));
    expect(await warned()).toEqual([]);
    expect(w.violations).toEqual([]);
  });
});

describe('a stale owner.json beside a surrendered journal', () => {
  const world = worlds();
  const surrendered = (w: World) => JSON.parse(fs.readFileSync(w.mac.paths.owner, 'utf8')) as { surrendered?: true };

  /** The source's owner.json rolled back to the record it held before it froze, as a restore from a backup would leave it. */
  const rollBack = (w: World) => fs.writeFileSync(w.mac.paths.owner, JSON.stringify({ fleetId, generation: G, ownerMachineId: MAC }));

  for (const where of ['with the gateway away', 'with the gateway answering'] as const) {
    it(`starts the source fenced ${where} while the destination runs the fleet, and the source never runs it again`, async () => {
      const w = world();
      // the destination activated and completed; the source died before it could complete
      w.targets = [{ name: 'source.complete.seal', edge: 'before', nth: 1 }];
      const c = w.controller();
      await w.run(() => c.start(TRIFT, choices(w)));
      expect(w.trift.can()).toBe(true);
      rollBack(w);
      if (where === 'with the gateway away') w.loseGateway();
      await w.boot(w.mac);
      expect(w.mac.can()).toBe(false);
      expect(w.mac.current!.ownership.writable()).toBe(false);
      expect(surrendered(w).surrendered).toBe(true);
      // and once more, now that the surrender is on disk
      w.mac.current!.life.dead = true;
      await w.boot(w.mac);
      expect(w.mac.can()).toBe(false);
      if (w.away) await w.startGateway();
      await w.recover('abort');
      expect(w.violations).toEqual([]);
      expect(settledOn(w)).toBe('destination');
    });

    it(`starts the source fenced ${where} when it died between its journal and its surrender`, async () => {
      const w = world();
      w.targets = [{ name: 'source.freeze.journal', edge: 'after', nth: 1 }];
      const c = w.controller();
      await w.run(() => c.start(TRIFT, choices(w)));
      expect(surrendered(w).surrendered).toBeUndefined();
      if (where === 'with the gateway away') w.loseGateway();
      await w.boot(w.mac);
      expect(w.mac.can()).toBe(false);
      expect(surrendered(w).surrendered).toBe(true);
      expect(w.mac.windows.size).toBe(5);
      if (w.away) await w.startGateway();
      await w.recover('resume');
      expect(w.violations).toEqual([]);
      expect(settledOn(w)).toBe('destination');
    });
  }
});
