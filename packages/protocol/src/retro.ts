import { z } from 'zod';
import { AgentKind, RetroStage } from './state.js';

/** What a retro finding is about, which sets what one occurrence of it costs. */
export const Category = z.enum(['review-miss', 'skill-redo', 'correction', 'rule-missed', 'rule-conflict', 'retyped-rule', 'friction', 'error', 'workflow', 'noise']);
export type Category = z.infer<typeof Category>;
/** The kinds of group code counts from the sessions, cards and PR labels. */
export const GroupKind = z.enum(['review-miss', 'skill-outcome', 'correction', 'retyped-rule', 'error', 'friction', 'ask', 'sequence']);
export type GroupKind = z.infer<typeof GroupKind>;
/** How much a change is to make. */
export const Effort = z.enum(['rule line', 'skill edit', 'new skill', 'setting', 'code change']);
export type Effort = z.infer<typeof Effort>;
/** A finding's priority as code computed it, shown as its parts: `n` occurrences, `m` the rate's denominator. */
export const Value = z.object({
  badge: z.enum(['High', 'Med', 'Low']), score: z.number(), n: z.number().int(), m: z.number().int(), impact: z.number(), confidence: z.number(), reason: z.string(),
});
export type Value = z.infer<typeof Value>;

/** Where an example comes from: a turn of an agent's session, or a comment on a pull request. */
export const Source = z.union([z.object({ agent: AgentKind, session: z.string(), at: z.string() }), z.object({ pr: z.string(), comment: z.string().optional() })]);
export type Source = z.infer<typeof Source>;

export const Rate = z.object({ count: z.number().int().nonnegative(), of: z.number().int().nonnegative() });
export type Rate = z.infer<typeof Rate>;

/** The groups a finding cites, which the next retro counts again over the time since its fix; none when no group counts it. */
export const Measure = z.object({ keys: z.array(z.object({ kind: GroupKind, key: z.string() })), before: Rate.nullable(), after: Rate.nullable() });
export type Measure = z.infer<typeof Measure>;

/** What a finding proposes: a unified diff of its target, a new file's text, words on where to change it, or a command. */
export const Change = z.object({ kind: z.enum(['diff', 'draft', 'proposal', 'command']), summary: z.string(), text: z.string() });
export type Change = z.infer<typeof Change>;

/** How a target's fix lands, by its real path: a PR in its repo, an apply on the user's OK, or a proposal only. */
export const TargetClass = z.enum(['repo', 'local', 'agent-settings', 'synced', 'svall']);
export type TargetClass = z.infer<typeof TargetClass>;

/** What the verifier said: of the claim, of the change, and for a rule whether it was in force. */
export const Verdict = z.object({
  claim: z.enum(['holds', 'partly']), change: z.enum(['ok', 'edited', 'extend']),
  rule: z.enum(['rule active', 'preference observed', 'rule newer than evidence']).optional(), reason: z.string(),
});
export type Verdict = z.infer<typeof Verdict>;

/** A finding as printed and kept: its id is the same for the same issue in every run. */
export const Finding = z.object({
  id: z.string(), category: Category, title: z.string(), problem: z.string(), fix: z.string(),
  evidence: z.array(z.object({ source: Source, when: z.number(), repo: z.string().optional(), quote: z.string().max(300) })),
  sessions: z.number().int().nonnegative(), prs: z.number().int().nonnegative(),
  change: Change,
  // the hash the file had when the verifier read it; a drafted file has none yet
  target: z.object({ id: z.string().optional(), path: z.string(), realPath: z.string(), class: TargetClass, hash: z.string().nullable() }).nullable(),
  value: Value, effort: Effort, verdict: Verdict,
  groups: z.array(z.object({ kind: GroupKind, key: z.string() })), kind: z.enum(['pattern', 'singleton']), measure: Measure,
});
export type Finding = z.infer<typeof Finding>;

export const LedgerStatus = z.enum(['open', 'fixed', 'dismissed', 'later']);
export type LedgerStatus = z.infer<typeof LedgerStatus>;
export const DismissReason = z.enum(['wrong', 'not-worth-it']);
export type DismissReason = z.infer<typeof DismissReason>;

/** What the ledger keeps of a finding across runs. */
export const LedgerEntry = z.object({
  id: z.string(), category: z.string(), title: z.string(), status: LedgerStatus,
  firstSeen: z.number(), lastSeen: z.number(), reason: DismissReason.optional(), fixedAt: z.number().optional(), measure: Measure.optional(),
});
export type LedgerEntry = z.infer<typeof LedgerEntry>;

export const Range = z.object({ min: z.number(), max: z.number() });
export type Range = z.infer<typeof Range>;

const Model = z.object({ agent: AgentKind, model: z.string().optional() });
/** A choice of models for the cards, the synthesis and the verify, with what the plan would take on them, `min` typical and
 *  `max` the cap; no cost without a price. */
export const Preset = z.object({ name: z.string(), label: z.string(), read: Model, judge: Model, verify: Model, tokens: Range, cost: Range.optional() });
export type Preset = z.infer<typeof Preset>;

/** How the runner's CLI pays: an API key is money, a subscription counts tokens toward its plan, a provider is OpenCode's own. */
export const Billing = z.enum(['api-key', 'subscription', 'provider']);
export type Billing = z.infer<typeof Billing>;

export const RetroSpan = z.enum(['last', '7d', '30d']);
export type RetroSpan = z.infer<typeof RetroSpan>;

/** A plan: what is in scope, what was left out and why, and the work frozen for its run. */
export const RetroPlan = z.object({
  version: z.literal(2), id: z.string(), created: z.number(),
  span: z.object({ from: z.number(), to: z.number(), label: z.string() }),
  scope: z.object({ exclude: z.object({ repos: z.array(z.string()), islands: z.array(z.string()) }), unrecorded: z.array(z.string()) }),
  counts: z.object({
    inScope: z.number().int(), excluded: z.number().int(), otherFleets: z.number().int(), remote: z.number().int(),
    // sessions no fleet recorded, by repo, and whether the user picked them
    unrecorded: z.array(z.object({ repo: z.string(), count: z.number().int(), picked: z.boolean() })),
    // how many sessions in scope lack each field their agent doesn't record
    missing: z.record(z.string(), z.number().int()),
  }),
  reviews: z.enum(['gh', 'no-gh']),
  agent: AgentKind, billing: Billing, presets: z.array(Preset),
  // the sessions and chunks to card, how many chunks the cache holds, the card calls, and the PRs and comments to label
  work: z.object({ sessions: z.number().int(), chunks: z.number().int(), cached: z.number().int(), calls: z.number().int(), prs: z.number().int(), comments: z.number().int() }),
  pricesChecked: z.string(),
});
export type RetroPlan = z.infer<typeof RetroPlan>;

export const RetroStatus = z.object({
  run: z.string(), stage: RetroStage, done: z.number().int(), total: z.number().int(), used: z.number().int().optional(), error: z.string().optional(),
});
export type RetroStatus = z.infer<typeof RetroStatus>;

const int = z.number().int();

/** A run's report: how the span went, what works, what reviews miss, what errors cost, the findings in the order they are
 *  numbered, and what the run read and spent. */
export const RetroReport = z.object({
  version: z.literal(2), run: z.string(), span: z.object({ from: z.number(), to: z.number(), label: z.string() }),
  preset: z.object({ read: z.string(), judge: z.string(), verify: z.string() }),
  overview: z.object({ text: z.string(), sessions: int, repos: int, activeMs: z.number(), mix: z.array(z.object({ repo: z.string(), kind: z.string(), sessions: int })) }),
  works: z.object({ text: z.string(), skills: z.array(z.object({ skill: z.string(), clean: int, runs: int })), wins: int }),
  reviews: z.object({
    prs: int, later: int, confirmed: int, unknown: int, missPrs: int,
    themes: z.array(z.object({ theme: z.string(), severity: z.string(), later: int, confirmed: int, unknown: int })),
  }),
  // the last run's fixes, measured since
  previous: z.array(Finding),
  findings: z.array(Finding), emerging: z.array(Finding), singletons: z.array(Finding), dropped: z.array(z.object({ title: z.string(), reason: z.string() })),
  errors: z.array(z.object({ key: z.string(), signature: z.string(), failures: int, sessions: int, of: int, elapsedMs: z.number(), expected: z.boolean() })),
  asks: z.array(z.object({ kind: z.enum(['ask', 'sequence', 'retyped-rule']), key: z.string(), sessions: int })),
  skills: z.array(z.object({ skill: z.string(), runs: int, went: z.record(z.string(), int) })),
  housekeeping: z.object({ unused: int, sources: z.array(z.object({ source: z.string(), skills: z.array(z.string()) })) }),
  coverage: z.object({
    sessions: z.array(z.object({
      session: z.string(), agent: AgentKind, repo: z.string().optional(), day: z.string(), status: z.enum(['carded', 'cached', 'failed']), reason: z.string().optional(), clipped: int,
    })),
    quality: z.number(), joins: z.object({ joined: int, failed: int, ambiguous: int, truncated: int }), cutGroups: int, unverified: int, belowGate: int,
  }),
  usage: z.object({ budget: z.number(), used: z.number(), byStage: z.object({ cards: z.number(), labels: z.number(), synthesis: z.number(), verify: z.number() }) }),
});
export type RetroReport = z.infer<typeof RetroReport>;
