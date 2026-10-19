import { describe, expect, it } from 'vitest';
import { coresText, memText } from '../src/loadText.js';

describe('loadText', () => {
  it('spells cpu as cores, with two decimals under one core', () => {
    expect(coresText(250.4)).toBe('2.5');
    expect(coresText(1240)).toBe('12.4');
    expect(coresText(45.2)).toBe('0.45');
    expect(coresText(0)).toBe('0.00');
    // rounding to two decimals can reach one core before the switch to one decimal does
    expect(coresText(99.6)).toBe('1.0');
  });

  it('spells memory in MB, or GB from 1 GB', () => {
    expect(memText(761 * 2 ** 20)).toBe('761 MB');
    expect(memText(1.36 * 2 ** 30)).toBe('1.4 GB');
    expect(memText(10 * 2 ** 20)).toBe('10 MB');
    expect(memText(1023.6 * 2 ** 20)).toBe('1.0 GB');
  });
});
