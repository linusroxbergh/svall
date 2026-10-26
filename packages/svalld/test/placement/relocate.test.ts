import { describe, expect, it } from 'vitest';
import { relocate, relocationProblem } from '../../src/placement/relocate.js';

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

  it('reads a path and the homes as the inventory does, with no .., // or trailing slash', () => {
    expect(relocate('/Users//ada/x/', TO_LINUX)).toBe('/home/ada/x');
    expect(relocate('/Users/ada/../shared/repo', TO_LINUX)).toBe('/Users/shared/repo');
    const slashed = { from: '/Users/ada/', to: '/home/ada/' };
    expect(relocate('/Users/ada/x', slashed)).toBe('/home/ada/x');
    expect(relocate('/home/ada/x', { from: slashed.to, to: slashed.from })).toBe('/Users/ada/x');
  });
});

describe('relocationProblem', () => {
  it('refuses a path in the destination\'s home outside the source\'s, which would land where one of the source\'s lands', () => {
    expect(relocationProblem('/home/ada/x', TO_LINUX)).toContain('/home/ada/x lies in the destination\'s home /home/ada but not in the source\'s home /Users/ada');
    expect(relocationProblem('/home/ada', TO_LINUX)).toBeDefined();
    expect(relocationProblem('/Users/ada/../../home/ada/x', TO_LINUX)).toBeDefined();
    expect(relocationProblem('/home/ada/x', { from: '/Users/ada', to: '/home/ada/' })).toBeDefined();
  });

  it('takes a path under this machine\'s home, one outside both homes, and any path between accounts with the same home', () => {
    expect(relocationProblem('/Users/ada/x', TO_LINUX)).toBeUndefined();
    expect(relocationProblem('/home/adam/x', TO_LINUX)).toBeUndefined();
    expect(relocationProblem('/srv/x', TO_LINUX)).toBeUndefined();
    expect(relocationProblem('/Users/ada/x', { from: '/Users/ada', to: '/Users/ada' })).toBeUndefined();
  });

  it('takes a path in a destination home nested in this machine\'s, which moves with the rest of it', () => {
    expect(relocationProblem('/Users/ada/linux/x', { from: '/Users/ada', to: '/Users/ada/linux' })).toBeUndefined();
  });
});
