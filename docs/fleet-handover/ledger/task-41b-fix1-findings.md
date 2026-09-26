# Task 41b fix round 1 (findings)

From `ledger/task-41b-review.md` (file:line and evidence there). FIX_BASE = HEAD at dispatch. Rules and report shape as
the 41b dispatch (`task-41-brief.md` "Both halves"); report `ledger/task-41b-fix1-report.md` (uncommitted).

- **I1 (Important)** The Claude adapter refuses a session folder holding any file outside its sidecar whitelist
  (`sessions/claude.ts` ~10-21, ~46-50), so a newer Claude writing a new file kind blocks the handover — against the
  spec's "depends only on where its CLI keeps a session's files… no maximum". Carry every regular file under
  `projects/<slug>/<id>/`; symlinks and unreadable names stay refused. Test: an unknown file kind in the session folder
  travels byte for byte.
- **I2 (Important)** If `<common>/worktrees` arrives as a symlink and the graph carries no worktree, the import follows it
  and deletes what it points to (`git-import.ts` ~127-131; reproduced). Refuse with `worktree_unresolved` unless it is a
  real directory, as `config` is checked. Test: a symlinked `worktrees` blocks and its target is untouched.
- **M1** Nothing tests the import turning a git or filesystem failure into a blocker (making it rethrow passes every
  test). Inject the filesystem/git runner as the delivery rules ask and test the failure path.
- **M2** Restore the `ä` / `ä` escapes in `probeFsRules` (`git-import.ts` ~17,20), so an editor's Unicode
  normalisation can't turn the probe into a constant.
- **M3** The fixture READMEs still say versions are pinned and path mapping is to come; make them describe the current
  behaviour (leave the spike scripts, the `*-portability` tests and `spike-results.md`/`readiness.md` as they are).
- **M4** `AGENTS.codex.minVersion!` asserts a floor main could drop; handle its absence (no floor) without the `!`.
