import { describe, expect, it } from 'vitest';
import { PORTRAITS, randomPortrait } from '../src/portraits.js';

describe('portraits', () => {
  it('avoids taken portraits, and repeats once they run out', () => {
    const free = PORTRAITS[PORTRAITS.length - 1];
    expect(randomPortrait(new Set<string>(PORTRAITS.slice(0, -1)))).toBe(free);
    expect(PORTRAITS).toContain(randomPortrait(new Set(PORTRAITS)));
  });
});
