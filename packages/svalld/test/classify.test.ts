import { describe, expect, it } from 'vitest';
import { methods } from '@svall/protocol';
import { classification } from '../src/api/classify.js';

describe('classification', () => {
  it('classifies every method, and each as a read, a mutation or a terminal', () => {
    expect(Object.keys(classification).sort()).toEqual(Object.keys(methods).sort());
    expect(new Set(Object.values(classification))).toEqual(new Set(['read', 'mutation', 'terminal']));
  });
});
