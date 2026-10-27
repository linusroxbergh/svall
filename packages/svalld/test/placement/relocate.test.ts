import { describe, expect, it } from 'vitest';
import { relocate } from '../../src/placement/relocate.js';

const TO_LINUX = { from: '/Users/ada', to: '/home/ada' };

describe('relocate', () => {
  it('moves the home and each path under it, on a component boundary, and leaves any other path where it is', () => {
    expect(relocate('/Users/ada', TO_LINUX)).toBe('/home/ada');
    expect(relocate('/Users/ada/code/app', TO_LINUX)).toBe('/home/ada/code/app');
    expect(relocate('/Users/adam/code', TO_LINUX)).toBe('/Users/adam/code');
    expect(relocate('/Volumes/work/repo', TO_LINUX)).toBe('/Volumes/work/repo');
    expect(relocate('~/code', TO_LINUX)).toBe('~/code');
  });

  it('comes back to the path it left from', () => {
    const back = { from: TO_LINUX.to, to: TO_LINUX.from };
    for (const p of ['/Users/ada', '/Users/ada/a b/ü', '/Volumes/work/repo', '/srv/x']) expect(relocate(relocate(p, TO_LINUX), back)).toBe(p);
  });

  it('reads a path and the homes as clean spells them, with no .., // or trailing slash', () => {
    expect(relocate('/Users//ada/x/', TO_LINUX)).toBe('/home/ada/x');
    expect(relocate('/Users/ada/../shared/repo', TO_LINUX)).toBe('/Users/shared/repo');
    const slashed = { from: '/Users/ada/', to: '/home/ada/' };
    expect(relocate('/Users/ada/x', slashed)).toBe('/home/ada/x');
    expect(relocate('/home/ada/x', { from: slashed.to, to: slashed.from })).toBe('/Users/ada/x');
  });
});
