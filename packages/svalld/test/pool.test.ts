import { describe, expect, it } from 'vitest';
import { pool } from '../src/pool.js';

const nap = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('pool', () => {
  it('answers in the order the items came, at most `width` in flight', async () => {
    let inFlight = 0;
    let most = 0;
    const out = await pool([30, 10, 20, 0, 5], 2, async (ms) => {
      most = Math.max(most, ++inFlight);
      await nap(ms);
      inFlight -= 1;
      return ms * 2;
    });
    expect(out).toEqual([60, 20, 40, 0, 10]);
    expect(most).toBe(2);
  });

  it('after one fails it starts no other item and rejects with that failure once those in flight have ended', async () => {
    const events: string[] = [];
    const run = pool([0, 1, 2, 3, 4, 5], 3, async (i) => {
      events.push(`start ${i}`);
      if (i === 0) throw new Error('item 0 failed');
      await nap(50);
      events.push(`end ${i}`);
    });
    await expect(run).rejects.toThrow('item 0 failed');
    expect(events.sort()).toEqual(['end 1', 'end 2', 'start 0', 'start 1', 'start 2']);
  });
});
