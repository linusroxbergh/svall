import { describe, expect, it } from 'vitest';
import { coastPath, seedNum } from '../src/map/coast.js';
import { theme } from '../src/theme.js';

// every number in a coast path is printed with toFixed(2)
const nums = (d: string): number[] => (d.match(/-?\d+\.\d{2}/g) ?? []).map(Number);
const pairs = (d: string): [number, number][] => {
  const n = nums(d);
  const out: [number, number][] = [];
  for (let i = 0; i + 1 < n.length; i += 2) out.push([n[i], n[i + 1]]);
  return out;
};
// the M point plus the last coordinate pair of every C segment: the 96 sampled points
const anchors = (d: string): [number, number][] => {
  const out: [number, number][] = [];
  out.push(pairs(d.slice(1, d.indexOf('C')))[0]);
  for (const seg of d.slice(d.indexOf('C')).split('C').filter(Boolean)) {
    const p = pairs(seg);
    out.push(p[p.length - 1]);
  }
  return out;
};

describe('seedNum', () => {
  it('is deterministic and lands in [0, 1)', () => {
    expect(seedNum('i1')).toBe(seedNum('i1'));
    expect(seedNum('i1')).toBeGreaterThanOrEqual(0);
    expect(seedNum('i1')).toBeLessThan(1);
    expect(seedNum('i1')).not.toBe(seedNum('i2'));
  });
});

describe('coastPath', () => {
  const W = 10 * theme.cell, H = 7 * theme.cell;

  it('is deterministic for the same arguments', () => {
    expect(coastPath(W, H, '7', 0)).toBe(coastPath(W, H, '7', 0));
  });

  it('differs between seeds', () => {
    expect(coastPath(W, H, '7', 0)).not.toBe(coastPath(W, H, '8', 0));
  });

  it('is a closed path of 96 cubic segments', () => {
    const d = coastPath(W, H, '7', 0);
    expect(d.startsWith('M')).toBe(true);
    expect(d.endsWith('Z')).toBe(true);
    expect((d.match(/C/g) ?? []).length).toBe(96);
  });

  it('stays inside the padded box', () => {
    const d = coastPath(W, H, '7', 0);
    const maxX = W + 2 * theme.pad, maxY = H + 2 * theme.pad;
    for (const [x, y] of pairs(d)) {
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThanOrEqual(maxX);
      expect(y).toBeGreaterThanOrEqual(0);
      expect(y).toBeLessThanOrEqual(maxY);
    }
  });

  it('shrinks towards the centre when grow is negative', () => {
    const cx = (W + 2 * theme.pad) / 2, cy = (H + 2 * theme.pad) / 2;
    const outer = anchors(coastPath(W, H, '7', 0));
    const inner = anchors(coastPath(W, H, '7', -4));
    expect(inner.length).toBe(outer.length);
    const dist = ([x, y]: [number, number]) => Math.hypot(x - cx, y - cy);
    for (let i = 0; i < outer.length; i++) expect(dist(inner[i])).toBeLessThan(dist(outer[i]));
  });

  it('grow offsets the radius symmetrically', () => {
    const c = (g: number) => anchors(coastPath(W, H, '7', g));
    const [o, i] = [c(6), c(-6)];
    const cx = (W + 2 * theme.pad) / 2, cy = (H + 2 * theme.pad) / 2;
    const d = ([x, y]: [number, number]) => Math.hypot(x - cx, y - cy);
    for (let n = 0; n < o.length; n++) expect(d(o[n]) - d(c(0)[n])).toBeCloseTo(d(c(0)[n]) - d(i[n]), 1);
  });
});
