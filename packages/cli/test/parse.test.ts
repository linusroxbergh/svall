import { describe, expect, it } from 'vitest';
import { int } from '../src/commands/parse.js';

describe('int', () => {
  it('names the flag a value that is not a number came from', () => {
    expect(int('50', '--lines')).toBe(50);
    expect(() => int('all', '--lines')).toThrow('bad --lines "all", expected a number');
    expect(() => int('16:9', '--aspect')).toThrow('bad --aspect "16:9", expected a number');
  });
});
