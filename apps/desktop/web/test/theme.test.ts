import { describe, expect, it } from 'vitest';
import { theme, tokenPx } from '../src/theme.js';

describe('theme', () => {
  it('measures the world in 44 px cells with three cells of drawing room', () => {
    expect(theme.cell).toBe(44);
    expect(theme.pad).toBe(3 * theme.cell);
  });
  it('has a continuous scale range', () => {
    expect(theme.scale.min).toBeLessThan(theme.scale.max);
  });
  it('reserves room above the footprint for the island label', () => {
    expect(theme.bounds.top * theme.cell).toBeGreaterThanOrEqual(tokenPx.h * 0.48);
  });
  it('holds a counter-scaled card inside the crew pitch at the zoom floor', () => {
    const w = tokenPx.w / theme.token.floor, h = tokenPx.h / theme.token.floor;
    expect(w).toBeLessThan(3 * theme.cell);
    expect(h).toBeLessThan(4 * theme.cell);
    // half a card, so a crew member two cells in from the coast stands on visible land
    expect(w / 2).toBeLessThan(2 * theme.cell);
  });
});
