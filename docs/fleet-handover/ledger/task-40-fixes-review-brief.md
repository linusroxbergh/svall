# Task 40 — review of the second rebase and the fix wave (brief)

Worktree `/Users/linusroxbergh/linus_laboratory/archipelago/.claude/worktrees/fleet-handover-impl`, branch
`experimental-remote-sessions`. Spec `docs/fleet-handover/spec.md` is binding; delivery rules
`docs/fleet-handover/ledger/review-constraints.md`.

Two things to review, both in `docs/fleet-handover/ledger/`:

1. **The second rebase** (`task-40-rebase2-brief.md`, report `task-40-rebase2-report.md`): before 615da858..b22e6e85,
   after 86fcac4d..63f254ab. Check with `git range-diff 615da858..b22e6e85 86fcac4d..63f254ab` and three-way reading of
   the conflicted files (`git merge-tree --write-tree --name-only 86fcac4d b22e6e85` lists them) that nothing from main
   (615da858..86fcac4d: #18 main-agent onboarding, #20–#23) or from the branch was dropped, and check the brief's
   integration items against the code: `mainAgent` in fleet.json, main's per-CLI adapters beside the branch's session
   adapters and host checks, `mainAgent.set`/`island.reorder` fenced, installed-CLI-only setup on the release and Linux
   paths, `desktop-install.sh`.
2. **The fix wave** (`task-40-fixes.md`, report `task-40-fixes-report.md`), commits from 44730499 to the tip: each item
   F1–F12 done as briefed, correct, tested failing-first, and no wider than its item. F8's tmux listing must hold on
   tmux 3.4 and 3.7c for any window name; check its container evidence. F3 amends the spec: check the amendment and the
   code agree.

Run whatever focused tests you need (every shell: `unset -f node npm npx pnpm _load_nvm nvm 2>/dev/null; export
PATH="$HOME/.nvm/versions/node/v24.18.0/bin:$PATH"; unset ARCHI_HOME ARCHI_CHAR_ID TMUX TMUX_PANE`; single files as
`pnpm test <path>` from the root).

## Rules

Read-only. Editing, creating, staging or committing any file other than your review file fails the task. Never touch
`~/.archipelago`, `~/Library`, `~/.claude`, `~/.codex`, `~/.ssh`, `/Users/Shared/archi-m3b` or linus-vault.

## Report

`docs/fleet-handover/ledger/task-40-fixes-review.md`: verdict per part (Approved / Needs fixes), findings ranked
Critical / Important / Minor with file:line, evidence and suggested fix, and what you verified clean. End your reply
with the verdict line and the finding counts.
