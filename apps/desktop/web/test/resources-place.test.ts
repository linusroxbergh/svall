import { describe, expect, it } from 'vitest';
import { ISLET, placeIslet } from '../src/map/resources.js';

const HOME = 748;
const TOTAL = HOME + ISLET.gap + ISLET.w;

describe('placeIslet', () => {
  it('centres home and the islet as one group, a cell of water apart', () => {
    for (const hostW of [1440, 1120]) {
      const p = placeIslet(hostW, HOME, false);
      const left = (hostW - TOTAL) / 2;
      expect(p).toMatchObject({ mode: 'pair', scale: 1, homeShift: left + HOME / 2 - hostW / 2 });
      expect(p.cx - ISLET.w / 2).toBe(left + HOME + ISLET.gap);
      // the same water on both sides of the pair
      expect(hostW - (p.cx + ISLET.w / 2)).toBe(left);
    }
  });
  it('is only its pill when home is collapsed', () => {
    expect(placeIslet(1440, HOME, true)).toEqual({ mode: 'pill', homeShift: 0, cx: 720, scale: 1 });
  });
  it('keeps the islet on a map too narrow for the pair, clear of the edge', () => {
    for (const hostW of [1040, 900, 700, 500]) {
      const p = placeIslet(hostW, HOME, false);
      expect(p.mode).toBe('pair');
      expect(p.scale).toBeGreaterThanOrEqual(0.4);
      expect(p.cx + (ISLET.w * p.scale) / 2).toBeLessThanOrEqual(hostW);
    }
  });
  it('gives up the water between the pair before the islet gives up size', () => {
    const edge = TOTAL + 2 * ISLET.margin;
    expect(placeIslet(edge, HOME, false).scale).toBe(1);
    expect(placeIslet(edge - 1, HOME, false).scale).toBe(1);
    expect(placeIslet(900, HOME, false).scale).toBeLessThan(1);
  });
});
