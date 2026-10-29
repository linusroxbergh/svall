import { describe, expect, it } from 'vitest';
import { maskHome } from '../src/index.js';

describe('maskHome', () => {
  it('replaces every occurrence of the home, and only at a path boundary', () => {
    const t = '/Users/ann/x\nlog /Users/ann/.svall ok "/Users/ann"\n/Users/anna/y';
    expect(maskHome(t, '/Users/ann')).toBe('~/x\nlog ~/.svall ok "~"\n/Users/anna/y');
  });

  it('ignores an empty or root home', () => {
    expect(maskHome('/a/b', '')).toBe('/a/b');
    expect(maskHome('/a/b', '/')).toBe('/a/b');
  });
});
