import { describe, expect, it } from 'vitest';
import { cpuText, memText } from '../src/loadText.js';

describe('loadText', () => {
  it('spells cpu with one decimal under 10%', () => {
    expect(cpuText(14.04)).toBe('14%');
    expect(cpuText(3.21)).toBe('3.2%');
    expect(cpuText(0)).toBe('0.0%');
    expect(cpuText(250.4)).toBe('250%');
    // rounding to one decimal can reach 10 before the switch to whole numbers does
    expect(cpuText(9.96)).toBe('10.0%');
  });

  it('spells memory in MB, or GB from 1 GB', () => {
    expect(memText(761 * 2 ** 20)).toBe('761 MB');
    expect(memText(1.36 * 2 ** 30)).toBe('1.4 GB');
    expect(memText(10 * 2 ** 20)).toBe('10 MB');
    expect(memText(1023.6 * 2 ** 20)).toBe('1.0 GB');
  });
});
