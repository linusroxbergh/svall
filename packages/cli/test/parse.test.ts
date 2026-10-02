import { describe, expect, it } from 'vitest';
import { int, num, point, size } from '../src/commands/parse.js';

describe('int', () => {
  it('names the flag a value that is not a whole number came from', () => {
    expect(int('50', '--lines')).toBe(50);
    for (const bad of ['all', '', '1.5', '0x10', 'Infinity', '1e3']) expect(() => int(bad, '--lines')).toThrow(`bad --lines "${bad}", expected a whole number`);
  });

  it('keeps a value within its range', () => {
    const timeout = { min: 0, max: 2_000_000 };
    expect(int('0', '--timeout', timeout)).toBe(0);
    expect(() => int('-3', '--timeout', timeout)).toThrow('bad --timeout "-3", expected 0 to 2000000');
    expect(() => int('3000000', '--timeout', timeout)).toThrow('bad --timeout "3000000", expected 0 to 2000000');
    expect(() => int('0', '--lines', { min: 1 })).toThrow('bad --lines "0", expected at least 1');
  });
});

describe('num', () => {
  it('takes a ratio above 0', () => {
    expect(num('1.6', '--aspect')).toBe(1.6);
    expect(num('16', '--aspect')).toBe(16);
    for (const bad of ['16:9', '0', '-1', 'Infinity', '']) expect(() => num(bad, '--aspect')).toThrow(`bad --aspect "${bad}", expected a number above 0`);
  });
});

describe('point and size', () => {
  it('read x,y and w,h, and nothing for a flag left out', () => {
    expect(point('3,-4', '--cell')).toEqual({ x: 3, y: -4 });
    expect(size('7,5', '--size')).toEqual({ w: 7, h: 5 });
    expect(point(undefined, '--cell')).toBeUndefined();
    expect(() => size('7x5', '--size')).toThrow('bad --size "7x5", expected two integers like 3,4');
  });
});
