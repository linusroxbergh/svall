import { describe, expect, it } from 'vitest';
import { ISLET, homeRoom, placeIslet } from '../src/map/resources.js';
import { theme } from '../src/theme.js';

const HOME = 748;
const TOTAL = HOME + ISLET.gap + ISLET.w;

describe('placeIslet', () => {
  it('centres home and the islet as one group, a cell of water apart', () => {
    for (const hostW of [1440, 1120]) {
      const p = placeIslet(hostW, HOME, false);
      const left = (hostW - TOTAL) / 2;
      expect(p).toMatchObject({ mode: 'pair', scale: 1, homeScale: 1, homeShift: left + HOME / 2 - hostW / 2 });
      expect(p.cx - ISLET.w / 2).toBe(left + HOME + ISLET.gap);
      // the same water on both sides of the pair
      expect(hostW - (p.cx + ISLET.w / 2)).toBe(left);
    }
  });
  it('is only its pill when home is collapsed', () => {
    expect(placeIslet(1440, HOME, true)).toEqual({ mode: 'pill', homeShift: 0, cx: 720, scale: 1, homeScale: 1 });
  });
  it('keeps the islet on a map too narrow for the pair, clear of the edge and no smaller than 0.65', () => {
    for (const hostW of [1040, 900, 700, 500]) {
      const p = placeIslet(hostW, HOME, false);
      expect(p.mode).toBe('pair');
      expect(p.scale).toBeGreaterThanOrEqual(0.65);
      expect(p.cx + (ISLET.w * p.scale) / 2).toBeLessThanOrEqual(hostW);
    }
  });
  it('shrinks the islet first, then home, so the islet keeps 0.65 of its size', () => {
    // 484px of home leaves 194px for the islet at 700px: it shrinks, home does not
    expect(placeIslet(700, 484, false)).toMatchObject({ scale: 194 / ISLET.w, homeScale: 1 });
    for (const hostW of [860, 700]) {
      expect(placeIslet(hostW, HOME, false)).toMatchObject({ scale: 0.65, homeScale: (hostW - 2 * 8 - 6 - 0.65 * ISLET.w) / HOME });
    }
  });
  it('stands home and the islet apart and inside the map, down to a 700px map with a 748px home', () => {
    for (const homeW of [352, 484, 616, HOME]) {
      for (let hostW = 700; hostW <= 1400; hostW += 10) {
        const p = placeIslet(hostW, homeW, false);
        const homeRight = hostW / 2 + p.homeShift + (homeW * p.homeScale) / 2, isletW = ISLET.w * p.scale;
        expect(hostW / 2 + p.homeShift - (homeW * p.homeScale) / 2).toBeGreaterThanOrEqual(0);
        expect(homeRight).toBeLessThanOrEqual(p.cx - isletW / 2);
        expect(p.cx + isletW / 2).toBeLessThanOrEqual(hostW);
      }
    }
  });
  it('caps home at the scale the island cards stand at, and the islet with it down to 0.65', () => {
    const p = placeIslet(1440, HOME, false, 0.7);
    expect(p).toMatchObject({ homeScale: 0.7, scale: 0.7 });
    expect(placeIslet(1440, HOME, false, 0.5)).toMatchObject({ homeScale: 0.5, scale: 0.65 });
    // the smaller pair is centred as one group again
    const left = (1440 - (HOME * 0.7 + ISLET.gap + ISLET.w * 0.7)) / 2;
    expect(1440 / 2 + p.homeShift - (HOME * 0.7) / 2).toBeCloseTo(left, 6);
    // a cap over what the width allows changes nothing
    expect(placeIslet(900, HOME, false, 1)).toEqual(placeIslet(900, HOME, false));
  });
  it('gives up the water between the pair before the islet gives up size', () => {
    const edge = TOTAL + 2 * ISLET.margin;
    expect(placeIslet(edge, HOME, false).scale).toBe(1);
    expect(placeIslet(edge - 1, HOME, false).scale).toBe(1);
    expect(placeIslet(900, HOME, false).scale).toBeLessThan(1);
  });
});

describe('homeRoom', () => {
  it('is the widest home in cells that stands beside the islet unsqueezed, and none on a map too narrow', () => {
    // the water between home and the islet, the first thing a squeeze gives up
    const gap = (hostW: number, cells: number) => {
      const hw = cells * theme.cell, p = placeIslet(hostW, hw, false);
      return p.cx - (ISLET.w * p.scale) / 2 - (hostW / 2 + p.homeShift + (hw * p.homeScale) / 2);
    };
    for (const hostW of [1512, 991, 700]) {
      const cells = homeRoom(hostW);
      expect(placeIslet(hostW, cells * theme.cell, false)).toMatchObject({ scale: 1, homeScale: 1 });
      expect(gap(hostW, cells)).toBeCloseTo(ISLET.gap);
      expect(gap(hostW, cells + 1)).toBeLessThan(ISLET.gap);
    }
    expect(homeRoom(200)).toBe(0);
  });
});
