import { describe, expect, it } from 'vitest';
import { resetAt, untilReset } from '../src/usageText.js';

describe('untilReset', () => {
  const now = Date.parse('2026-09-16T12:00:00Z');
  const at = (ms: number) => untilReset(new Date(now + ms).toISOString(), now);

  it('names the coarsest two units left', () => {
    expect(at(4 * 86_400_000 + 9 * 3_600_000)).toBe('4d 9h');
    expect(at(3_600_000 + 12 * 60_000)).toBe('1h 12m');
    expect(at(40 * 60_000)).toBe('40m');
    expect(at(40_000)).toBe('40s');
  });

  it('reads a window already past as due', () => {
    expect(at(0)).toBe('now');
    expect(at(-60_000)).toBe('now');
  });

  it('says nothing about a timestamp it cannot read', () => {
    expect(untilReset('whenever', now)).toBe('');
  });
});

describe('resetAt', () => {
  // the reading is of this machine's wall clock, so the test builds its instant the same way
  const local = (y: number, mo: number, d: number, h: number, mi: number) => new Date(y, mo, d, h, mi).toISOString();

  it('spells out the day, the date and the clock time', () => {
    expect(resetAt(local(2026, 8, 20, 23, 59))).toBe('Sun 20 Sep, 23:59');
    expect(resetAt(local(2026, 0, 5, 9, 5))).toBe('Mon 5 Jan, 09:05');
  });

  it('says nothing about a timestamp it cannot read', () => {
    expect(resetAt('whenever')).toBe('');
  });
});
