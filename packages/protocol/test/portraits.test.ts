import { describe, expect, it } from 'vitest';
import { PORTRAITS, randomPortrait, stepPortrait } from '../src/portraits.js';

describe('portraits', () => {
  it('steps around the ring in both directions', () => {
    const last = PORTRAITS[PORTRAITS.length - 1];
    expect(stepPortrait(PORTRAITS[0], 1)).toBe(PORTRAITS[1]);
    expect(stepPortrait(PORTRAITS[0], -1)).toBe(last);
    expect(stepPortrait(last, 1)).toBe(PORTRAITS[0]);
  });

  it('avoids taken portraits, and repeats once they run out', () => {
    const free = PORTRAITS[PORTRAITS.length - 1];
    expect(randomPortrait(new Set<string>(PORTRAITS.slice(0, -1)))).toBe(free);
    expect(PORTRAITS).toContain(randomPortrait(new Set(PORTRAITS)));
  });
});
