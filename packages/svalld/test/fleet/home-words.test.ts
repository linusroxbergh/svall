import { afterEach, describe, expect, it } from 'vitest';
import { emptyState, type AdoptAnswer, type HomeFacts, type Result } from '@svall/protocol';
import { homeCheck, HomeFreeze } from '../../src/fleet/home-freeze.js';
import { SshError } from '../../src/link/ssh.js';
import {  } from '../../src/fleet/home-move.js';
import { resolvePaths } from '../../src/paths.js';
import { cleanHomes, makeHome } from '../helpers.js';
import { MAC, marker, phoneAt, robot, STUDIO, putMarker } from './home-world.js';

afterEach(cleanHomes);

const facts = (o: Partial<HomeFacts>): HomeFacts => ({ machineId: MAC, release: '1', protocol: 44, stateSchema: 12, clock: 1000, freeKb: 1e7, fleetKb: 0, fleetHome: '/x', tailscale: { host: 'h' }, ...o } as HomeFacts);
const all = (r: Result<'fleet.homeCheck'>) => (r.ok ? [] : [r.refusal, ...r.refusal.more ?? []]);
const blockers = (r: Result<'fleet.homeCheck'>): [string, string][] => all(r).map((b) => [b.reason, b.action]);
// the command a terminal on the far machine types, and what a tool said, of each blocker that has either
const behind = (r: Result<'fleet.homeCheck'>) => all(r).flatMap((b) => (b.run || b.raw ? [[b.reason, b.run, b.raw]] : []));

describe('the check names each machine for what it is', () => {
  // the way back, asked on this machine: the fleet comes from studio, the home it leaves, to this machine, which goes by ada-mac
  const back = (o = {}) => homeCheck({
    state: { ...emptyState(), robots: { here: robot('here', STUDIO) } }, from: facts({ machineId: STUDIO, workers: [] }), to: facts({}), toName: 'ada-mac', back: 'studio',
    linked: true, synced: true, fromIsHome: true, ...o,
  });

  it('on the way back, a workers.json the home cannot read is studio\'s to fix', () => {
    const r = back({ from: facts({ machineId: STUDIO, fleetHome: '/home/ada/.svall' as never }) });
    expect(blockers(r)).toEqual([['studio cannot read which workers this fleet has', 'Fix /home/ada/.svall/workers.json']]);
  });

  it('on the way back, what is the old home\'s it says of studio', () => {
    const r = back({ linked: false, from: facts({ machineId: STUDIO, release: '0.21', clock: 1e9, tailscale: { state: 'signedOut', error: 'BackendState NeedsLogin' }, workers: [] }), to: facts({ release: '0.22' }) });
    expect(blockers(r)).toEqual([
      ['studio is not reachable', 'Try again when it is awake'],
      ['studio runs 0.21, this machine 0.22', 'Upgrade it under Machines'],
      ["studio's clock and this machine's are more than 5 minutes apart", 'Set the one that is wrong: on a server, ssh there, then sudo timedatectl set-ntp on'],
      ['Tailscale on studio is signed out', 'Sign in there: sudo tailscale up'],
    ]);
    expect(behind(r)).toEqual([
      ["studio's clock and this machine's are more than 5 minutes apart", 'sudo timedatectl set-ntp on', undefined],
      ['Tailscale on studio is signed out', 'sudo tailscale up', 'BackendState NeedsLogin'],
    ]);
    // a Mac sets its clock and signs in itself
    expect(behind(back({ linked: false, from: facts({ machineId: STUDIO, clock: 1e9, tailscale: { state: 'signedOut' }, workers: [] }), platformOf: () => 'darwin' }))).toEqual([]);
  });

  it('on the way back, what is this machine\'s it says of this machine, a worker besides included', () => {
    const r = back({ synced: false, from: facts({ machineId: STUDIO, workers: ['99999999-7777-8888-9999-aaaaaaaaaaaa'] }), to: facts({ freeKb: 10, moving: 'hm_abcdefghij', tailscale: { state: 'missing' } }), platformOf: (id: string) => (id === MAC ? 'linux' : undefined) });
    expect(blockers(r)).toEqual([
      ['studio is still catching up', 'Try again in a moment'],
      ['99999999-7777-8888-9999-aaaaaaaaaaaa is a worker of this fleet too', 'Remove 99999999-7777-8888-9999-aaaaaaaaaaaa first; add it again after the move'],
      ['This machine has 0 MB free, and taking the fleet takes 100 MB', 'Free some space here'],
      ['This machine is still taking a move', 'Finish or call off that move first'],
      ['This machine has no Tailscale', 'Install it from tailscale.com/download and sign in'],
    ]);
    expect(behind(r)).toEqual([]);
  });

  it('on the way out, studio is where the fleet goes', () => {
    const r = homeCheck({
      state: emptyState(), from: facts({ release: '0.22', tailscale: { state: 'missing' }, workers: [STUDIO] }), to: facts({ machineId: STUDIO, release: '0.21', freeKb: 10, moving: 'hm_abcdefghij', tailscale: { state: 'missing' } }), toName: 'studio',
      linked: false, synced: true, fromIsHome: true, platformOf: (id) => (id === MAC ? 'linux' : undefined),
    });
    expect(blockers(r)).toEqual([
      ['studio is not reachable', 'Try again when it is awake'],
      ['studio runs 0.21, this machine 0.22', 'Upgrade it under Machines'],
      ['studio has 0 MB free, and taking the fleet takes 100 MB', 'Free some space there'],
      ['studio is still leaving a move', 'Finish or call off that move first'],
      ['studio has no Tailscale', 'Install it there from tailscale.com/download and sign in'],
      ['This machine has no Tailscale', 'Install it from tailscale.com/download and sign in'],
    ]);
  });
});

describe('a frozen home says where the machine holding the fleet stands, apart from what it said', () => {
  const frozen = (answer: () => Promise<AdoptAnswer>) => {
    const paths = resolvePaths(makeHome());
    putMarker(paths, marker());
    return new HomeFreeze({
      paths, me: MAC, log: { error: () => {}, info: () => {} }, store: { state: emptyState(), flush: () => Promise.resolve(true) },
      links: { barrier: () => Promise.resolve(true), hold: () => {}, call: () => Promise.resolve({} as never) }, background: { pause: () => {}, resume: () => {} },
      phone: { get: () => Promise.resolve(phoneAt(false)), set: () => Promise.resolve(phoneAt(false)) }, ask: answer, restart: () => {},
    }, marker());
  };

  it.each([
    ['a phase', () => Promise.resolve<AdoptAnswer>({ status: 'pending', phase: 'rolledback', detail: 'the adopt was cut short' }), 'rolledback', 'the adopt was cut short'],
    ['no answer', () => Promise.reject(new Error('ssh: connect to host studio port 22: Connection refused')), 'unreachable', 'ssh: connect to host studio port 22: Connection refused'],
    ['no svall there', () => Promise.reject(new SshError('version', 'Svall on studio did not answer', 'svall connection-info exited 127: bash: svall: command not found')), 'unreachable',
      'Svall on studio did not answer: svall connection-info exited 127: bash: svall: command not found'],
    ['the end of it', () => Promise.resolve<AdoptAnswer>({ status: 'done' }), 'done', 'done'],
  ])('%s', async (_what, answer, phase, said) => {
    const held = frozen(answer);
    await held.settle('status');
    held.stop();
    expect(held.status().moving).toMatchObject({ phase, answer: said });
  });
});
