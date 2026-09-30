import { describe, expect, it } from 'vitest';
import { cardRect, halfCardBy } from '../src/map/card.js';

const win = { w: 1200, h: 800 };

describe('cardRect', () => {
  it('half card fills most of the map on first use, centred', () => {
    expect(cardRect({ size: 'half', win })).toEqual({ x: 60, y: 48, width: 1080, height: 704 });
  });
  it('full card is the whole map, edge to edge', () => {
    expect(cardRect({ size: 'full', win })).toEqual({ x: 0, y: 0, width: 1200, height: 800 });
  });
  it('a remembered half size is centred too, and an out-of-range one is clamped', () => {
    expect(cardRect({ size: 'half', win, half: { w: 0.75, h: 0.25 } })).toEqual({ x: 150, y: 300, width: 900, height: 200 });
    expect(cardRect({ size: 'half', win, half: { w: 4, h: 0 } })).toMatchObject({ width: 1176, height: 176 });
  });
});

describe('halfCardBy', () => {
  it('grows the card by twice the pointer travel, and not at all when it has not moved', () => {
    expect(halfCardBy({ w: 0.5, h: 0.5 }, { x: 0, y: 0 }, win)).toEqual({ w: 0.5, h: 0.5 });
    const half = halfCardBy({ w: 0.5, h: 0.5 }, { x: 60, y: 40 }, win);
    expect(half).toEqual({ w: 0.6, h: 0.6 });
    expect(cardRect({ size: 'half', win, half })).toMatchObject({ width: 720, height: 480 });
  });
  it('clamps a drag past the edges of the map', () => {
    expect(halfCardBy({ w: 0.5, h: 0.5 }, { x: 2400, y: -600 }, win)).toEqual({ w: 0.98, h: 0.22 });
  });
});
