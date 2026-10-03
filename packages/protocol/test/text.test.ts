import { describe, expect, it } from 'vitest';
import { bareUrl, ellipsis, trimEnd } from '../src/index.js';

describe('ellipsis', () => {
  it('cuts to n characters, the last an ellipsis, and leaves a short text alone', () => {
    expect(ellipsis('abcdef', 4)).toBe('abc…');
    expect(ellipsis('abcd', 4)).toBe('abcd');
    expect(ellipsis('', 4)).toBe('');
  });
});

describe('trimEnd', () => {
  it('drops the run of the given characters at the end, and nothing inside', () => {
    expect(trimEnd('a/b///', '/')).toBe('a/b');
    expect(trimEnd('see https://x.test/1.).', '.,;:!?)')).toBe('see https://x.test/1');
    expect(trimEnd('///', '/')).toBe('');
    expect(trimEnd('abc', '/')).toBe('abc');
  });

  // a /\/*$/ over a long run that does not end the string backtracks from every slash: seconds on the event loop
  it('takes a long run that does not end the text in one pass', () => {
    const run = '/'.repeat(100_000);
    const started = performance.now();
    expect(bareUrl(`https://x.test/${run}a`)).toBe(`x.test/${run}a/`);
    expect(bareUrl(`https://x.test${run}`)).toBe('x.test/');
    expect(performance.now() - started).toBeLessThan(500);
  });
});
