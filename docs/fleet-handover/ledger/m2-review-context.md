# M2 gate deep review — shared context

Repo (read-only for you): /Users/linusroxbergh/linus_laboratory/archipelago/.claude/worktrees/fleet-handover-impl
Scope: the M2 range a67e100..HEAD on branch fleet-handover-impl — Phase C of the fleet-handover
feature (Mac ↔ Linux gateway), plan Tasks 12–18: release artifacts, Linux systemd setup, SSH
control-master transport, `archi host add/doctor/upgrade/remove/enable`, the gateway authority CAS
service and `archi gateway`, `archi connect --json` remote routing plus the Mac app's helper
process and remote attach, and the host-setup / remote-state UI.

W = /Users/linusroxbergh/linus_laboratory/archipelago/.claude/worktrees/fleet-handover-impl/.superpowers/sdd/2026-09-20-fleet-handover
- W/m2-full.diff — the full diff with 10 lines of context (12.5k lines; read it in passes)
- W/m2-stat.txt — `git diff --stat`; W/m2-log.txt — the 26 commits
- W/m2-intent.md — plan delivery rules, M2 milestone, Tasks 12–18 and the binding controller rulings
- W/m2-known-minors.md — findings already recorded as deferred; if you hit one, set `"known": true`
- Spec: /Users/linusroxbergh/linus_laboratory/archipelago/docs/superpowers/specs/2026-09-20-fleet-handover-design.md

Read the changed files and their surroundings freely. The strongest findings often sit OUTSIDE the
diff: callers of a changed API that were not updated, a sibling code path that should have changed
too. Check them.

## Project standards to enforce
- Delivery rules in W/m2-intent.md (argv-only subprocesses, no shell interpolation for ssh/rsync/git/
  tmux/systemctl/agents; DI for fs/process/ssh/clock/authority; durable JSON = same-dir temp + fsync +
  rename + 0600 for ownership/journal/registry/secret files; new UI behind `handover.enabled`; the
  local-only experience keeps working; tokens never in logs or preferences).
- The owner's working rules: minimum code that solves the problem, no speculative features or
  single-use abstractions; comments only where behavior is not self-evident, 1–2 lines, never
  narrating history ("previously", "no longer", ticket ids).

## Negative constraints
- Ignore formatting / lint / typecheck issues.
- Do not fabricate issues. Flag only real problems on changed lines, or things the change should
  have touched but didn't.
- Read-only: never edit files, never run git commands that mutate state, never touch ~/.archipelago,
  ~/.ssh, /Applications or the remote host. Do not dispatch subagents.

## Finding schema — return one fenced ```json block
{ "findings": [ {
  "severity": "high|medium|low|nit",
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
- High — must fix: security vulns / leaked secrets / auth gaps; correctness & logic bugs affecting
  runtime; data loss; races/deadlocks; breaking API contracts; missing error handling on critical
  paths; implementation contradicting stated intent with correctness impact.
- Medium — should fix: type-safety holes (any, unsafe casts); missing input validation / error
  handling; perf issues; React anti-patterns; hardcoded user-facing strings; a11y regressions; dead
  code / duplication / missing test coverage for non-trivial behavior / missing cleanup; public-API
  hygiene with correctness impact; regression risk.
- Low — nice to have: naming; alternative approaches; simplification opportunities; minor doc gaps.
- Nit — optional: trivial style.
