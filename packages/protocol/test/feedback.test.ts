import { describe, expect, it } from 'vitest';
import { maskHome } from '../src/index.js';

describe('maskHome', () => {
  it('replaces every occurrence of the home, and only at a path boundary', () => {
    const t = '/Users/ann/x\nlog /Users/ann/.svall ok "/Users/ann"\n/Users/anna/y';
    expect(maskHome(t, '/Users/ann')).toBe('~/x\nlog ~/.svall ok "~"\n/Users/anna/y');
  });

  it('masks the home before punctuation, not inside a longer path or name', () => {
    expect(maskHome('cwd=/Users/ann, (/Users/ann) /Users/ann:', '/Users/ann')).toBe('cwd=~, (~) ~:');
    expect(maskHome('/x/Users/ann/y /Users/anna', '/Users/ann')).toBe('/x/Users/ann/y /Users/anna');
  });

  it('treats the home literally', () => {
    expect(maskHome('/Users/a.b/x /Users/aXb/x', '/Users/a.b')).toBe('~/x /Users/aXb/x');
  });

  it('ignores an empty or root home', () => {
    expect(maskHome('/a/b', '')).toBe('/a/b');
    expect(maskHome('/a/b', '/')).toBe('/a/b');
  });
});
