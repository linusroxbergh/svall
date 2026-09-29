import { describe, expect, it } from 'vitest';
import { table } from '../src/format.js';

describe('table', () => {
  it('keeps a row on one line when a value carries newlines', () => {
    const out = table([{ name: 'bob', note: 'blocked on auth\n\nsee the PR' }, { name: 'ann', note: 'quiet' }]);
    expect(out.split('\n')).toHaveLength(3);
    expect(out).toContain('blocked on auth see the PR');
  });

  it('lines the columns up on the collapsed width', () => {
    const out = table([{ a: 'x\ny', b: 'end' }]);
    expect(out.split('\n')[1]).toBe('x y  end');
  });
});
