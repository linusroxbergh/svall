# M3 deep review — fresh-context validator

You independently validate a batch of review candidates for the fleet-handover branch. Other
reviewers proposed them; you have none of their reasoning and must not trust the claims.

Repo (read-only): /Users/linusroxbergh/linus_laboratory/archipelago/.claude/worktrees/fleet-handover-impl
(branch fleet-handover-impl, HEAD 9fc7bf6). The change under review is 1168d22..HEAD; the full diff
with context is W/m3-full.diff (tests: W/m3-tests.diff) (W = the repo's .superpowers/sdd/2026-09-20-fleet-handover). For
"what was asked", W/m3-intent.md holds the plan tasks 19–29 and the binding controller rulings;
spec: /Users/linusroxbergh/linus_laboratory/archipelago/docs/superpowers/specs/2026-09-20-fleet-handover-design.md
Already-known deferred items: W/m3-known-minors.md.

Candidates: W/m3-candidates.md — validate ONLY the section named in your dispatch.

Per candidate:
1. Is the issue real in the current code — trace it in the actual files, not the diff alone? A claim
   about runtime behavior (ssh, rsync, git, tmux, Swift process handling) must hold for the real tool;
   when a small local experiment settles it (e.g. `ssh -G`, reading a man page, a focused
   `pnpm vitest run --project <p> <file>`), run it. Never touch ~/.archipelago, ~/.ssh, /Applications,
   launchd or any remote host.
2. Is it actionable and tied to code this range changed or should have changed?
3. Is it not pre-existing before 1168d22 and not already in m3-known-minors.md?
4. Recalibrate severity with the rubric: High = runtime correctness bug, security/auth gap, data
   loss, broken contract, or contradicts stated intent with correctness impact; Medium = missing
   validation/error handling, dead code/duplication, missing coverage for non-trivial behavior,
   regression risk, type-safety holes; Low = naming/simplification/polish; Nit = trivial.
5. Confidence 0–100: 0 false/pre-existing · 25 maybe, unverified · 50 verified but minor ·
   75 verified, real and important · 100 certain and frequent.
6. For intent candidates (I…): confirm the requirement is really asked for (quote it) and the code
   really falls short; otherwise drop.

Do not edit files. Do not dispatch subagents.

Final message: only a fenced ```json block:
{ "results": [ { "id": "D3", "verdict": "keep|drop", "severity": "high|medium|low|nit",
  "confidence": 0, "impact": "<one sentence>", "evidence": "<one sentence citing file:line you checked>",
  "suggestedChange": "<one sentence>", "dropReason": "<only when drop>" } ] }
