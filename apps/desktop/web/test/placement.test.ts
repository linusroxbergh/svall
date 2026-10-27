import { expect, test } from 'vitest';
import type { MachineId } from '@svall/protocol';
import { machineOf } from '../src/placement.js';

const VAULT = '4b7a3c1e-2d5f-4e6a-9b8c-0f1e2d3c4b5a' as MachineId;

test('a robot on a worker goes by the worker\'s name, or its id once the fleet no longer lists it; one here by none', () => {
  const f = { machines: { [VAULT]: { name: 'linus-vault', reachable: true, since: 0 } } };
  expect(machineOf(f, { machine: VAULT })).toBe('linus-vault');
  expect(machineOf({}, { machine: VAULT })).toBe(VAULT);
  expect(machineOf(f, {})).toBeUndefined();
});
