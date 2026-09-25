# M3 gate deep review — shared context

Repo (read-only for you): /Users/linusroxbergh/linus_laboratory/archipelago/.claude/worktrees/fleet-handover-impl
Scope: the M3 range 1168d22..9fc7bf6 on branch fleet-handover-impl — Phase D of the fleet-handover
feature (a running Archipelago fleet moves between a Mac and a Linux gateway), plan Tasks 19–29:
the transfer manifest and path classifier, destination replicas and divergence, Git graph discovery
and repair, Claude/Codex session adapters, the controller's rsync engine, the rest/process table,
source preflight/freeze/abort, destination prepare/activate, the controller transaction with its
journals and recovery, the `archi handover` CLI with its detached helper, `archi fleet recover
--force-owner` (gateway forced write + daemon adoption), and the Mac app's handover sheet and
owner reconnect.

W = /Users/linusroxbergh/linus_laboratory/archipelago/.claude/worktrees/fleet-handover-impl/.superpowers/sdd/2026-09-20-fleet-handover
- W/m3-full.diff — the production diff (tests excluded) with 10 lines of context, 13.7k lines; read it in passes
- W/m3-tests.diff — the test diff, 13.5k lines, 3 lines of context; consult it when judging coverage
- W/m3-stat.txt — `git diff --stat`; W/m3-log.txt — the 45 commits
- W/m3-intent.md — plan delivery rules, the M3 milestone, Tasks 19–29, the binding controller rulings, and the helper ↔ app contract
- W/m3-known-minors.md — findings already recorded as deferred/parked/carried; if you hit one, set `"known": true`
- Spec: /Users/linusroxbergh/linus_laboratory/archipelago/docs/superpowers/specs/2026-09-20-fleet-handover-design.md

Read the changed files and their surroundings freely. The strongest findings often sit OUTSIDE the
diff: callers of a changed API that were not updated, a sibling code path that should have changed
too, the other side of an RPC (controller ↔ daemon ↔ gateway ↔ app). Check them.

## Project standards to enforce
- Delivery rules in W/m3-intent.md (argv-only subprocesses, no shell interpolation for ssh/rsync/git/
  tmux/systemctl/agents; DI for fs/process/ssh/rsync/clock/authority; durable JSON = same-dir temp +
  fsync + rename + 0600 for ownership/journal/registry/secret files; rsync `--delete` only against a
  path absent/reserved by the transaction or matched by a replica record; never activate a destination
  terminal before the authority Commit; never reactivate the source after Commit; new UI behind
  `handover.enabled`; the local-only experience keeps working; tokens never in logs, journals,
  events, argv or preferences).
- The owner's working rules: minimum code that solves the problem, no speculative features or
  single-use abstractions; comments only where behavior is not self-evident, 1–2 lines, never
  narrating history ("previously", "no longer", ticket ids).

## Negative constraints
- Ignore formatting / lint / typecheck issues.
- Do not fabricate issues. Flag only real problems on changed lines, or things the change should
  have touched but didn't.
- Read-only: never edit files, never run git commands that mutate state, never touch ~/.archipelago,
  ~/.ssh, /Applications or any remote host. You may run a focused test (`unset ARCHI_HOME ARCHI_CHAR_ID
  TMUX` first; `pnpm vitest run --project <p> <file>` from the repo root) or a small experiment in a
  temp dir to settle a doubt. Do not dispatch subagents.

## Finding schema — return one fenced ```json block
{ "findings": [ {
  "severity": "critical|high|medium|low|nit",
  "category": "accessibility|architecture|dead-code|error-handling|i18n|naming|performance|security|test-coverage|type-safety|simplification|other",
  "file": "<absolute path>", "line": 123,
  "title": "<= 12 words",
  "flaggedBy": "Bug Hunter|The Architect|The Guardian",
  "impact": "<one sentence>", "evidence": "<one sentence: why it's real, cite the code>",
  "suggestedChange": "<one sentence>",
  "fixable": true, "fixKind": "simplify|safe-correctness|risky-behavior-change",
  "known": false
} ] }

## Severity rubric
- Critical — stop ship (ultra-rare): a core user journey fails totally because it depends on a
  condition nothing in the repo satisfies, or a directly exploitable breach / live credential
  exposure / irreversible bulk data corruption. Degraded or partial failure is High.
- High — must fix: security vulns / leaked secrets / auth gaps; correctness & logic bugs affecting
  runtime; data loss; races/deadlocks; breaking API contracts; missing error handling on critical
  paths; implementation contradicting stated intent with correctness impact. For this feature, any
  path where both machines run or mutate the fleet, or files are lost or overwritten, is High.
- Medium — should fix: type-safety holes (any, unsafe casts); missing input validation / error
  handling; perf issues; React anti-patterns; hardcoded user-facing strings; a11y regressions; dead
  code / duplication / missing test coverage for non-trivial behavior / missing cleanup; public-API
  hygiene with correctness impact; regression risk.
- Low — nice to have: naming; alternative approaches; simplification opportunities; minor doc gaps.
- Nit — optional: trivial style.
