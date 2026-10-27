import { describe, expect, it } from 'vitest';
import { CHARS_PER_TOKEN, pack } from '../src/retro/pack.js';
import type { Excerpt } from '../src/retro/select.js';

const excerpt = (id: string, chars: number, priority: number): Excerpt => ({
  id, focus: 'skill-tweaks', priority, session: { agent: 'claude', session: id.split(':')[0] }, text: `L1 USER: ${'a'.repeat(chars)}`,
});

// 40 runs of about 3k tokens each, at mixed priorities, and one of about 30k
const excerpts = [...Array.from({ length: 40 }, (_, i) => excerpt(`s${i}:1`, 10_000 + i * 50, i % 3)), {
  ...excerpt('long:1', 0, 1), text: `HEAD${'m'.repeat(100_000)}TAIL`,
}];

describe('pack', () => {
  it('pack keeps every batch under 50k and cuts a long excerpt in the middle', () => {
    const batches = pack(excerpts);
    expect(batches.length).toBeGreaterThan(2);
    expect(batches.map((b) => b.id)).toEqual(batches.map((_, i) => `b${String(i + 1).padStart(2, '0')}`));
    for (const b of batches) expect(b.tokens).toBeLessThanOrEqual(50_000);
    // every excerpt once, none split
    expect(batches.flatMap((b) => b.excerpts.map((e) => e.id)).sort()).toEqual(excerpts.map((e) => e.id).sort());
    const long = batches.flatMap((b) => b.excerpts).find((e) => e.id === 'long:1')!;
    expect(long.text.startsWith('HEADmmm')).toBe(true);
    expect(long.text.endsWith('mmmTAIL')).toBe(true);
    expect(long.text).toContain('\n…[cut]…\n');
    expect(long.text.length).toBeLessThanOrEqual(4_000 * CHARS_PER_TOKEN);
    // the highest priority is read first
    expect(batches[0].excerpts[0].priority).toBe(2);
  });

  it('pack is deterministic', () => {
    const shuffled = [...excerpts].sort((a, b) => (a.id.length * 7 + a.text.length) % 13 - (b.id.length * 7 + b.text.length) % 13).reverse();
    expect(pack(shuffled)).toEqual(pack(excerpts));
  });
});
