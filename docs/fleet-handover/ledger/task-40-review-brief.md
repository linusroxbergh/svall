# Task 40a — review of the rebase onto current main (brief)

Worktree `/Users/linusroxbergh/linus_laboratory/archipelago/.claude/worktrees/fleet-handover-impl`, branch
`experimental-remote-sessions`. Before: 45856c9b..809d5b4e (feature 43d2a586 + three docs commits). After:
615da858..fe22ba68 (feature 8d321c0d, docs 6c9b50bd/35c6c78e/bac3290b, follow-up fe22ba68 "The fleet handover branch
runs on current main"). origin/main is 615da858, 20 commits past 45856c9b.

Read: the implementer's brief `docs/fleet-handover/ledger/task-40-brief.md`, its report
`docs/fleet-handover/ledger/task-40-rebase-report.md`, the delivery rules `docs/fleet-handover/ledger/review-constraints.md`.
The spec `docs/fleet-handover/spec.md` is binding.

## Check

1. Nothing dropped. For every file that conflicted (`git merge-tree --write-tree --name-only origin/main 809d5b4e`
   lists them), main's behaviour from 45856c9b..615da858 and the branch's behaviour from 45856c9b..43d2a586 are both
   present in fe22ba68. `git range-diff 45856c9b..809d5b4e 615da858..fe22ba68` and per-file three-way reading
   (`git diff 45856c9b 615da858 -- <f>`, `git diff 45856c9b 43d2a586 -- <f>`, `git show fe22ba68:<f>`) are the tools.
   Spend most time on the daemon (`fleet.ts`, `reconcile.ts`, `main.ts`, `store.ts`, `api/*`, `setup.ts`,
   `uninstall.ts`), protocol, and Swift `Bridge.swift`/`ShellRouter.swift`.
2. The brief's integration checks, each against the code, not the report: ownership-guard classification of every
   method main added or changed (a fenced daemon must not wake, revive, idle-close or mutate); idle close vs rest /
   activation / carried terminals / mid-handover; secrets hidden from Files after the config split; bundle ids;
   agent-profile fields vs the path-field classification; quit guard vs detach-not-abort.
3. The follow-up commit's behaviour changes (idle sweep writability re-check, kept idle-close resume command on import,
   wake-on-open waits during a handover, "resume failed" label and chip, desktop-install ordering and `--silent`,
   `setup --check` against release vs checkout, doctor's config lines): each correct, tested, and inside Task 40's scope
   or clearly needed by the rebase.
4. `PROTOCOL_VERSION` 15, state v8 migration from main's v7 (main changed v7's shape without a bump — check that a v7
   file main writes today lifts to v8 without loss), `handover.enabled` off by default.

Run whatever focused tests you need (every shell: `unset -f node npm npx pnpm _load_nvm nvm 2>/dev/null; export
PATH="$HOME/.nvm/versions/node/v24.18.0/bin:$PATH"; unset ARCHI_HOME ARCHI_CHAR_ID TMUX TMUX_PANE`; single files as
`pnpm test <path>` from the root). Another agent is building the app from this worktree at the same time; do not
run `desktop:install`, Playwright or anything that writes outside `node_modules`/test temp dirs.

## Rules

Read-only. Editing, creating, staging or committing any file other than your review file fails the task. Never touch
`~/.archipelago`, `~/Library`, `~/.claude`, `~/.codex`, `~/.ssh` or linus-vault.

## Report

Write `docs/fleet-handover/ledger/task-40-rebase-review.md`: verdict (Approved / Needs fixes), then findings ranked
Critical / Important / Minor, each with file:line, evidence (the two sides and the merged result), and the fix you
suggest. Say which integration checks you verified clean. End your reply with the verdict line and the finding counts.
