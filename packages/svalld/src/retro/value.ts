import type { Category, Change, Effort, Finding, Value } from '@svall/protocol';
import type { Group } from './aggregate.js';

const MIN = 60_000;
/** What one occurrence costs, for the categories with a fixed cost; a review miss costs by severity, friction and errors by
 *  the minutes lost, and a repeated workflow by its steps. */
const IMPACT: Partial<Record<Category, number>> = { 'skill-redo': 3, correction: 2, 'rule-missed': 2, 'rule-conflict': 2, 'retyped-rule': 2, noise: 1 };
const CONFIDENCE = { holds: 1, partly: 0.6 } as const;
const BADGES = { High: 15, Med: 6 } as const;
const CAP = 3, REVIEW_MISS = 3;

const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;
const took = (ms: number): string => (ms >= 60 * MIN ? `~${Math.round(ms / (60 * MIN))}h` : `~${Math.round(ms / MIN)}m`);

/** A finding's value from the groups it cites: their occurrences counted once, the rate over the largest denominator, the
 *  category's impact and the verdict's confidence, with the strongest fact as its reason. */
export function valueOf(o: { category: Category; groups: Group[]; verdict: 'holds' | 'partly' }): Value {
  const n = new Set(o.groups.flatMap((g) => g.occ)).size;
  const hit = new Set(o.groups.flatMap((g) => g.hits)).size;
  const m = Math.max(0, ...o.groups.map((g) => g.of));
  const rate = m ? Math.min(1, hit / m) : 0;
  const elapsed = o.groups.reduce((x, g) => x + (g.elapsedMs ?? 0), 0);
  const misses = o.groups.filter((g) => g.kind === 'review-miss' && g.impact !== undefined);
  const impact = Math.round(100 * (
    o.category === 'review-miss' ? (misses.length ? misses.reduce((x, g) => x + g.impact! * g.n, 0) / misses.reduce((x, g) => x + g.n, 0) : REVIEW_MISS)
    : o.category === 'friction' || o.category === 'error' ? Math.min(CAP, 1 + (n ? elapsed / n / MIN : 0) / 10)
    : o.category === 'workflow' ? Math.min(CAP, 1 + (Math.max(2, ...o.groups.map((g) => g.steps ?? 2)) - 2) / 2)
    : IMPACT[o.category] ?? 1)) / 100;
  const confidence = CONFIDENCE[o.verdict];
  const score = n * impact * (1 + rate) * confidence;
  const lead = [...o.groups].sort((a, b) => b.n - a.n)[0];
  const time = elapsed >= MIN ? `, ${took(elapsed)} elapsed` : '';
  const reason = lead?.kind === 'review-miss' ? `${plural(n, 'confirmed miss', 'confirmed misses')} in ${hit} of ${m} reviewed PRs`
    : lead?.kind === 'error' ? `${plural(n, 'failure')} in ${plural(hit, 'session')}${time}`
    : lead?.unit === 'runs' ? `${hit} of ${m} runs`
    : `${hit} of ${m} sessions${time}`;
  return { badge: score >= BADGES.High ? 'High' : score >= BADGES.Med ? 'Med' : 'Low', score: Math.round(score * 10) / 10, n, m, impact, confidence, reason };
}

/** How much the change is to make, from what it is and where it lands; `kind` is the inventory's for a target that exists. */
export function effortOf(o: { change: Change; target: Finding['target']; kind?: 'skill' | 'rule' }): Effort {
  if (o.change.kind === 'command' || o.target?.class === 'agent-settings') return 'setting';
  if (o.kind === 'skill') return 'skill edit';
  if (o.kind === 'rule') return 'rule line';
  if (o.target?.path.endsWith('SKILL.md')) return 'new skill';
  return o.target?.path.endsWith('.md') ? 'rule line' : 'code change';
}
