import { describe, expect, it, test } from 'vitest';
import { farRootId } from '@svall/protocol';
import type { MachineId } from '@svall/protocol';
import { awayLine, destinationName, elsewhere, homeName, isPlaced, machineOf, myMachine, robotMachine, rootAway, rootMachine, startsBeside, startsOn, unreachableOf, type Via, readsOn } from '../src/placement.js';
import { statusOf } from '../src/selectors.js';
import { chr } from './fixtures.js';

const VAULT = '4b7a3c1e-2d5f-4e6a-9b8c-0f1e2d3c4b5a' as MachineId;
const BOX = '7d8e9f0a-1b2c-4d3e-8f4a-5b6c7d8e9f0a' as MachineId;
const HOME = '0c1d2e3f-4a5b-4c6d-8e7f-9a0b1c2d3e4f' as MachineId;

test('a robot on a worker goes by the worker\'s name, or its id once the fleet no longer lists it; one here by none', () => {
  const f = { machines: { [VAULT]: { name: 'linus-vault', reachable: true, since: 0 } } };
  expect(machineOf(f, { machine: VAULT })).toBe('linus-vault');
  expect(machineOf({}, { machine: VAULT })).toBe(VAULT);
  expect(machineOf(f, {})).toBeUndefined();
});

test('through a worker, every robot not running there is away, whatever the stale fleet says of its link', () => {
  // the worker's copy of the fleet, with the home as its snapshot named it and a link it last saw down
  const f = { machines: {
    [HOME]: { name: 'mac', reachable: false, since: 0 },
    [VAULT]: { name: 'linus-vault', reachable: false, since: 0 },
    [BOX]: { name: 'box', reachable: true, since: 0 },
  } };
  const via = { machine: VAULT, home: HOME };
  expect(awayLine(f, { machine: VAULT }, via)).toBeUndefined();
  expect(awayLine(f, {}, via)).toBe('mac is asleep');
  // before the worker's copy names the home
  expect(awayLine({ machines: {} }, {}, via)).toBe('the Mac is asleep');
  expect(awayLine(f, { machine: BOX }, via)).toBe('box is not reachable');
  expect([elsewhere({ machine: VAULT }, via), elsewhere({}, via), elsewhere({ machine: BOX }, via), elsewhere({})]).toEqual([false, true, true, false]);
  const blocked = chr('c0', 'i', { x: 0, y: 0 }, { agent: { kind: 'claude', sessionId: 's', status: 'blocked', lastActivityAt: 0 } });
  expect(statusOf({ ...blocked, machine: VAULT }, f, via)).toBe('blocked');
  expect(statusOf(blocked, f, via)).toBe('unknown');
  // the Mac, holding the same links, reads them as they are
  expect(awayLine(f, { machine: VAULT })).toBe('linus-vault is not reachable');
  expect(awayLine(f, { machine: BOX })).toBeUndefined();
});

describe('a window on a worker', () => {
  const ME = 'mmmmmmmm-0000-4000-8000-000000000000' as MachineId;
  const HOME = 'hhhhhhhh-0000-4000-8000-000000000000' as MachineId;
  const W = 'wwwwwwww-0000-4000-8000-000000000000' as MachineId;
  const f = { machines: { [ME]: { name: 'mac', reachable: false, since: 0 }, [W]: { name: 'w1', reachable: true, since: 0 } } };
  const online: Via = { machine: ME, home: HOME, name: 'studio', online: true };
  const fallback: Via = { machine: ME, home: HOME, name: 'studio' };

  it('reads a robot on this machine as here, whether the machine is home or worker', () => {
    expect(isPlaced({ machine: ME }, online)).toBe(false);
    expect(isPlaced({ machine: undefined })).toBe(false);
    expect(isPlaced({ machine: undefined }, online)).toBe(true);
    expect(isPlaced({ machine: W })).toBe(true);
    expect(machineOf(f, { machine: ME }, online)).toBeUndefined();
    expect(machineOf(f, { machine: undefined }, online)).toBe('studio');
    expect(machineOf(f, { machine: W }, online)).toBe('w1');
    expect(machineOf(f, { machine: undefined })).toBeUndefined();
  });

  it('calls this machine this Mac and every other by name, the home with no record of itself too', () => {
    expect(destinationName(f, ME, online)).toBe('this Mac');
    expect(destinationName(f, HOME, online)).toBe('studio');
    expect(destinationName(f, W, online)).toBe('w1');
    expect(destinationName({}, ME)).toBe('this Mac');
  });

  it('following the home, reads each link as the home tells it, and a robot here as here though the home lost this Mac', () => {
    expect(unreachableOf(f, { machine: ME }, online)).toBeUndefined();
    expect(unreachableOf(f, { machine: undefined }, online)).toBeUndefined();
    expect(unreachableOf({ machines: { [W]: { name: 'w1', reachable: false, since: 0 } } }, { machine: W }, online)).toBe('w1');
    expect(unreachableOf(f, { machine: W }, online)).toBeUndefined();
  });

  it('standing in for the home, reads every robot but its own as out of reach, whatever its cached copy says', () => {
    expect(unreachableOf(f, { machine: ME }, fallback)).toBeUndefined();
    expect(unreachableOf(f, { machine: undefined }, fallback)).toBe('studio');
    expect(unreachableOf(f, { machine: W }, fallback)).toBe('w1');
    expect(awayLine(f, { machine: undefined }, fallback)).toBe('studio is not reachable');
    expect(awayLine(f, { machine: W }, fallback)).toBe('w1 is not reachable');
    expect(awayLine(f, { machine: ME }, fallback)).toBeUndefined();
  });

  it('reads files where they are: a robot here in place, and any other on its machine', () => {
    const robots = { here: { machine: ME }, home: { machine: undefined }, w: { machine: W } } as never;
    const fleet = { ...f, robots };
    expect(readsOn(fleet, 'here', online)).toBeUndefined();
    expect(readsOn(fleet, 'home', online)).toBe('studio');
    expect(readsOn(fleet, 'w', online)).toBe('w1');
    expect(readsOn(fleet, 'here', fallback)).toBeUndefined();
    expect(readsOn(fleet, 'home', fallback)).toBe('studio');
    expect(readsOn(fleet, 'nobody', online)).toBeUndefined();
    const clone = '4b7a3c1e-2d5f-4e6a-9b8c-0f1e2d3c4b5a' as MachineId;
    expect(readsOn({ ...fleet, machines: { [clone]: { name: 'w2', reachable: true, since: 0 } } }, farRootId(clone, '/srv/x'), online)).toBe('w2');
    // a window on the home
    expect(readsOn(fleet, 'home')).toBeUndefined();
    expect(readsOn(fleet, 'w')).toBe('w1');
  });

  it('names a home by the fleet, then by what the window was told, and a destination the same', () => {
    expect(homeName({ machines: { [HOME]: { name: 'renamed', reachable: true, since: 0 } } }, online)).toBe('renamed');
    expect(homeName({}, online)).toBe('studio');
    expect(destinationName({}, HOME, online)).toBe('studio');
    expect(machineOf({}, { machine: HOME }, online)).toBe('studio');
    expect(machineOf({ machines: { [HOME]: { name: 'renamed', reachable: true, since: 0 } } }, { machine: undefined }, online)).toBe('renamed');
  });

  it('following the home, a robot on the home by its id is never out of reach, and a worker in mismatch names the upgrade', () => {
    expect(unreachableOf({ machines: { [HOME]: { name: 'studio', reachable: false, since: 0 } } }, { machine: HOME }, online)).toBeUndefined();
    const odd = { machines: { [W]: { name: 'w1', reachable: false, since: 0, mismatch: true as const } } };
    expect(awayLine(odd, { machine: W }, online)).toBe('w1 runs a different build; upgrade it under Machines');
    expect(awayLine({ machines: { [W]: { name: 'w1', reachable: false, since: 0 } } }, { machine: W }, online)).toBe('w1 is not reachable');
  });

  it('leaves a phone as it was: its home a Mac that sleeps', () => {
    const phone: Via = { machine: W, home: HOME };
    expect(awayLine({ machines: { [HOME]: { name: 'ada-mac', reachable: true, since: 0 } } }, { machine: undefined }, phone)).toBe('ada-mac is asleep');
    expect(homeName({}, phone)).toBe('the Mac');
  });
});

describe('what a window reads as its own machine', () => {
  const f = { machines: { [VAULT]: { name: 'linus-vault', reachable: true, since: 0 } } };
  const far: Via = { machine: VAULT, home: HOME, name: 'studio', online: true };
  const apart: Via = { machine: VAULT, home: HOME, name: 'studio' };
  const shell = { machine: BOX };

  test('this window\'s machine is its daemon\'s word on a far home, and its shell\'s on any other', () => {
    expect(myMachine({ via: far, shell })).toBe(VAULT);
    expect(myMachine({ shell })).toBe(BOX);
    expect(myMachine({})).toBeUndefined();
  });

  test('a robot that names no machine runs on the home, which is this machine for a window with no other', () => {
    expect(robotMachine({}, { via: far, shell })).toBe(HOME);
    expect(robotMachine({}, { via: apart, shell })).toBe(HOME);
    expect(robotMachine({}, { shell })).toBe(BOX);
    expect(robotMachine({ machine: VAULT }, { via: far, shell })).toBe(VAULT);
    expect(robotMachine({ machine: VAULT }, { shell })).toBe(VAULT);
  });

  test('a shelf root is on the home while the window follows it, and on this machine while it stands in', () => {
    expect(rootMachine('r:/h/.claude', { via: far })).toBe(HOME);
    expect(rootMachine('r:/h/.claude', { via: apart })).toBe(VAULT);
    expect(rootMachine('r:/h/.claude', { shell })).toBe(BOX);
    expect(rootMachine(farRootId(BOX, '/h/app'), { via: far })).toBe(BOX);
  });

  test('a shelf root elsewhere goes by name, and one here by none', () => {
    expect(rootAway(f, 'r:/h/.claude', { via: far })).toBe('studio');
    expect(rootAway(f, 'r:/h/.claude', { via: apart })).toBeUndefined();
    expect(rootAway(f, 'r:/h/.claude', { shell })).toBeUndefined();
    expect(rootAway(f, 'r:/h/.claude', {})).toBeUndefined();
    expect(rootAway(f, farRootId(VAULT, '/h/app'), { via: far })).toBeUndefined();
    expect(rootAway(f, farRootId(VAULT, '/h/app'), { shell })).toBe('linus-vault');
    expect(rootAway(f, farRootId(VAULT, '/h/app'), {})).toBe('linus-vault');
  });

  test('a new robot starts on the home it follows, else on this machine, beside the robots there', () => {
    expect(startsOn(far)).toBe(HOME);
    expect(startsOn(apart)).toBe(VAULT);
    expect([startsBeside({}, far), startsBeside({ machine: HOME }, far), startsBeside({ machine: VAULT }, far)]).toEqual([true, true, false]);
    expect([startsBeside({}, apart), startsBeside({ machine: VAULT }, apart)]).toEqual([false, true]);
  });
});
