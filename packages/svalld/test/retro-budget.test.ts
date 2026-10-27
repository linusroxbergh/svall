import { describe, expect, it } from 'vitest';
import { FleetConfig } from '@svall/protocol';
import { NO_USAGE } from '../src/scribe/run.js';
import { Budget, estimate, presetsFor } from '../src/retro/budget.js';
import { priceOf } from '../src/retro/prices.js';

const retro = (o: object = {}) => FleetConfig.shape.retro.parse(o);
const batches = (n: number, tokens: number) => Array.from({ length: n }, () => ({ tokens }));

describe('Budget', () => {
  it("refuses a reservation the rest won't cover", () => {
    const b = new Budget(100_000);
    expect(b.reserve(60_000)).toBe(true);
    expect(b.reserve(50_000)).toBe(false);
    b.settle(60_000, { ...NO_USAGE, input: 30_000, output: 5_000 });
    expect(b.used).toBe(35_000);
    expect(b.reserve(50_000)).toBe(true);
  });

  it('settle reports how far real usage ran over', () => {
    const b = new Budget(10_000);
    expect(b.reserve(10_000)).toBe(true);
    // reasoning is already part of output
    b.settle(10_000, { ...NO_USAGE, input: 9_000, output: 3_000, reasoning: 2_000, cacheRead: 500 });
    expect(b.used - 10_000).toBe(2_500);
    expect(b.reserve(1)).toBe(false);
  });
});

describe('estimate', () => {
  // the spec's measured run: 18 batches, the plan's 0.84M tokens of excerpts, about $2.5 to read and $0.6 to judge
  it('balanced claude preset on 18 batches of 0.84M lands near 0.9M tokens', () => {
    const balanced = presetsFor('claude', retro()).find((p) => p.name === 'balanced')!;
    const p = estimate(batches(18, 46_667), balanced, 'claude');
    expect(p).toMatchObject({ name: 'balanced', label: 'Balanced — Sonnet reads, Opus judges', read: { agent: 'claude', model: 'sonnet' }, judge: { agent: 'claude', model: 'opus' } });
    expect(p.tokens.min).toBeLessThan(1_000_000);
    expect(p.tokens.max).toBeGreaterThan(1_000_000);
    expect(p.cost!.min).toBeLessThan(3.1);
    expect(p.cost!.max).toBeGreaterThan(3.1);
  });

  it('a model missing from the price table has no cost', () => {
    expect(priceOf('gpt-9')).toBeUndefined();
    expect(priceOf(undefined)).toBeUndefined();
    const p = estimate(batches(2, 10_000), { name: 'configured', label: 'Configured — gpt-9 reads, gpt-6-sol judges', read: 'gpt-9', judge: 'gpt-6-sol' }, 'codex');
    expect(p.tokens.min).toBeGreaterThan(0);
    expect(p.cost).toBeUndefined();
  });

  it("prices codex's own input at the cache-read rate", () => {
    const pick = { name: 'x', label: 'x', read: 'gpt-6-luna', judge: 'gpt-6-luna' };
    const none = estimate([], pick, 'codex');
    const luna = priceOf('gpt-6-luna')!;
    // no batches: the judge alone, its 30k–40k of CLI input at cacheRead, 40k of targets at input
    expect(none.cost!.min).toBeCloseTo((40_000 * luna.input + 30_000 * luna.cacheRead + 6_000 * luna.output) / 1e6, 9);
  });
});

describe('presetsFor', () => {
  it('puts a configured pair first and keeps balanced as the default model for a side left out', () => {
    const ps = presetsFor('claude', retro({ model: { claude: { judge: 'fable' } } }));
    expect(ps.map((p) => p.name)).toEqual(['configured', 'thrifty', 'balanced', 'thorough']);
    expect(ps[0]).toEqual({ name: 'configured', label: 'Configured — sonnet reads, fable judges', read: 'sonnet', judge: 'fable' });
  });

  it('opencode has one preset on its own model', () => {
    expect(presetsFor('opencode', retro())).toEqual([{ name: 'default', label: "Default — OpenCode's model reads and judges", read: undefined, judge: undefined }]);
  });
});
