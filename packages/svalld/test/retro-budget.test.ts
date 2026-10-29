import { describe, expect, it } from 'vitest';
import { FleetConfig } from '@svall/protocol';
import { NO_USAGE } from '../src/scribe/run.js';
import { Budget, callTokens, capOf, cardCall, estimate, labelCall, presetsFor, synthesisCall, verifyCalls, type Work } from '../src/retro/budget.js';
import { priceOf } from '../src/retro/prices.js';

const retro = (o: object = {}) => FleetConfig.shape.retro.parse(o);
const work = (cards: number, chars = 120_000): Work => ({
  cards: Array.from({ length: cards }, () => cardCall(chars, 3, 3)), labels: [labelCall(30_000, 20, 3)],
  synthesis: synthesisCall(60_000, 200, 3), verify: verifyCalls(),
});

describe('Budget', () => {
  it("refuses a reservation the rest won't cover", () => {
    const b = new Budget(100_000);
    expect(b.reserve(60_000)).toBe(true);
    expect(b.reserve(50_000)).toBe(false);
    b.settle(60_000, { ...NO_USAGE, input: 30_000, output: 5_000, cacheWrite: 1_000 });
    expect(b.used).toBe(36_000);
    expect(b.reserve(50_000)).toBe(true);
    expect(b.left).toBe(14_000);
  });

  it('settle reports how far real usage ran over', () => {
    const b = new Budget(10_000);
    expect(b.reserve(10_000)).toBe(true);
    // reasoning is already part of output
    b.settle(10_000, { ...NO_USAGE, input: 9_000, output: 3_000, reasoning: 2_000, cacheRead: 500 });
    expect(b.used - 10_000).toBe(2_500);
    expect(b.reserve(1)).toBe(false);
  });

  it('frees what a hold no longer needs', () => {
    const b = new Budget(100);
    b.reserve(80);
    expect(b.reserve(30)).toBe(false);
    b.release(20);
    expect(b.reserve(30)).toBe(true);
  });
});

describe('presetsFor', () => {
  it('reads cards, synthesizes and verifies with the models the spec names, per CLI', () => {
    const models = (agent: 'claude' | 'codex') => presetsFor(agent, retro()).map((p) => [p.name, p.read, p.judge, p.verify]);
    expect(models('claude')).toEqual([['thrifty', 'haiku', 'sonnet', 'sonnet'], ['balanced', 'haiku', 'opus', 'sonnet'], ['thorough', 'sonnet', 'opus', 'opus']]);
    expect(models('codex')).toEqual([
      ['thrifty', 'gpt-6-luna', 'gpt-6-sol', 'gpt-6-sol'], ['balanced', 'gpt-6-luna', 'gpt-6-astra', 'gpt-6-sol'], ['thorough', 'gpt-6-sol', 'gpt-6-astra', 'gpt-6-astra'],
    ]);
    expect(presetsFor('claude', retro())[1].label).toBe('Balanced — Haiku reads, Opus judges, Sonnet verifies');
    expect(presetsFor('opencode', retro())).toEqual([{ name: 'default', label: "Default — OpenCode's model reads, judges and verifies", read: undefined, judge: undefined, verify: undefined }]);
  });

  it("puts a configured preset first, a role it leaves out balanced's", () => {
    const ps = presetsFor('claude', retro({ model: { claude: { judge: 'fable', verify: 'opus' } } }));
    expect(ps.map((p) => p.name)).toEqual(['configured', 'thrifty', 'balanced', 'thorough']);
    expect(ps[0]).toEqual({ name: 'configured', label: 'Configured — haiku reads, fable judges, opus verifies', read: 'haiku', judge: 'fable', verify: 'opus' });
  });
});

describe('estimate', () => {
  it("is each call's input, the CLI's own and its output, the cap with 15% slack and a tenth for retries", () => {
    // 1,000 tokens in and 100–300 out on claude, whose CLI adds 1,000
    expect(callTokens({ input: { min: 1_000, max: 1_000 }, out: { min: 100, max: 300 } }, 'claude')).toEqual({ min: 2_100, max: 2_695 });
    expect(cardCall(30_000, 2, 3)).toEqual({ input: { min: 10_000, max: 10_000 }, out: { min: 1_500, max: 5_000 } });
    expect(labelCall(3_000, 4, 3)).toEqual({ input: { min: 1_000, max: 1_000 }, out: { min: 400, max: 3_200 } });
    // the strong model's input grows with the sessions up to its cap
    expect(synthesisCall(30_000, 10, 3).input).toEqual({ min: 13_000, max: 150_000 });
    expect(synthesisCall(30_000, 1_000, 3).input).toEqual({ min: 150_000, max: 150_000 });
    expect(verifyCalls()).toHaveLength(3);
  });

  it('sums every stage, typical below cap, and prices each role at its own model', () => {
    const [, balanced] = presetsFor('claude', retro());
    const p = estimate(work(35), balanced, 'claude');
    expect(p).toMatchObject({ name: 'balanced', read: { agent: 'claude', model: 'haiku' }, judge: { agent: 'claude', model: 'opus' }, verify: { agent: 'claude', model: 'sonnet' } });
    expect(p.tokens.min).toBeLessThan(p.tokens.max);
    const cap = capOf(work(35), 'claude');
    expect(p.tokens.max).toBe(cap.reserved + cap.reading);
    // 35 calls of 40k haiku tokens, one of opus and three of sonnet, near the spec's $1.20
    expect(p.cost!.min).toBeGreaterThan(0.6);
    expect(p.cost!.min).toBeLessThan(1.6);
    expect(p.cost!.max).toBeLessThan(4);
  });

  it('has no cost when a role has no price, and reserves synthesis and verify at their caps', () => {
    expect(priceOf('gpt-9')).toBeUndefined();
    const p = estimate(work(2), { name: 'x', label: 'x', read: 'gpt-6-luna', judge: 'gpt-9', verify: 'gpt-6-sol' }, 'codex');
    expect(p.tokens.min).toBeGreaterThan(0);
    expect(p.cost).toBeUndefined();
    const { reserved } = capOf(work(2), 'codex');
    expect(reserved).toBe(callTokens(synthesisCall(60_000, 200, 3), 'codex').max + 3 * callTokens(verifyCalls()[0], 'codex').max);
  });

  it('costs nothing with nothing to read', () => {
    const p = estimate({ cards: [], labels: [], synthesis: synthesisCall(0, 0, 3), verify: verifyCalls() }, presetsFor('claude', retro())[0], 'claude');
    expect(p.tokens).toEqual({ min: 0, max: 0 });
    expect(p.cost).toEqual({ min: 0, max: 0 });
  });
});
