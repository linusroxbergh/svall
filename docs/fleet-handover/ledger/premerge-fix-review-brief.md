# Pre-merge fix wave — reviewer brief

You review one fixer's branch in the pre-merge fix wave on PR #2 (base b31fe003). Your prompt names the branch, its
worktree and its brief. Read `ledger/premerge-fix-common.md`, that fixer's brief, `ledger/review-constraints.md`, and
the review item(s) in `ledger/pr2-premerge-review.md`.

Review report-only in a detached worktree of your own (`git -C /Users/linusroxbergh/linus_laboratory/svall worktree
add --detach <scratchpad or .claude/worktrees>/<name> <branch>`, `pnpm install --frozen-lockfile --offline`); remove it
when done. Don't edit the fixer's worktree or branch.

Check:
- The diff (`git diff b31fe003..<branch>`) does what the brief asks, closes the review item's failure scenario, and
  nothing else. Simplest change that holds; matches the surrounding code and the docs' prose style (present tense, no
  history words, no ticket ids; comments only where needed, 1–2 lines).
- Tests are load-bearing: revert each fix line in your worktree, rerun, and show the new test going red; restore.
- Edge cases the fix may have missed (other callers, other paths with the same flaw, flag-off behaviour unchanged
  except where the brief says so).
- Run typecheck and the touched projects' vitest (Swift/Playwright single specs if touched). Rules: `unset SVALL_HOME
  SVALL_CHAR_ID TMUX`; temp HOMEs only; never the real `~/.svall*`, `~/.config/svall`, LaunchAgents, `/Applications`,
  `~/.ssh`, keychain or linus-vault; no colima. Known flakes are in `docs/fleet-handover/README.md`.

Return: verdict **Approved** or **Changes needed**; each finding as Important (must change) or Minor (may be
deferred), with file:line, evidence (what you ran) and the fix; plus what you verified.
