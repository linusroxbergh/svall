import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, emptyState, type AdoptAnswer, type HomeFacts, type HomeMoving, type MachineId } from '@svall/protocol';
import { dispatch, type Ctx } from '../../src/api/methods.js';
import { configRewrites, homeCheck, HomeFreeze, type FreezeDeps } from '../../src/fleet/home-freeze.js';
import { phoneOwed, readMarker, writeMarker } from '../../src/fleet/home-move.js';
import { resolvePaths } from '../../src/paths.js';
import { hasGit } from '../git-fixture.js';
import { cleanHomes, makeHome } from '../helpers.js';
import { moveWorld, type MoveWorld } from '../placement/move-world.js';
import { H, W } from '../placement/world.js';
import { ID, MAC, marker, robot, STUDIO } from './home-world.js';

afterEach(cleanHomes);

function setup(o: { frozen?: boolean | HomeMoving; answers?: AdoptAnswer[]; barrier?: boolean | Promise<boolean>; serving?: boolean; flush?: boolean; phone?: Promise<{ serving: boolean; logins: string[] }>; link?: () => Promise<unknown> } = {}) {
  const paths = resolvePaths(makeHome());
  const log: string[] = [];
  const answers = o.answers ?? [];
  const d: FreezeDeps = {
    paths, me: MAC, log: { error: (l) => log.push(l), info: () => {} },
    store: { state: { ...emptyState(), robots: { placed: robot('placed', STUDIO) }, machines: { [STUDIO]: { name: 'studio', reachable: true, since: 1 } } }, flush: () => Promise.resolve(o.flush ?? true) },
    links: {
      barrier: () => Promise.resolve(o.barrier ?? true),
      hold: (on) => { log.push(`hold ${on}`); },
      call: (_m: MachineId, method: string) => { log.push(method); return (o.link?.() ?? Promise.resolve({})) as never; },
    },
    background: { pause: () => log.push('pause'), resume: () => log.push('resume') },
    phone: { get: () => o.phone ?? Promise.resolve({ serving: o.serving ?? false, logins: o.serving ? ['ada@tailnet'] : [] }), set: (on) => { log.push(`phone ${on}`); return Promise.resolve({}); } },
    ask: () => Promise.resolve(answers.shift() ?? { status: 'pending', phase: 'staged' }),
    restart: () => log.push('restart'),
  };
  const frozen = o.frozen === true ? marker() : o.frozen || undefined;
  if (frozen) writeMarker(paths, frozen);
  return { d, log, paths, freeze: new HomeFreeze(d, frozen) };
}

const holder = {};

describe('a frozen home', () => {
  it('refuses writes and a quit, and goes on with reads, terminals and answers to its robots', async () => {
    const { freeze } = setup();
    await freeze.freeze(ID, STUDIO, holder);
    for (const m of ['robot.update', 'island.create', 'robot.create', 'robot.moveTo', 'mobile.set', 'fleet.stop', 'machines.refresh', 'scribe.set'] as const) {
      expect(freeze.refusal(m)).toBeInstanceOf(ApiError);
      expect(freeze.refusal(m)?.code).toBe('frozen');
    }
    expect(freeze.refusal('robot.update')?.message).toBe('the fleet is moving to studio; try again once it has');
    for (const m of ['state.get', 'term.open', 'term.input', 'robot.answer', 'robot.read', 'fleet.homeMove'] as const) expect(freeze.refusal(m)).toBeUndefined();
  });

  it('a home not frozen refuses nothing', () => {
    expect(setup().freeze.refusal('robot.update')).toBeUndefined();
  });

  it('freezes the worker first, then lets what it sent drain, and holds only after, every flush answering true', async () => {
    const { freeze, log } = setup({ serving: true });
    expect(await freeze.freeze(ID, STUDIO, holder)).toEqual({ phone: { serving: true, logins: ['ada@tailnet'] } });
    expect(log).toEqual(['pause', 'home.freeze', 'hold true', 'phone false']);
  });

  it.each([
    ['a worker that does not drain', { barrier: false }, /catching up/],
    ['a flush that fails', { flush: false }, /state\.json/],
  ] as const)('%s thaws what it froze and says why', async (_what, o, said) => {
    const { freeze, log } = setup(o);
    await expect(freeze.freeze(ID, STUDIO, holder)).rejects.toThrow(said);
    expect(freeze.active).toBe(false);
    expect(log).toContain('resume');
  });

  it('a phone that cannot be read freezes nothing, as what served must not be taken for off', async () => {
    const { freeze, log } = setup({ phone: Promise.reject(new Error('no answer')) });
    await expect(freeze.freeze(ID, STUDIO, holder)).rejects.toThrow('no answer');
    expect(freeze.active).toBe(false);
    expect(log).toContain('resume');
  });

  it('a robot moving refuses, and nothing is frozen', async () => {
    const { freeze, d } = setup();
    d.store.state.robots.placed.moving = { id: 'mv_0123456789', to: STUDIO, phase: 'rest' } as never;
    await expect(freeze.freeze(ID, STUDIO, holder)).rejects.toThrow(/placed is moving/);
    expect(freeze.active).toBe(false);
  });

  it('thaws when its driver goes away before the marker, with the phone it served', async () => {
    const { freeze, log } = setup({ serving: true });
    await freeze.freeze(ID, STUDIO, holder);
    freeze.left({});
    expect(freeze.active).toBe(true);
    freeze.left(holder);
    await vi.waitFor(() => expect(log).toContain('phone true'));
    expect(freeze.active).toBe(false);
    expect(log).toEqual(expect.arrayContaining(['hold false', 'home.thaw', 'resume']));
  });

  it('stays frozen when its driver goes away after the marker', async () => {
    const { freeze, paths } = setup();
    await freeze.freeze(ID, STUDIO, holder);
    freeze.mark(marker());
    freeze.left(holder);
    expect(freeze.active).toBe(true);
    expect(readMarker(paths)?.id).toBe(ID);
    freeze.stop();
    await expect(freeze.thaw(ID)).rejects.toThrow(/only where the fleet is going/);
    expect(freeze.active).toBe(true);
  });

  it('refuses a mark from a freeze this daemon does not hold, as after a restart that took writes', () => {
    const { freeze, paths } = setup();
    expect(() => freeze.mark(marker())).toThrow(/not frozen/);
    expect(fs.existsSync(paths.homeMoving)).toBe(false);
  });

  it('thaws only on not-adopted, with the marker gone first', async () => {
    const { freeze, paths } = setup({ frozen: true, answers: [{ status: 'pending', phase: 'staged' }, { status: 'not-adopted' }] });
    await freeze.settle('status');
    freeze.stop();
    expect(freeze.active).toBe(true);
    expect(freeze.status().moving?.answer).toBe('staged');
    await freeze.settle('status');
    expect(freeze.active).toBe(false);
    expect(fs.existsSync(paths.homeMoving)).toBe(false);
  });

  it('on adopted writes the enrolment to the marker and ends the daemon, whose next start joins', async () => {
    const enrol = { worker: { homeMachineId: STUDIO, fleetId: '11111111-2222-3333-4444-555555555555', token: 'x'.repeat(48), homeName: 'studio' } } as never;
    const { freeze, paths, log } = setup({ frozen: true, answers: [{ status: 'adopted', enrol }] });
    await freeze.settle('status');
    expect(readMarker(paths)?.enrol).toBeDefined();
    expect(log).toContain('restart');
  });

  it('an unreachable machine leaves it frozen, saying why', async () => {
    const { freeze, d } = setup({ frozen: true });
    d.ask = () => Promise.reject(new Error('ssh: connect to host studio'));
    await freeze.settle('status');
    freeze.stop();
    expect(freeze.active).toBe(true);
    expect(freeze.status().moving?.answer).toMatch(/connect to host/);
  });

  it('a marker with no way to ask waits to be told, and only its outcome ends it', async () => {
    const { ask: _ask, ...withoutAsk } = marker();
    const { d, paths } = setup({ frozen: withoutAsk });
    const held = new HomeFreeze({ ...d, ask: () => { throw new Error('asked'); } }, withoutAsk);
    await held.settle('status');
    expect(held.active).toBe(true);
    expect(held.status().moving?.asks).toBe(false);
    await expect(held.thaw(ID)).rejects.toThrow(/only where the fleet is going/);
    expect(readMarker(paths)?.id).toBe(ID);
    await held.told(ID);
    expect(held.active).toBe(false);
    expect(readMarker(paths)).toBeUndefined();
  });

  it('a home that asks for itself takes no outcome from a call', async () => {
    const { freeze, paths } = setup({ frozen: true });
    await expect(freeze.told(ID)).rejects.toThrow(/told by no one/);
    freeze.stop();
    expect(readMarker(paths)?.id).toBe(ID);
  });

  it('refuses a freeze under a marker, its own id included, and a failure there leaves it', async () => {
    const { freeze, paths } = setup({ frozen: true, link: () => Promise.reject(new Error('no link')) });
    await expect(freeze.freeze(ID, STUDIO, holder)).rejects.toThrow(/already moving/);
    await expect(freeze.freeze('hm_otherother' as never, STUDIO, holder)).rejects.toThrow(/already moving/);
    freeze.stop();
    expect(readMarker(paths)?.id).toBe(ID);
    expect(freeze.active).toBe(true);
  });

  it('marks only a freeze that has ended, as only then is there a cut', async () => {
    let open!: (ok: boolean) => void;
    const { freeze, paths } = setup({ barrier: new Promise<boolean>((r) => { open = r; }) });
    const freezing = freeze.freeze(ID, STUDIO, holder);
    await vi.waitFor(() => expect(open).toBeDefined());
    expect(() => freeze.mark(marker())).toThrow(/not frozen/);
    open(true);
    await freezing;
    expect(fs.existsSync(paths.homeMoving)).toBe(false);
    freeze.mark(marker());
    freeze.stop();
    expect(readMarker(paths)?.id).toBe(ID);
  });

  describe('a driver gone while it freezes', () => {
    it('during the barrier: thawed, with no hold and the phone it served', async () => {
      let open!: (ok: boolean) => void;
      const barrier = new Promise<boolean>((r) => { open = r; });
      const { freeze, log, paths } = setup({ serving: true, barrier });
      const freezing = freeze.freeze(ID, STUDIO, holder);
      await vi.waitFor(() => expect(log).toContain('home.freeze'));
      freeze.left(holder);
      await vi.waitFor(() => expect(log).toContain('resume'));
      open(true);
      await expect(freezing).rejects.toThrow(/went away/);
      expect(freeze.active).toBe(false);
      expect(log).not.toContain('hold true');
      expect(log).not.toContain('phone false');
      expect(log.at(-1)).toBe('phone true');
      expect(fs.existsSync(paths.homeServed)).toBe(false);
    });

    it('while it reads the phone: no holder left dead, nothing frozen', async () => {
      let open!: (s: { serving: boolean; logins: string[] }) => void;
      const { freeze, log } = setup({ phone: new Promise((r) => { open = r; }) });
      const freezing = freeze.freeze(ID, STUDIO, holder);
      expect(freeze.refusal('robot.update')?.code).toBe('frozen');
      freeze.left(holder);
      await vi.waitFor(() => expect(log).toContain('resume'));
      open({ serving: false, logins: [] });
      await expect(freezing).rejects.toThrow(/went away/);
      expect(freeze.active).toBe(false);
      expect(freeze.refusal('robot.update')).toBeUndefined();
      expect(log).not.toContain('home.freeze');
    });

    it('while the worker is told: it stops there', async () => {
      let open!: (v: unknown) => void;
      const told = new Promise((r) => { open = r; });
      const { freeze, log } = setup({ link: () => told });
      const freezing = freeze.freeze(ID, STUDIO, holder);
      await vi.waitFor(() => expect(log).toContain('home.freeze'));
      freeze.left(holder);
      await vi.waitFor(() => expect(log).toContain('home.thaw'));
      open({});
      await expect(freezing).rejects.toThrow(/went away/);
      expect(log).not.toContain('hold true');
      expect(log).toContain('resume');
    });
  });

  describe('what the home had already taken', () => {
    it('a freeze waits for a call under way, and refuses new ones meanwhile, before its one flush', async () => {
      const { freeze, d, log } = setup();
      const flush = d.store.flush;
      d.store.flush = () => { log.push('flush'); return flush(); };
      const done = freeze.admit('robot.moveTo')!;
      const freezing = freeze.freeze(ID, STUDIO, holder);
      await new Promise((r) => setTimeout(r, 20));
      expect(log).not.toContain('flush');
      expect(log).not.toContain('home.freeze');
      expect(freeze.refusal('robot.update')?.code).toBe('frozen');
      // the move it was: the robot now reads as moving
      d.store.state.robots.placed.moving = { id: 'mv_0123456789', to: STUDIO, phase: 'rest' } as never;
      done();
      await expect(freezing).rejects.toThrow(/placed is moving/);
      expect(log).not.toContain('flush');
      expect(freeze.active).toBe(false);
    });

    it('a call that ended leaves nothing to wait on; a read, a terminal and a freeze itself are not counted', async () => {
      const { freeze, log } = setup();
      freeze.admit('robot.update')?.();
      for (const m of ['state.get', 'term.input', 'fleet.freeze', 'fleet.homeMove', 'robot.answer'] as const) expect(freeze.admit(m)).toBeUndefined();
      await freeze.freeze(ID, STUDIO, holder);
      expect(log).toContain('hold true');
    });

    it('a call that outlasts the drain thaws what it froze', async () => {
      vi.useFakeTimers();
      try {
        const { freeze } = setup();
        freeze.admit('scribe.sweep');
        const freezing = freeze.freeze(ID, STUDIO, holder).catch((e: Error) => e.message);
        await vi.advanceTimersByTimeAsync(31_000);
        expect(await freezing).toMatch(/still running/);
        expect(freeze.active).toBe(false);
      } finally { vi.useRealTimers(); }
    });
  });

  describe('a start', () => {
    it('under a marker holds still from the first: nothing running that only a home runs, the link held, and it asks', async () => {
      vi.useFakeTimers();
      try {
        const asked: string[] = [];
        const { d, log, paths } = setup({ frozen: true });
        const held = new HomeFreeze({ ...d, ask: (_m, op) => { asked.push(op); return Promise.resolve({ status: 'not-adopted' }); } }, marker());
        held.start();
        expect(log).toEqual(expect.arrayContaining(['pause', 'hold true']));
        await vi.advanceTimersByTimeAsync(5_100);
        expect(asked).toEqual(['status']);
        expect(held.active).toBe(false);
        expect(fs.existsSync(paths.homeMoving)).toBe(false);
        held.stop();
      } finally { vi.useRealTimers(); }
    });

    it('with no marker and no record of a served phone touches nothing', () => {
      const { freeze, log } = setup();
      freeze.start();
      expect(log).toEqual([]);
    });
  });

  describe('a phone link this home still owes from taking the fleet', () => {
    const owing = (paths: ReturnType<typeof resolvePaths>) => {
      fs.mkdirSync(paths.homeMoves, { recursive: true });
      fs.writeFileSync(path.join(paths.homeMoves, 'hm_earlierearl.ndjson'), `${JSON.stringify({ phase: 'adopted', at: 1, detail: 'serve' })}\n`);
    };

    it('goes with the next move as a link that served, and no tick here serves past the cut', async () => {
      const { freeze, paths, log } = setup();
      owing(paths);
      expect((await freeze.freeze(ID, STUDIO, holder)).phone.serving).toBe(true);
      expect(phoneOwed(paths)).toEqual([]);
      expect(log.at(-1)).toBe('phone false');
    });

    it('a freeze called off turns it on here, as it was owed', async () => {
      const { freeze, paths, log } = setup();
      owing(paths);
      await freeze.freeze(ID, STUDIO, holder);
      await freeze.thaw(ID);
      expect(log.at(-1)).toBe('phone true');
    });
  });

  describe('what served the phone', () => {
    it('is on the disk before the link goes off, and gone once a thaw has put it back', async () => {
      const { freeze, d, log, paths } = setup({ serving: true });
      const set = d.phone.set;
      d.phone.set = (on) => { log.push(`record ${fs.existsSync(paths.homeServed)}`); return set(on); };
      await freeze.freeze(ID, STUDIO, holder);
      expect(log.slice(-2)).toEqual(['record true', 'phone false']);
      await freeze.thaw(ID);
      expect(log.at(-1)).toBe('phone true');
      expect(fs.existsSync(paths.homeServed)).toBe(false);
    });

    it('a crash with the link off: the next start, unmarked, turns it back on', async () => {
      const { freeze, d, log, paths } = setup({ serving: true });
      await freeze.freeze(ID, STUDIO, holder);
      log.length = 0;
      const next = new HomeFreeze(d);
      next.start();
      await vi.waitFor(() => expect(log).toEqual(['phone true']));
      await vi.waitFor(() => expect(fs.existsSync(paths.homeServed)).toBe(false));
    });

    it('a crash past a marker\'s removal: the same', async () => {
      const { freeze, d, log, paths } = setup({ serving: true });
      await freeze.freeze(ID, STUDIO, holder);
      freeze.mark(marker());
      freeze.stop();
      // the marker went, the link has yet to come back
      fs.rmSync(paths.homeMoving);
      log.length = 0;
      new HomeFreeze(d).start();
      await vi.waitFor(() => expect(log).toEqual(['phone true']));
    });

    it('a start under a marker knows it, so its thaw puts it back', async () => {
      const { freeze, d, log, paths } = setup({ serving: true, answers: [{ status: 'not-adopted' }] });
      await freeze.freeze(ID, STUDIO, holder);
      freeze.mark(marker());
      freeze.stop();
      log.length = 0;
      const next = new HomeFreeze(d, marker());
      await next.settle('status');
      next.stop();
      expect(log).toContain('phone true');
      expect(fs.existsSync(paths.homeServed)).toBe(false);
    });

    it('a link that will not come back keeps the record for the next start', async () => {
      const { freeze, d, paths } = setup({ serving: true });
      await freeze.freeze(ID, STUDIO, holder);
      d.phone.set = () => Promise.reject(new Error('tailscale went away'));
      await freeze.thaw(ID);
      expect(fs.existsSync(paths.homeServed)).toBe(true);
    });
  });

  describe('a move this caller opened', () => {
    it('lets only that caller move mission control under its id, until it leaves', () => {
      const { freeze } = setup();
      expect(freeze.mayMoveCrew(ID, holder)).toBe(false);
      freeze.open(ID, holder);
      expect(freeze.mayMoveCrew(ID, holder)).toBe(true);
      expect(freeze.mayMoveCrew(ID, {})).toBe(false);
      expect(freeze.mayMoveCrew('hm_otherother', holder)).toBe(false);
      freeze.left(holder);
      expect(freeze.mayMoveCrew(ID, holder)).toBe(false);
    });

    it('opens none while the fleet is moving', async () => {
      const { freeze } = setup();
      await freeze.freeze(ID, STUDIO, holder);
      expect(() => freeze.open('hm_otherother' as never, {})).toThrow(/already moving/);
    });
  });
});

describe('a real move the API took as the freeze came', () => {
  const worlds: MoveWorld[] = [];
  afterEach(async () => { for (const w of worlds.splice(0)) await w.stop(); });

  it.skipIf(!hasGit)('lands before the cut, and nothing of it changes past the freeze\'s return', async () => {
    const w = moveWorld();
    worlds.push(w);
    const home = await w.start();
    const freeze = new HomeFreeze({
      paths: resolvePaths(w.base), me: H, log: { error: () => {}, info: () => {} }, store: { state: home.store.state, flush: () => home.store.flush() },
      links: { barrier: () => Promise.resolve(true), hold: () => {}, call: () => Promise.resolve({} as never) }, background: { pause: () => {}, resume: () => {} },
      phone: { get: () => Promise.resolve({ serving: false, logins: [] }), set: () => Promise.resolve({}) }, ask: () => Promise.resolve({ status: 'pending', phase: 'x' }), restart: () => {},
    });
    const moving = dispatch({ id: 1, method: 'robot.moveTo', params: { id: 'c_1', machine: W } }, { viewer: { kind: 'app', loopback: true }, placement: home.placement, freeze } as unknown as Ctx);
    expect(await dispatch({ id: 2, method: 'robot.update', params: { id: 'c_1', note: 'too soon' } }, { viewer: { kind: 'app', loopback: true }, freeze: { refusal: () => undefined, admit: () => undefined } } as unknown as Ctx)).toBeDefined();
    await freeze.freeze(ID, W, holder);
    const cut = home.store.state.robots.c_1.machine;
    expect(cut).toBe(W);
    expect(home.store.state.robots.c_1.moving).toBeUndefined();
    expect(await moving).toMatchObject({ result: {} });
    expect(home.store.state.robots.c_1.machine).toBe(cut);
  }, 60_000);
});

const facts = (o: Partial<HomeFacts>): HomeFacts => ({ machineId: MAC, role: 'home', release: '1', protocol: 44, stateSchema: 12, clock: 1000, freeKb: 1e7, home: '/Users/ada', svallBase: '/opt', fleetHome: '/x', tailscale: { host: 'h' }, ...o } as HomeFacts);

describe('the check', () => {
  const input = (o = {}) => ({ state: { ...emptyState(), robots: { here: robot('here'), placed: robot('placed', STUDIO) } }, from: facts({}), to: facts({ machineId: STUDIO, home: '/home/ada' as never }), toName: 'studio', linked: true, synced: true, workers: [STUDIO], rewrites: [], fromIsHome: true, ...o });

  it('passes a linked worker on this release, counting who stays where', () => {
    const r = homeCheck(input());
    expect(r.ok).toBe(true);
    expect(r.sheet).toMatchObject({ here: 1, there: 1, mission: [] });
  });

  it('refuses a second worker of either kind, by decision, naming how to bring it along', () => {
    const r = homeCheck(input({ workers: [STUDIO, '99999999-7777-8888-9999-aaaaaaaaaaaa'] }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.refusal.action).toMatch(/add it again from studio/);
  });

  it('lists every reason at once', () => {
    const r = homeCheck(input({ linked: false, to: facts({ machineId: STUDIO, release: '2', clock: 1e9, freeKb: 10, tailscale: { error: 'no tailscale' } }) }));
    if (r.ok) throw new Error('passed');
    expect([r.refusal.reason, ...(r.refusal.more ?? []).map((m) => m.reason)].join('\n')).toMatch(/not reachable[\s\S]*runs 2[\s\S]*clock[\s\S]*KB free[\s\S]*no Tailscale/);
  });

  it('names mission control\'s crew, which goes first', () => {
    const state = { ...emptyState(), islands: { home: { id: 'home', kind: 'home' } as never }, robots: { crew: { ...robot('crew'), islandId: 'home' }, here: robot('here') } };
    expect(homeCheck(input({ state })).sheet?.mission).toEqual([{ id: 'crew', name: 'crew' }]);
  });
});

it('rewrites what fleet.json names under the old home, and nothing else', () => {
  const paths = resolvePaths(makeHome());
  fs.writeFileSync(paths.fleetConfig, JSON.stringify({ id: '11111111-2222-3333-4444-555555555555', defaultCwd: '/Users/ada/code', home: { cwd: '/opt/crew' }, onboarding: { firstProject: '/Users/ada', scribe: true } }));
  expect(configRewrites(paths, '/Users/ada')).toEqual([{ key: 'defaultCwd', from: '/Users/ada/code', to: '~/code' }, { key: 'onboarding.firstProject', from: '/Users/ada', to: '~' }]);
});
