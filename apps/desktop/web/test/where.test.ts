import { describe, expect, it } from 'vitest';
import { between, childOf, placeOf, resolve } from '../src/ide/where.js';

const ROOT = '/Users/ada/svall/.wt/auth';

describe('where', () => {
  it('makes a path as an agent prints it absolute', () => {
    expect(resolve('src/a.ts', `${ROOT}/pkg`, '/Users/ada')).toBe(`${ROOT}/pkg/src/a.ts`);
    expect(resolve('../b/./c.ts', `${ROOT}/pkg`, '/Users/ada')).toBe(`${ROOT}/b/c.ts`);
    expect(resolve('~/Desktop/run.log', ROOT, '/Users/ada')).toBe('/Users/ada/Desktop/run.log');
    expect(resolve('~', ROOT, '/Users/ada')).toBe('/Users/ada');
    expect(resolve('~/x', '/tmp', undefined)).toBe('~/x');
  });

  it('names a path under the root by its place there, and any other by its absolute path', () => {
    expect(placeOf(ROOT, ROOT)).toBe('');
    expect(placeOf(`${ROOT}/src/a.ts`, ROOT)).toBe('src/a.ts');
    expect(placeOf(`${ROOT}-old/a.ts`, ROOT)).toBe(`${ROOT}-old/a.ts`);
    expect(childOf('src', 'a.ts', ROOT)).toBe('src/a.ts');
    expect(childOf('/Users/ada/svall/.wt', 'auth', ROOT)).toBe('');
    expect(childOf('/', 'tmp', ROOT)).toBe('/tmp');
  });

  it('places a path under a root whichever side of /private the two are spelled on', () => {
    expect(placeOf('/tmp/x/a.ts', '/private/tmp/x')).toBe('a.ts');
    expect(placeOf('/private/tmp/x/a.ts', '/tmp/x')).toBe('a.ts');
    expect(placeOf('/tmp/x', '/private/tmp/x')).toBe('');
    expect(placeOf('/tmp/y/a.ts', '/private/tmp/x')).toBe('/tmp/y/a.ts');
  });

  it('lists the folders from a place up to the tree\'s top, the top left out', () => {
    expect(between('src/lib', '', ROOT)).toEqual(['src/lib', 'src']);
    expect(between('src', '/Users/ada/svall', ROOT)).toEqual(['src', '', '/Users/ada/svall/.wt']);
    expect(between('/Users/ada/Desktop', '', ROOT)).toEqual([]);
  });
});
