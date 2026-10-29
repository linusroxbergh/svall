# Retro v2

## Status

Design approved 2026-10-29 after review by gpt-6.1-sol. Replaces the excerpt → note → judge pipeline in
`packages/svalld/src/retro/`. Scope, discovery, indexing workers, inventory, ledger, apply and fix robots stay.

## Problems this solves

Measured on run r_1793263426 (7 days, 194 sessions):

- 300k tokens of excerpts were squeezed into 36 one-line notes (cap ~2k tokens per 50k batch, reads at effort
  `low`), and each note cites one session. With a 3-session gate, most patterns are dropped.
- 3 of 9 batches went unread. The estimate's 3.5 chars/token is low for transcripts, and every read resends the
  ~200-skill inventory.
- The judge sees only the skills notes named, so it proposed a skill that is already installed.
- Error lines carry counts with no cause ("bundle exec failed 69 times").
- Nothing reports what works. Value is computed but never shown. The output is raw CLI text: session ids, line
  numbers, full diffs.

## What the user gets

A retro answers five questions with numbers and concrete changes:

1. **How did the span go?** Session mix by repo and kind of work, and active time.
2. **What works?** Skills and habits that ran without a correction.
3. **What do reviews miss?** Feedback others gave after a local review, and how much of it was a confirmed miss.
4. **What errors keep costing time?** Grouped by cause, not command name.
5. **What is done by hand and should be a skill?** Checked against the text of installed skills: extend one before
   drafting a new one.

The chat shows a summary of at most 25 lines with the top 5 findings. `report.md` holds everything, under the same
numbers, and `svall retro show N` prints one finding. Example built from r_1793263426; ⟨⟩ marks numbers that need
the new pipeline:

```
Retro · Oct 22–29 · 194 sessions in 5 repos                   report: ~/.svall/retro/runs/r_…/report.md

The span: mostly PR review loops in core-api (⟨41%⟩ of sessions), then building in mm-ai-suite. ⟨31h⟩ active.

Ran without a correction
  slack-private-pr ⟨9 of 10⟩ runs · gpt-validate ⟨14 of 16⟩

Worth fixing
  1 High  Local reviews miss missing specs that others catch
          ⟨7⟩ confirmed misses in ⟨5 of 17⟩ reviewed PRs, all missing specs.
          → work-review lists new branches with no spec; no approve footer while any.   skill edit
  2 High  ⟨bundle exec rspec fails because Redis isn't running⟩
          ⟨41 failures in 12 sessions, ~3h elapsed⟩.  → start Redis in core-api's spec step   rule line
  3 Med   Final reports are long and don't say what to do
          ⟨5⟩ sessions where you asked what changes or whether to act.  → one line in CLAUDE.md   rule line
  4 Low   You chain "triage comments → gpt-validate → fix → reply" by hand (⟨4⟩ sessions)
          → extend gh-address-comments (installed, never run)   skill edit
  5 Low   babysit-pr posts "no activity, restarted" each half hour (⟨7 of 17⟩ runs)
          → re-arm silently, stop after 24h   skill edit

⟨3⟩ more findings, ⟨2⟩ seen once, ⟨2⟩ emerging, in the report · 163 installed skills never ran (4 plugins hold 120)
All 194 sessions read · ⟨1.1M⟩ small-model + ⟨260k⟩ Opus tokens
Reply "fix 1 3", "more 2", "dismiss 4 wrong"
```

## Pipeline

```
plan (code)        scope → outlines → compact → card cache lookup → review joins → estimate
cards (small)      every uncached session chunk → a card; quotes checked against the source block
labels (small)     each later PR comment on a reviewed PR → theme, severity, catchable, in local findings, addressed
aggregate (code)   groups with full counts and denominators, example evidence, works, coverage
synthesis (strong) one call over the groups → ≤12 candidate findings citing group ids and example ids
verify (strong)    each candidate's final claim and change against raw source and the nearest existing skill or rule
finalize (code)    occurrences from groups, gate, ids, targets, hashes, value, measures
render (code)      report.json, report.md, CLI summary
```

Code does everything countable. Models only read and judge text. The small model sees every session once. The
strong model sees compiled groups, bounded by caps whatever the span. Lenses (one synthesis per area) come only if
the single synthesis measurably overflows its cap or misses findings. The verify-then-finalize order means nothing
rewrites a finding after it was checked.

### Plan (code, no model)

Scope, discovery and the indexing workers work as they do now, with these additions.

**Outline**
- Each turn gets a stable source id `L<line>.<block>`, since several blocks can share a transcript line. A
  command links its call turn and its result.
- New clips: user text 4,000 chars (all user text in last week's 207 sessions is 268k chars), agent text 1,500,
  failed-command output 1,000 with the exit status, and `GH_BODY` writes 8,000.
- The report counts the turns that were clipped.
- A Claude subagent's final message becomes a turn `SUBAGENT <type>: …` in its parent, so delegated reviews are
  read and not only counted.
- Codex skill runs found by a SKILL.md read are marked `inferred`.

**Compaction** (`compact.ts`)
- A run of tool turns becomes one line:
  `L120.0–134.1 TOOLS Read×4 Edit×2 (a.ts, b.ts) · ✓ pnpm test · ✗(1) bundle exec rspec x_spec.rb → "Redis::CannotConnectError…"`.
- Skill calls become `SKILL work-review`.
- Kept as they are: user and agent text, subagent results, `GH_BODY` writes, interrupts and rejections.
- Last week's 207 sessions go from ~2.4M to ~1.4M tokens.

**Review joins** (`prs.ts`)
- Each review run joins to a PR on its own:
  - the PR linked inside the run's turns;
  - else the nearest PR link before it in the session;
  - else the session branch's PR.
- A run naming several PRs is reported as unjoined.
- The reviewed revision is the PR's last commit at or before the run ended.
- For each PR, keep every comment and thread reply, the author's included:
  - from inline review comments: `id`, `in_reply_to_id`, `path`, `diff_hunk`, `original_commit_id`;
  - review bodies and conversation comments;
  - `bot`, for logins ending in `[bot]`;
  - commits with dates and files changed, capped at 30 per PR.
- The report counts joins that failed, were ambiguous or were truncated.

**Cache lookup**: covered under Cache.

The plan has no `--focus`.

### Cards (small model)

**Chunks.** Sessions split on turn boundaries into chunks of at most 40k tokens, with id `<session>#<k>`. Each
chunk after the first opens with the previous chunk's last two user turns, marked `context`, which can't be cited.

**Calls.** Chunks are packed into calls of at most 40k tokens, 6 in parallel. A call must return exactly one card
per chunk id it was given. A missing card is retried once alone, then counted as failed. Each chunk reserves 1.5k
tokens for output.

**Prompt.** It names the skills that ran in the chunk, with their source ids, and nothing else from the inventory.

```ts
Card = {
  chunk: string;
  goal: string;                                   // one line
  kind: 'build' | 'fix' | 'review' | 'pr-feedback' | 'research' | 'ops' | 'other';
  outcome: 'done' | 'partial' | 'abandoned' | 'unclear';
  asks: { at: string; intent: string }[];         // at: source id; intent: "verb object"
  corrections: { at: string; quote: string; about: 'report-style' | 'wrong-fact' | 'scope' | 'skipped-step'
    | 'wrong-approach' | 'asked-not-checked' | 'other'; what: string }[];
  rules: { at: string; quote: string }[];         // standing instructions the user typed
  friction: { from: string; to: string; kind: 'tool-error' | 'env' | 'retry-loop' | 'permission'
    | 'lost-context' | 'other'; what: string }[];
  skills: { at: string; name: string; went: 'no-issue' | 'corrected' | 'redone' | 'abandoned'
    | 'wrong-trigger' | 'unclear'; what: string }[];
  reviews: { at: string; findings: string[]; limits: string | null }[];   // what the local review reported
  wins: { at: string; quote: string }[];          // the user's own words of approval only
}
```

Every field is required, using `[]` or null where there is nothing (Codex output schemas require all fields).

**Merging chunks.** Arrays concatenate, with duplicates dropped by `(at, kind or about)`. `goal` and `kind` come
from the first chunk, and `outcome` from the last. A session whose last turn is less than an hour old gets
`outcome: 'unclear'`.

**Checks in code**:
- An item whose `at` isn't a source id of a user or agent turn in that chunk is dropped.
- A quote must appear verbatim (whitespace normalised) in that turn, and corrections and rules must cite a user
  turn.
- The share of items dropped is reported as card quality.
- A friction item's `elapsed` comes from the timestamps at `from` and `to`. Gaps over 5 minutes between turns are
  left out, and overlapping intervals count once.

### Labels (small model)

Each comment by someone other than the PR author, made after a joined review run, is sent with:
- its thread replies;
- its `diff_hunk`;
- whether `original_commit_id` is at or before the reviewed revision;
- the local review's `findings`;
- the commits after it that touched its `path`.

The labeller returns:

```ts
{ comment: string; theme: 'missing-test' | 'logic-bug' | 'edge-case' | 'error-handling' | 'concurrency' | 'security'
  | 'performance' | 'naming-style' | 'docs' | 'design' | 'question'; severity: 'high' | 'medium' | 'low';
  catchable: boolean; inLocalFindings: boolean; addressed: 'yes' | 'no' | 'unknown' }
```

Code classes each comment:
- **later feedback**: every such comment;
- **confirmed miss**: catchable, not in the local findings, on code that existed at the reviewed revision
  (`original_commit_id` at or before it), and addressed, either in the thread or by a later commit touching
  its file;
- **unknown**: the revision or the fix can't be established.

The report shows all three counts, by theme and severity.

### Aggregate (code)

Builds deterministic **groups**. Each has an id, a key, a full count, a denominator in the same unit, and up to 5
example evidence ids:

| Group | Key | Count / denominator |
|---|---|---|
| review miss | review skill × theme | confirmed misses / reviewed PRs; later feedback and unknown shown beside |
| skill outcome | skill × `went` | runs / runs of the skill |
| correction | `about` (+ the target rule file when the text names one) | sessions / sessions in scope |
| retyped rule | normalised rule text, clustered by the synthesis | sessions / sessions in scope |
| error | program + subcommand × signature | failures and sessions / sessions running that program |
| friction | kind × repo | sessions, elapsed / sessions in scope |
| ask | intent (clustered by the synthesis) | sessions / sessions in scope |
| sequence | 3–5 consecutive `program subcommand` calls | sessions / sessions in scope |

**Error signatures** keep status codes, exit codes and error class names. They strip paths, hashes, line numbers
and durations. A probe program (`ls cat grep rg find test sleep echo which stat wc sed awk jq cd`) failing with
"no such file", "not found" or an empty output counts as an expected exit, reported apart. Any other failure of a
probe groups like any command.

**Also computed**:
- works: skills with ≥5 runs and ≥85% `no-issue`, plus the user's approvals from `wins`;
- session mix by repo and `kind`, and active time (the sum of gaps between turns of at most 5 minutes);
- coverage by agent, repo and day: sessions carded, cached or failed, turns clipped, unjoined review runs;
- unused skills grouped by plugin or source.

### Synthesis (strong model, one call)

**Input**, capped at 150k tokens:
- the group tables with their examples' text;
- installed skill names and descriptions;
- the text of the rule files (CLAUDE.md, AGENTS.md, repo and rule-dir files, ≤40k tokens);
- dismissed ledger categories.

Over the cap, the groups with the lowest count and the oldest last occurrence go first, and the report says how
many.

**Output**: at most 12 candidates, plus the overview line and the works wording.

```ts
{ category; groups: string[]; examples: string[]; title; problem; fix;           // plain, one line each
  change: Change; target: string | null; subject: string;
  nearest: string[];                                                             // existing skills/rules it could extend
  kind: 'pattern' | 'singleton' }
```

**Rules in the prompt**:
- Cite group and example ids, never write quotes.
- Every new-skill or new-rule proposal names its nearest existing skills or rules.
- Prefer repairing an existing instruction over adding a near-duplicate.
- Write for someone who wasn't there.

### Verify (strong model)

Candidates go to the verifier in groups of 4. Each candidate comes with:
- the raw outline turns around every example (±3 turns), or for a PR example, the comment thread with its
  `diff_hunk`;
- the target's current text;
- the full text of up to 3 `nearest` skills or rules.

Evidence per candidate is capped at 12k tokens. A candidate cut at the cap can at best be `partly`, never
`holds`.

**Verdicts**:
- `holds`, `partly` (kept at lower confidence) or `no` (dropped and listed in the report with the reason);
- for the change: `ok`, `edited` (with the corrected change) or `extend <nearest>` (rewritten against that
  target);
- for a rule: `rule active` (the rule text was in force for the cited sessions), `preference observed` (no rule
  says it), or `rule newer than evidence` (the rule file changed after the sessions, by mtime).

### Finalize (code)

- **Occurrences** come from the full counts of the cited groups, never from the examples.
- **Gate**:
  - A `pattern` needs ≥3 sessions or ≥2 PRs.
  - With exactly 2, it is **emerging** and shown in the report only.
  - A `singleton` passes only as a verified error with a cause or an instruction conflict, shown as "seen once".
- **Ids**: `findingId(category, realPath, subject)`, with no lens and no rank. When the verifier rewrites a
  candidate into an extension of an existing target, the id follows the final target.
- **Ledger and order**: dismissed ids drop. Targets, hashes and apply/robot routing work as now. Then value, and
  numbering by value.
- **Measure**: the group keys the finding cites. The next retro counts the same keys over the time since the fix.
  A finding with no countable group says "not automatically measurable". `MeasureKind` goes.

## Value

A priority heuristic, computed in code and shown as its parts so it can be read:

- **recurrence** = the group's full count `n`, and the rate `n / m` in the same unit;
- **impact per occurrence**, by category:
  - confirmed review miss: 2 for low severity, 3 for medium, 4 for high;
  - redo or abandon: 3;
  - user correction, or a rule missed while active: 2;
  - friction: 1 + elapsed minutes / 10, capped at 3;
  - repeated workflow: 1 + (steps − 2) / 2, capped at 3;
  - noise: 1;
- **confidence** = the verdict (`holds` 1.0, `partly` 0.6);
- **score** = `n × impact × (1 + rate) × confidence`. High ≥15, Med ≥6, else Low. The constants live in
  `value.ts`.
- **reason** next to the badge is the strongest fact, such as "7 confirmed misses in 5 of 17 reviewed PRs",
  "41 failures in 12 sessions, ~3h elapsed" or "5 of 194 sessions".
- **effort tag**: `rule line` · `skill edit` · `new skill` · `setting` · `code change`.

## Output

- **Versioning**: `report.json` and `plan.json` carry `version: 2`. A run without one prints "made by an older
  retro; plan again".
- **`RetroReport`** holds:
  - `overview`, `works`, `findings`, `emerging`, `singletons`, `dropped`;
  - `errors` (the top groups), `housekeeping` (unused skills by plugin);
  - `coverage`, and `usage.byStage`.
- **`Finding`** gains `problem`, `fix`, `value` (`{ badge, score, n, m, impact, confidence, reason }`), `effort`,
  `verdict`, `groups` and `kind`.

Commands:
- **`svall retro findings [run]`** prints the summary: at most 25 lines, top 5 findings, no session ids or line
  numbers.
- **`svall retro show <n> [run]`** prints finding n's section of `report.md`.
- `mark`, `apply` and `show` use the report's numbers, which are the same in chat and in `report.md`.

**`report.md`** (0600, in the run dir) has these sections:
1. the summary;
2. each finding:
   - why it matters, with value parts;
   - what was seen (`Oct 27 · core-api · "quote"`, short session id);
   - the change, fenced;
   - where it lands and how;
   - the verdict;
   - how the next retro measures it;
3. emerging patterns and things seen once;
4. findings the verifier dropped, with reasons;
5. error groups;
6. the skills table;
7. review feedback (later feedback, confirmed miss, unknown, by theme);
8. repeated asks and sequences;
9. session mix and active time;
10. unused skills by plugin;
11. coverage and tokens by stage.

## Skill flow (`svall-retro/SKILL.md`)

1. Run `svall retro plan` with the span and picks the user gave.
2. Ask one question screen covering:
   - the span;
   - extra repos with their session counts;
   - presets with tokens, cost and billing;
   - "N sessions, M cached".
3. Run `svall retro run <id> --preset …`, then `svall retro wait`.
4. Run `svall retro findings <id>`, show it as printed, and point the robot note at the run.
5. Follow-ups:
   - "more N" runs `svall retro show N`;
   - "report" gives the path;
   - fix, dismiss and later work as now, by the report's numbers.

`svall retro show` joins the allow lists in `home/.claude/settings.json` and `home/.codex/rules/svall.rules`.

## Models, budget, progress

| Preset | Claude: cards (read) / synthesis (judge) / verify | Codex |
|---|---|---|
| thrifty | haiku / sonnet / sonnet | luna / sol / sol |
| balanced (default) | haiku / opus / sonnet | luna / astra / sol |
| thorough | sonnet / opus / opus | sol / astra / astra |

OpenCode runs its own model in every role. `fleet.json` `retro.model[agent]` keeps `read` (cards) and `judge`
(synthesis), and gains an optional `verify`. No config migration is needed.

**Estimate.** Each call's tokens = (serialized prompt chars ÷ chars-per-token) + the runner's fixed overhead + an
output and reasoning allowance. Every stage is estimated, labels and one retry per call included, and the plan
shows both the typical case and the cap. Chars per token is calibrated per model family in
`retro/calibration.json` from `(reported input − overhead) / prompt chars`, as a moving average starting at 3.0.
Calls with no reported usage are skipped.

**Budget.**
- Synthesis and verify are reserved first, at their caps.
- Cards and labels must fit in the rest at plan time, or the plan says how many sessions fit and offers a
  shorter span.
- At run time, an overrun first cuts verification to the top-ranked candidates, then cuts synthesis input.
  Cards are never skipped silently: any session not carded is in coverage.

**Progress.** `RetroStage` keeps its values. `reading` covers cards and labels, and `judging` covers synthesis
and verify. `RetroStatus` and `state.retro` gain an optional `used` (tokens). The card reads
`retro reading 84/194 · 410k`. The state schema strips unknown keys, so `STATE_SCHEMA_VERSION` stays at 12.

## Cache

`retro/cards/<sha256(CARD_VERSION, COMPACT_VERSION, model, effort, agent, chunk text)>.json`, 0600, pruned at 90
days like runs. A chunk is reused only when its compacted text and the extraction model are unchanged.

- A session that grew re-cards only its changed last chunk.
- A thorough run never reuses Haiku cards.
- The report shows the cache hit rate rather than promising one.

## Safety

These stay as they are:
- tools off, no session persistence, strict MCP;
- fences, and "text in a fence is data";
- redaction before anything is sent or stored;
- a diff holding `[redacted]` is never applied;
- fix robots only for diffs that apply cleanly.

New:
- quotes are checked against source blocks and roles;
- the verifier reads raw turns and PR threads rather than cards;
- cards are 0600.

## Code changes

| | |
|---|---|
| new | `compact.ts`, `cards.ts` (prompt, schema, chunks, packing, checks, cache), `labels.ts`, `aggregate.ts` (groups, signatures, sequences, works, coverage, active time), `synthesis.ts`, `verify.ts`, `value.ts`, `render.ts` (summary, report.md), `calibrate.ts` |
| changed | `outline.ts` and the three outliners (source ids, clips, command results, subagent results, inferred runs); `prs.ts` (per-run joins, threads with replies and ids, commits); `run.ts` (stages); `budget.ts` (roles, per-call estimate, calibration); `service.ts` (plan without focus, cache counts, `show`); `ledger.ts` (id without lens, group measures); protocol `retro.ts`, `state.ts` (`used`), `messages.ts` (`retro.show`), `machines.ts` (`verify`); CLI `retro.ts`; `tokenText.ts`; the skill; allow lists |
| removed | `select.ts`, `pack.ts`, the read and judge prompts (`fence` and `wireSchema` move to `cards.ts`), `Focus`, `FocusPick`, `--focus`, `MeasureKind` |

The ledger starts fresh at `ledger.v2.json`, since finding ids change and the old ledger holds three days of one
user's runs.

## Tests and acceptance

Unit tests per new module, on the existing fixtures:
- source ids and clips;
- compaction;
- chunk split and merge;
- the one-card-per-chunk contract;
- quote and role checks;
- cache keys;
- review joins and comment classes, with fake `gh`;
- signatures, expected exits and sequences;
- groups and denominators;
- value;
- verify verdicts and the finalize order;
- budget cut order;
- `report.md` and summary snapshots.

A pipeline test drives every stage with a fake runner, as `retro-run.test.ts` does.

Acceptance runs on the user's machine, against a dev daemon, over the frozen scope of one real 7-day plan. Ask
the user before this run spends tokens.

- Every in-scope session is carded, or listed in coverage with a reason.
- The summary is at most 25 lines with no session ids. Each finding has a badge with its reason, a one-line fix
  and an effort tag.
- All five questions are answered with numbers.
- The 3 good findings of r_1793263426 come back in substance: work-review gaps, the report rule, babysit-pr. The
  fourth comes back as an extension of `gh-address-comments`, not a new skill.
- 10 random cards are spot-checked against their transcripts by hand, and every headline finding's examples are
  read in source. Misreads and false findings are listed in the PR.
- Negative check: 5 sessions the user calls uneventful are named by no headline finding.
- Tokens land within ±25% of the typical estimate. The card shows a running total.
- A second plan the next day reports its cache hit rate. Measured, not promised.

## Size of one run over a 7-day span (207 sessions)

| Stage | Typical | Cap | API cost, typical |
|---|---|---|---|
| cards (haiku) | ~1.4M in, ~0.2M out | same + 10% retries | ~$0.25 |
| labels (haiku) | ~50k | ~100k | <$0.03 |
| synthesis (opus) | ~120k in, ~10k out | 150k in, 16k out | ~$0.70 |
| verify (sonnet) | ~60k in, ~8k out | 12 × 12k + targets ≈ 200k in | ~$0.20 |
| **total** | | | **~$1.20**; cap ≈ $2.50; 6–10 min |

Run r_1793263426 cost 729k Opus tokens (~$3) for 6 of 9 batches of excerpts.

## Risks

- **Subscription rate limits** on 6 parallel small-model calls: back off on 429, and drop to 3 in parallel for
  the rest of the run.
- **Card drift**: bounded by source checks and the verifier's raw reads. Card quality is reported every run.
- **Single synthesis misses an area on long spans**: coverage shows which groups were cut. Split into lenses only
  after the acceptance run shows the need.
- **Codex and OpenCode give weaker provenance**: inferred skill runs, and message-index lines for OpenCode.
  Coverage reports by agent, and inferred runs are marked.
