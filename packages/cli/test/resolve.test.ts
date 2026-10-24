import { describe, expect, it } from 'vitest';
import type { FleetState } from '@svall/protocol';
import { robotId, islandId } from '../src/commands/resolve.js';

const state = {
  robots: { c1: { id: 'c1', name: 'Bob' }, c2: { id: 'c2', name: 'ann' }, c3: { id: 'c3', name: 'ann' } },
  islands: { i1: { id: 'i1', name: 'Review' } },
} as unknown as FleetState;

describe('resolve', () => {
  it('takes an id as it stands, and a name in any case', () => {
    expect(robotId(state, 'c1')).toBe('c1');
    expect(robotId(state, 'bob')).toBe('c1');
    expect(islandId(state, 'review')).toBe('i1');
  });

  it('refuses an unknown ref, an ambiguous name and an inherited key', () => {
    expect(() => robotId(state, 'nobody')).toThrow('no robot "nobody"');
    expect(() => robotId(state, 'ann')).toThrow(/c2 \(ann\), c3 \(ann\)/);
    expect(() => robotId(state, 'toString')).toThrow('no robot "toString"');
    expect(() => robotId(state, 'constructor')).toThrow('no robot "constructor"');
  });
});
