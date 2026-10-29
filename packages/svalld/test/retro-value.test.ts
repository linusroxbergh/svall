import { describe, expect, it } from 'vitest';
import type { Group } from '../src/retro/aggregate.js';
import { effortOf, valueOf } from '../src/retro/value.js';

const MIN = 60_000;
const group = (more: Partial<Group>): Group => ({
  id: 'g1', kind: 'correction', key: 'k', n: 0, hit: 0, of: 194, unit: 'sessions', occ: [], hits: [], sessions: [], prs: [], examples: [], last: 0, ...more,
});
const sessions = (...ids: string[]) => group({ n: ids.length, hit: ids.length, occ: ids, hits: ids, sessions: ids });

describe('valueOf', () => {
  it('scores n × impact × (1 + rate) × confidence, and badges at 15 and 6', () => {
    // 5 corrections at 2 each: 5 × 2 × (1 + 5/194) ≈ 10.3
    expect(valueOf({ category: 'correction', groups: [sessions('a', 'b', 'c', 'd', 'e')], verdict: 'holds' })).toEqual({
      badge: 'Med', score: 10.3, n: 5, m: 194, impact: 2, confidence: 1, reason: '5 of 194 sessions',
    });
    expect(valueOf({ category: 'correction', groups: [sessions('a', 'b', 'c', 'd', 'e')], verdict: 'partly' })).toMatchObject({ badge: 'Med', score: 6.2, confidence: 0.6 });
    // 3 × 2 × (1 + 3/6) = 9; at 4 sessions of 4, 4 × 2 × 2 = 16
    expect(valueOf({ category: 'retyped-rule', groups: [{ ...sessions('a', 'b', 'c'), of: 6 }], verdict: 'holds' }).badge).toBe('Med');
    expect(valueOf({ category: 'correction', groups: [{ ...sessions('a', 'b', 'c', 'd'), of: 4 }], verdict: 'holds' })).toMatchObject({ score: 16, badge: 'High' });
    expect(valueOf({ category: 'noise', groups: [sessions('a', 'b', 'c')], verdict: 'holds' }).badge).toBe('Low');
    // exactly 15 and exactly 6 are the higher badge: 3 × 2.5 × 2 = 15; 3 × 1 × 2 = 6
    const ups = (category: 'friction' | 'noise', elapsedMs?: number) => valueOf({ category, groups: [{ ...sessions('a', 'b', 'c'), of: 3, elapsedMs }], verdict: 'holds' });
    expect(ups('friction', 3 * 15 * MIN)).toMatchObject({ score: 15, badge: 'High' });
    expect(ups('noise')).toMatchObject({ score: 6, badge: 'Med' });
  });

  it('counts the union of the cited groups, so clustered groups add up and an overlap counts once', () => {
    const v = valueOf({ category: 'retyped-rule', groups: [sessions('a'), sessions('b'), sessions('c'), sessions('a', 'd')], verdict: 'holds' });
    expect([v.n, v.m, v.reason]).toEqual([4, 194, '4 of 194 sessions']);
  });

  it('weighs a confirmed review miss by its severity, and says it over the PRs reviewed', () => {
    const miss = group({ kind: 'review-miss', unit: 'prs', n: 7, hit: 5, of: 17, occ: ['1', '2', '3', '4', '5', '6', '7'], hits: ['p1', 'p2', 'p3', 'p4', 'p5'], impact: 4 });
    expect(valueOf({ category: 'review-miss', groups: [miss], verdict: 'holds' })).toEqual({
      badge: 'High', score: 36.2, n: 7, m: 17, impact: 4, confidence: 1, reason: '7 confirmed misses in 5 of 17 reviewed PRs',
    });
    // beside a group of sessions it cites, still over the PRs
    const big = { ...miss, n: 12, occ: Array.from({ length: 12 }, (_, i) => `m${i}`) };
    expect(valueOf({ category: 'review-miss', groups: [big, sessions('a', 'b')], verdict: 'holds' }).reason).toBe('12 confirmed misses in 5 of 17 reviewed PRs');
  });

  it('weighs friction and errors by the minutes each took, capped at 3, and says the failures and time', () => {
    const error = group({ kind: 'error', n: 41, hit: 12, of: 30, occ: Array.from({ length: 41 }, (_, i) => `f${i}`), hits: Array.from({ length: 12 }, (_, i) => `s${i}`), elapsedMs: 180 * MIN });
    expect(valueOf({ category: 'error', groups: [error], verdict: 'holds' })).toMatchObject({ impact: 1.44, reason: '41 failures in 12 sessions, ~3h elapsed' });
    expect(valueOf({ category: 'error', groups: [{ ...error, elapsedMs: 41 * 60 * MIN }], verdict: 'holds' }).impact).toBe(3);
    expect(valueOf({ category: 'friction', groups: [{ ...sessions('a', 'b'), elapsedMs: 40 * MIN }], verdict: 'holds' })).toMatchObject({ impact: 3, reason: '2 of 194 sessions, ~40m elapsed' });
  });

  it('weighs a repeated workflow by its steps, and a skill redo by its runs', () => {
    const seq = { ...sessions('a', 'b', 'c', 'd'), kind: 'sequence' as const, steps: 4 };
    expect(valueOf({ category: 'workflow', groups: [seq], verdict: 'holds' }).impact).toBe(2);
    expect(valueOf({ category: 'workflow', groups: [sessions('a', 'b')], verdict: 'holds' }).impact).toBe(1);
    const redo = group({ kind: 'skill-outcome', unit: 'runs', n: 7, hit: 7, of: 17, occ: ['1', '2', '3', '4', '5', '6', '7'], hits: ['1', '2', '3', '4', '5', '6', '7'] });
    expect(valueOf({ category: 'skill-redo', groups: [redo], verdict: 'holds' })).toMatchObject({ impact: 3, reason: '7 of 17 runs' });
  });
});

describe('effortOf', () => {
  const t = (p: string, cls: 'local' | 'agent-settings' = 'local') => ({ path: p, realPath: p, class: cls, hash: null });
  const change = (kind: 'diff' | 'draft' | 'proposal' | 'command') => ({ kind, summary: 's', text: 't' });

  it('names the effort from the change and where it lands', () => {
    expect(effortOf({ change: change('diff'), target: t('/s/SKILL.md'), kind: 'skill' })).toBe('skill edit');
    expect(effortOf({ change: change('draft'), target: t('/u/.claude/skills/x/SKILL.md') })).toBe('new skill');
    expect(effortOf({ change: change('diff'), target: t('/u/.claude/CLAUDE.md'), kind: 'rule' })).toBe('rule line');
    expect(effortOf({ change: change('draft'), target: t('/r/.claude/rules/reports.md') })).toBe('rule line');
    expect(effortOf({ change: change('proposal'), target: t('/u/.claude/settings.json', 'agent-settings') })).toBe('setting');
    expect(effortOf({ change: change('command'), target: null })).toBe('setting');
    expect(effortOf({ change: change('proposal'), target: null })).toBe('code change');
  });
});
