import { describe, expect, it } from 'vitest';
import type { FleetState } from '@svall/protocol';
import { charId, islandId } from '../src/commands/resolve.js';

const state = {
  characters: { c1: { id: 'c1', name: 'Bob' }, c2: { id: 'c2', name: 'ann' }, c3: { id: 'c3', name: 'ann' } },
  islands: { i1: { id: 'i1', name: 'Review' } },
} as unknown as FleetState;

describe('resolve', () => {
  it('takes an id as it stands, and a name in any case', () => {
    expect(charId(state, 'c1')).toBe('c1');
    expect(charId(state, 'bob')).toBe('c1');
    expect(islandId(state, 'review')).toBe('i1');
  });

  it('refuses an unknown ref, an ambiguous name and an inherited key', () => {
    expect(() => charId(state, 'nobody')).toThrow('no character "nobody"');
    expect(() => charId(state, 'ann')).toThrow(/c2 \(ann\), c3 \(ann\)/);
    expect(() => charId(state, 'toString')).toThrow('no character "toString"');
    expect(() => charId(state, 'constructor')).toThrow('no character "constructor"');
  });
});
