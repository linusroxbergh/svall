import fs from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, emptyState, type AdoptAnswer, type HomeFacts, type MachineId } from '@svall/protocol';
import { configRewrites, homeCheck, HomeFreeze, type FreezeDeps } from '../../src/fleet/home-freeze.js';
import { readMarker } from '../../src/fleet/home-move.js';
import { resolvePaths } from '../../src/paths.js';
import { cleanHomes, makeHome } from '../helpers.js';
import { ID, MAC, marker, robot, STUDIO } from './home-world.js';

afterEach(cleanHomes);

function setup(o: { frozen?: boolean; answers?: AdoptAnswer[]; barrier?: boolean; serving?: boolean; flush?: boolean } = {}) {
  const paths = resolvePaths(makeHome());
  const log: string[] = [];
  const answers = o.answers ?? [];
  const d: FreezeDeps = {
    paths, me: MAC, log: { error: (l) => log.push(l), info: () => {} },
    store: { state: { ...emptyState(), robots: { placed: robot('placed', STUDIO) }, machines: { [STUDIO]: { name: 'studio', reachable: true, since: 1 } } }, flush: () => Promise.resolve(o.flush ?? true) },
    links: {
      barrier: () => Promise.resolve(o.barrier ?? true),
      hold: (on) => { log.push(`hold ${on}`); },
      call: (_m: MachineId, method: string) => { log.push(method); return Promise.resolve({} as never); },
    },
    background: { pause: () => log.push('pause'), resume: () => log.push('resume') },
    phone: { get: () => Promise.resolve({ serving: o.serving ?? false, logins: o.serving ? ['ada@tailnet'] : [] }), set: (on) => { log.push(`phone ${on}`); return Promise.resolve({}); } },
    ask: () => Promise.resolve(answers.shift() ?? { status: 'pending', phase: 'staged' }),
    restart: () => log.push('restart'),
  };
  return { d, log, paths, freeze: new HomeFreeze(d, o.frozen ? marker() : undefined) };
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
    fs.writeFileSync(paths.homeMoving, JSON.stringify(marker()));
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

  it('a marker with no way to ask waits to be told', async () => {
    const { ask: _ask, ...withoutAsk } = marker();
    const { d } = setup();
    const held = new HomeFreeze({ ...d, ask: () => { throw new Error('asked'); } }, withoutAsk);
    await held.settle('status');
    expect(held.active).toBe(true);
    expect(held.status().moving?.asks).toBe(false);
    await held.thaw(ID);
    expect(held.active).toBe(false);
  });
});

const facts = (o: Partial<HomeFacts>): HomeFacts => ({ machineId: MAC, role: 'home', release: '1', protocol: 44, stateSchema: 12, clock: 1000, freeKb: 1e7, home: '/Users/ada', svallBase: '/opt', fleetHome: '/x', tailscale: { host: 'h' }, ...o } as HomeFacts);

describe('the check', () => {
  const input = (o = {}) => ({ state: { ...emptyState(), robots: { here: robot('here'), placed: robot('placed', STUDIO) } }, from: facts({}), to: facts({ machineId: STUDIO, home: '/home/ada' as never }), toName: 'studio', linked: true, synced: true, workers: [STUDIO], rewrites: [], serving: false, fromIsHome: true, ...o });

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
