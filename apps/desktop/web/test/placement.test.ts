import { expect, test } from 'vitest';
import type { MachineId } from '@svall/protocol';
import { awayLine, elsewhere, machineOf } from '../src/placement.js';
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
  expect(awayLine(f, { machine: BOX }, via)).toBe('box is not reachable');
  expect([elsewhere({ machine: VAULT }, via), elsewhere({}, via), elsewhere({ machine: BOX }, via), elsewhere({})]).toEqual([false, true, true, false]);
  const blocked = chr('c0', 'i', { x: 0, y: 0 }, { agent: { kind: 'claude', sessionId: 's', status: 'blocked', lastActivityAt: 0 } });
  expect(statusOf({ ...blocked, machine: VAULT }, f, via)).toBe('blocked');
  expect(statusOf(blocked, f, via)).toBe('unknown');
  // the Mac, holding the same links, reads them as they are
  expect(awayLine(f, { machine: VAULT })).toBe('linus-vault is not reachable');
  expect(awayLine(f, { machine: BOX })).toBeUndefined();
});
