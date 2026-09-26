# Task 40 fix round 1 (findings)

Worktree `/Users/linusroxbergh/linus_laboratory/archipelago/.claude/worktrees/fleet-handover-impl`, branch
`experimental-remote-sessions`, FIX_BASE = HEAD at dispatch. Spec `docs/fleet-handover/spec.md` is binding; delivery rules
`docs/fleet-handover/ledger/review-constraints.md`. Sources in `docs/fleet-handover/ledger/`: the review
`task-40-fixes-review.md` (m1–m5) and the second smoke `task-40-smoke2-report.md` (N1, N2), each with file:line and
evidence. The wave these fix is `task-40-fixes.md` / `task-40-fixes-report.md`.

## Items

- **R1 (review m1)** On Linux, `archi setup` looks for claude and codex on the ssh PATH instead of the PATH the units run
  with (`packages/cli/src/commands/setup.ts`, around `findAgents`), so `host add` skips Claude's hooks unless
  `~/.claude` already exists, and `host doctor` then fails `hooks`. Use the PATH doctor uses (`pre.agentPath ??
  pre.pathEnv`).
- **R2 (review m2)** When waking a terminal on the destination fails, `lay()` rebuilds its revive command without the
  launch flags it carried (`packages/archid/src/handover/destination.ts`, `lay`). Keep the carried revive (F3's rule).
- **R3 (review m3 + m4)** tmux 3.4 prints control characters and `$`+char escaped, and the daemon keeps that text as a
  window name or pane path, so a pane under `…/$work` gets a cwd that exists on neither machine. Make names and paths
  decode exactly on 3.4 (the fix report's sketch — have tmux replace backslashes with a placeholder in the format, then
  decode — was checked to work by the reviewer), and make the 3.4 test fixtures include the `$` escape; the
  session-listing test must fail without its fix.
- **R4 (review m5)** Doctor's refusal message reads "…delete it.; a stopped archid waits…" (`packages/cli/src/commands/doctor.ts`).
- **R5 (N1, Important)** `archi host upgrade` across a protocol change: the install step runs the far machine's old
  `archi setup`, whose probe cannot talk to the new daemon, so it rolls `current` back; the step still reports ok; the
  upgrade's probe then runs `setup --rollback` with no target, which picks the newest other release by mtime (the new
  one); the step says "back on the release it ran before" while the machine runs the new release; exit 1, three restarts.
  Fix: an upgrade runs the new release's own setup (or otherwise never probes with the old client); a rollback names
  the release it returns to and reports the release actually current afterwards. Tests at the controller level for an
  upgrade across a protocol bump (ok, no rollback) and for a failing new release (rolls back to the named previous
  release, reports it).
- **R6 (N2)** A setup on a machine that does not own the fleet wrote the fleet's mission-control home
  (`<fleetHome>/home`, a carried root), so the next handover to it blocked `destination_occupied` until `--archive`.
  Ruling: the carried `home` root belongs to the owner — setup (and anything else) on a machine whose ownership record
  names another owner leaves it alone; the owner's own refresh stays as main has it. Test: setup on a replica leaves
  `home` byte-identical, and the next handover to it adopts the root without `--archive`.

## Rules

As `task-40-fixes.md`: test first for every behaviour change, each failing before its fix; the shell preamble; single
files as `pnpm test <path>`; verify with `pnpm typecheck` and `pnpm vitest run --project protocol --project archid
--project cli --project @archipelago/desktop-web`; no `~/.archipelago`, `~/Library`, `~/.claude`, `~/.codex`, `~/.ssh`,
`/Users/Shared/archi-m3b` or linus-vault; no bare `git stash`; don't rm gitignored build output; comments only where
behaviour is not self-evident, 1–2 lines; commit subjects one plain sentence, no attribution lines; one commit per item
or closely related pair; do not push.

## Report

`docs/fleet-handover/ledger/task-40-fix1-report.md` (uncommitted): per item what changed, failing-first evidence,
verification counts, concerns. End your reply with one status line: DONE, DONE_WITH_CONCERNS, BLOCKED or
NEEDS_CONTEXT, the commit range, and the counts.
