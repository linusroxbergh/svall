import { afterEach, describe, expect, it } from 'vitest';
import { emptyState, type AdoptAnswer, type HomeFacts, type Result } from '@svall/protocol';
import { homeCheck, HomeFreeze } from '../../src/fleet/home-freeze.js';
import {  } from '../../src/fleet/home-move.js';
import { resolvePaths } from '../../src/paths.js';
import { cleanHomes, makeHome } from '../helpers.js';
import { MAC, marker, phoneAt, robot, STUDIO, putMarker } from './home-world.js';

afterEach(cleanHomes);

const facts = (o: Partial<HomeFacts>): HomeFacts => ({ machineId: MAC, release: '1', protocol: 44, stateSchema: 12, clock: 1000, freeKb: 1e7, fleetHome: '/x', tailscale: { host: 'h' }, ...o } as HomeFacts);
const blockers = (r: Result<'fleet.homeCheck'>): [string, string][] => (r.ok ? [] : [r.refusal, ...r.refusal.more ?? []].map((b) => [b.reason, b.action]));

describe('the check names each machine for what it is', () => {
  // the way back, asked on this machine: the fleet comes from studio, the home it leaves, to this machine, which goes by ada-mac
  const back = (o = {}) => homeCheck({
    state: { ...emptyState(), robots: { here: robot('here', STUDIO) } }, from: facts({ machineId: STUDIO, workers: [] }), to: facts({}), toName: 'ada-mac', back: 'studio',
    linked: true, synced: true, fromIsHome: true, ...o,
  });

  it('on the way back, a workers.json the home cannot read is studio\'s to fix', () => {
    const r = back({ from: facts({ machineId: STUDIO, fleetHome: '/home/ada/.svall' as never }) });
    expect(blockers(r)).toEqual([['studio cannot read which workers this fleet has', 'fix /home/ada/.svall/workers.json']]);
  });

  it('on the way back, what is the old home\'s it says of studio', () => {
    const r = back({ linked: false, from: facts({ machineId: STUDIO, release: '0.21', clock: 1e9, tailscale: { error: 'logged out' }, workers: [] }), to: facts({ release: '0.22' }) });
    expect(blockers(r)).toEqual([
      ['studio is not reachable', 'try again when it is awake'],
      ['studio runs 0.21, this machine 0.22', 'upgrade it under Machines'],
      ["studio's clock is off by more than 5 minutes", 'set its clock: ssh there, then sudo timedatectl set-ntp on'],
      ['studio has no Tailscale: logged out', 'install Tailscale there and sign in'],
    ]);
  });

  it('on the way back, what is this machine\'s it says of this machine, a worker besides included', () => {
    const r = back({ synced: false, from: facts({ machineId: STUDIO, workers: ['99999999-7777-8888-9999-aaaaaaaaaaaa'] }), to: facts({ freeKb: 10, moving: 'hm_abcdefghij', tailscale: { error: 'not running' } }) });
    expect(blockers(r)).toEqual([
      ['studio is still catching up', 'try again in a moment'],
      ['99999999-7777-8888-9999-aaaaaaaaaaaa is a worker of this fleet too', 'remove 99999999-7777-8888-9999-aaaaaaaaaaaa first, and add it again from this machine'],
      ['this machine has 0 MB free, and taking the fleet takes 100 MB', 'free some space here'],
      ['this machine is still taking a move (hm_abcdefghij)', 'finish or call off that move first'],
      ['this machine has no Tailscale: not running', 'install Tailscale and sign in'],
    ]);
  });

  it('on the way out, studio is where the fleet goes', () => {
    const r = homeCheck({
      state: emptyState(), from: facts({ release: '0.22', tailscale: { error: 'not running' }, workers: [STUDIO] }), to: facts({ machineId: STUDIO, release: '0.21', freeKb: 10, moving: 'hm_abcdefghij', tailscale: { error: 'logged out' } }), toName: 'studio',
      linked: false, synced: true, fromIsHome: true,
    });
    expect(blockers(r)).toEqual([
      ['studio is not reachable', 'try again when it is awake'],
      ['studio runs 0.21, this machine 0.22', 'upgrade it under Machines'],
      ['studio has 0 MB free, and taking the fleet takes 100 MB', 'free some space there'],
      ['studio is still leaving a move (hm_abcdefghij)', 'finish or call off that move first'],
      ['studio has no Tailscale: logged out', 'install Tailscale there and sign in'],
      ['this machine has no Tailscale: not running', 'install Tailscale and sign in'],
    ]);
  });
});

describe('a frozen home says where the machine holding the fleet stands, apart from what it said', () => {
  const frozen = (answer: () => Promise<AdoptAnswer>) => {
    const paths = resolvePaths(makeHome());
    putMarker(paths, marker());
    return new HomeFreeze({
      paths, me: MAC, log: { error: () => {}, info: () => {} }, store: { state: emptyState(), flush: () => Promise.resolve(true) },
      links: { barrier: () => Promise.resolve(true), hold: () => {} }, background: { pause: () => {}, resume: () => {} },
      phone: { get: () => Promise.resolve(phoneAt(false)), set: () => Promise.resolve(phoneAt(false)) }, ask: answer, restart: () => {},
    }, marker());
  };

  it.each([
    ['a phase', () => Promise.resolve<AdoptAnswer>({ status: 'pending', phase: 'rolledback', detail: 'the adopt was cut short' }), 'rolledback', 'the adopt was cut short'],
    ['no answer', () => Promise.reject(new Error('ssh: connect to host studio port 22: Connection refused')), 'unreachable', 'ssh: connect to host studio port 22: Connection refused'],
    ['the end of it', () => Promise.resolve<AdoptAnswer>({ status: 'done' }), 'done', 'done'],
  ])('%s', async (_what, answer, phase, said) => {
    const held = frozen(answer);
    await held.settle('status');
    held.stop();
    expect(held.status().moving).toMatchObject({ phase, answer: said });
  });
});
