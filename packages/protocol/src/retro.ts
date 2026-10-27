import { z } from 'zod';
import { AgentKind, RetroStage } from './state.js';

/** What a retro looks for: where a skill falls short or fails to fire, what reviews miss, what is still done by hand, which rules are missed. */
export const Focus = z.enum(['skill-tweaks', 'skill-triggers', 'review-tweaks', 'new-skills', 'instructions']);
export type Focus = z.infer<typeof Focus>;

/** The focus the user picks, and the focuses each one reads for. */
export const FocusPick = z.enum(['skills-reviews', 'new-skills', 'instructions', 'all']);
export type FocusPick = z.infer<typeof FocusPick>;
export const FOCUS_OF: Record<FocusPick, Focus[]> = {
  'skills-reviews': ['skill-tweaks', 'skill-triggers', 'review-tweaks'],
  'new-skills': ['new-skills'],
  instructions: ['instructions'],
  all: Focus.options,
};

/** The categories a reader or the judge may file a note or finding under, by focus. */
export const CATEGORIES = {
  'skill-tweaks': ['skipped-step', 'added-step', 'corrected-output', 'redone', 'wrong-order', 'unclear-step'],
  'skill-triggers': ['missed-trigger', 'false-trigger', 'unused-skill'],
  'review-tweaks': ['test-gap', 'missed-defect', 'over-report', 'dismissed-finding', 'noise'],
  'new-skills': ['repeated-workflow', 'retyped-instruction'],
  instructions: ['rule-missed', 'rule-conflict', 'rule-misplaced'],
} as const satisfies Record<Focus, readonly string[]>;

const inFocus = (v: { focus: Focus; category: string }): boolean => (CATEGORIES[v.focus] as readonly string[]).includes(v.category);
const CATEGORY_IN_FOCUS = { message: 'not a category of its focus', path: ['category'] };

/** Where a note or a quote comes from: a line of an agent's session, or a pull request. */
export const Source = z.union([z.object({ agent: AgentKind, session: z.string(), line: z.number().int() }), z.object({ pr: z.string() })]);
export type Source = z.infer<typeof Source>;

// the shapes a model answers in list every field, as null when it has none, since Codex's output schemas require them all;
// lengths are clipped in code rather than asked of the model

/** One thing a reader saw in a batch; `target` is the id of a skill or rule file from the inventory. */
export const Note = z.object({
  source: Source, focus: Focus, category: z.string(), target: z.string().nullable(), claim: z.string(), quote: z.string(),
}).refine(inFocus, CATEGORY_IN_FOCUS);
export type Note = z.infer<typeof Note>;
export const NoteReply = z.object({ notes: z.array(Note) });

export const Rate = z.object({ count: z.number().int().nonnegative(), of: z.number().int().nonnegative() });
export type Rate = z.infer<typeof Rate>;

/** The counts code can take from the sessions to tell whether a fix helped; `subject` names the skill. */
export const MeasureKind = z.enum(['followups-after-skill', 'runs-of-skill', 'later-comments-after-review', 'none']);
export type MeasureKind = z.infer<typeof MeasureKind>;
export const Measure = z.object({ kind: MeasureKind, subject: z.string().nullable(), name: z.string(), before: Rate.nullable(), after: Rate.nullable() });
export type Measure = z.infer<typeof Measure>;

/** What a finding proposes: a unified diff of its target, a new file's text, words on where to change it, or a command. */
export const Change = z.object({ kind: z.enum(['diff', 'draft', 'proposal', 'command']), summary: z.string(), text: z.string() });
export type Change = z.infer<typeof Change>;

/** How a target's fix lands, by its real path: a PR in its repo, an apply on the user's OK, or a proposal only. */
export const TargetClass = z.enum(['repo', 'local', 'agent-settings', 'synced', 'svall']);
export type TargetClass = z.infer<typeof TargetClass>;

/** One finding as the judge writes it: `target` is an inventory id, or where a drafted file would go; `subject` the skill or rule it names. */
export const JudgeFinding = z.object({
  focus: Focus, category: z.string(), title: z.string(), claim: z.string(),
  evidence: z.array(z.object({ source: Source, quote: z.string() })),
  change: Change, target: z.string().nullable(), subject: z.string(),
  measure: z.object({ kind: MeasureKind, subject: z.string().nullable(), name: z.string() }),
  rank: z.number().int(),
}).refine(inFocus, CATEGORY_IN_FOCUS);
export const JudgeReply = z.object({ findings: z.array(JudgeFinding) });

/** A finding as printed and kept: its id is the same for the same issue in every run. */
export const Finding = z.object({
  id: z.string(), focus: Focus, category: z.string(), title: z.string(), claim: z.string(),
  evidence: z.array(z.object({ source: Source, quote: z.string().max(300) })),
  sessions: z.number().int().nonnegative(), prs: z.number().int().nonnegative(),
  change: Change,
  // the hash the file had when the judge read it; a drafted file has none yet
  target: z.object({ id: z.string().optional(), path: z.string(), realPath: z.string(), class: TargetClass, hash: z.string().nullable() }).nullable(),
  measure: Measure, rank: z.number().int(),
});
export type Finding = z.infer<typeof Finding>;

export const LedgerStatus = z.enum(['open', 'fixed', 'dismissed', 'later']);
export type LedgerStatus = z.infer<typeof LedgerStatus>;
export const DismissReason = z.enum(['wrong', 'not-worth-it']);
export type DismissReason = z.infer<typeof DismissReason>;

/** What the ledger keeps of a finding across runs. */
export const LedgerEntry = z.object({
  id: z.string(), focus: Focus, category: z.string(), title: z.string(), status: LedgerStatus,
  firstSeen: z.number(), lastSeen: z.number(), reason: DismissReason.optional(), fixedAt: z.number().optional(), measure: Measure.optional(),
});
export type LedgerEntry = z.infer<typeof LedgerEntry>;

export const Range = z.object({ min: z.number(), max: z.number() });
export type Range = z.infer<typeof Range>;

/** A choice of models for the reads and the judge, with what the plan's batches would take on them; no cost without a price. */
export const Preset = z.object({
  name: z.string(), label: z.string(),
  read: z.object({ agent: AgentKind, model: z.string().optional() }), judge: z.object({ agent: AgentKind, model: z.string().optional() }),
  tokens: Range, cost: Range.optional(),
});
export type Preset = z.infer<typeof Preset>;

/** How the runner's CLI pays: an API key is money, a subscription counts tokens toward its plan, a provider is OpenCode's own. */
export const Billing = z.enum(['api-key', 'subscription', 'provider']);
export type Billing = z.infer<typeof Billing>;

export const RetroSpan = z.enum(['last', '7d', '30d']);
export type RetroSpan = z.infer<typeof RetroSpan>;

/** A plan: what is in scope, what was left out and why, and the batches frozen for its run. */
export const RetroPlan = z.object({
  id: z.string(), created: z.number(),
  span: z.object({ from: z.number(), to: z.number(), label: z.string() }),
  focus: FocusPick,
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
  batches: z.array(z.object({ id: z.string(), excerpts: z.array(z.string()), tokens: z.number().int() })),
  // what a focus has too little evidence for, said before anything is read
  thin: z.array(z.string()),
  pricesChecked: z.string(),
});
export type RetroPlan = z.infer<typeof RetroPlan>;

export const RetroStatus = z.object({ run: z.string(), stage: RetroStage, done: z.number().int(), total: z.number().int(), error: z.string().optional() });
export type RetroStatus = z.infer<typeof RetroStatus>;

/** A run's findings as printed: the last run's fixes and how they measured since, then this run's. */
export const RetroReport = z.object({
  run: z.string(), findings: z.array(Finding), previous: z.array(Finding),
  // found without a model while indexing: hook errors, commands that keep failing, denials
  mechanical: z.array(z.string()),
  thin: z.array(z.string()),
  // what the budget or a failed read left unread, as `babysit-pr: 20 of 131 runs read`
  skipped: z.array(z.string()),
  usage: z.object({ budget: z.number(), used: z.number() }),
});
export type RetroReport = z.infer<typeof RetroReport>;
