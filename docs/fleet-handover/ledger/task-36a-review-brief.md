# Task 36a — review (brief)

Worktree `/Users/linusroxbergh/linus_laboratory/archipelago/.claude/worktrees/fleet-handover-impl`, branch
`experimental-remote-sessions`, commits 46978368..0d7722d4. Brief `docs/fleet-handover/ledger/task-36-brief.md` (36a
half); report `task-36a-report.md`; plan Task 36; spec `docs/fleet-handover/spec.md` (binding: "Ownership authority",
"State machine", "Failure and recovery"); contract `ledger/task-28-29-contract.md`; delivery rules
`ledger/review-constraints.md`.

## Check

1. Failpoints: every durable boundary the plan names has a named failpoint on each side that has one; no durable write or
   terminal kill/start happens outside a failpoint (the suite claims it enforces this — try to break it: add an
   unguarded write in a scratch copy and see it caught); arming is impossible in a release and from the wire or config.
2. The fault suite: the invariant is asserted at every step (not only at the end); recovery takes only the action
   `archi handover status` offers; restarts are from disk; gateway loss at the five phases; the stale-cache +
   surrendered-journal split-brain case comes up fenced with the gateway reachable and not.
3. The two defects fixed (1c79bc1d terminal lost after a source crash right after its window was killed; 0d7722d4 the
   source's manifest left forever) — each fix correct, minimal, with its failing case as its test; does anything else
   in the same shape remain (the report names force-owner recovery keeping the close-before-remove order)?
4. The implementer's concerns: archid tests importing `packages/cli/src` (test-only; is it acceptable for the package
   boundary and the build?); one shared disk (fresh-root creation and real rsync not crashed at here); shell terminals
   only; a 150 s test file on the suite's runtime; a terminal restored after bug 1's window comes back without its launch
   flags (F3).
5. Tests fail without their change (revert the two fixes in a scratch copy).

Every shell: `unset -f node npm npx pnpm _load_nvm nvm 2>/dev/null; export PATH="$HOME/.nvm/versions/node/v24.18.0/bin:$PATH";
unset ARCHI_HOME ARCHI_CHAR_ID TMUX TMUX_PANE`; single files as `pnpm test <path>` from the root (the root config isolates
HOME and puts claude/codex doubles on PATH). Run archid, cli and web projects and `pnpm typecheck`.

## Rules

Read-only. Editing, creating, staging or committing any file other than your review file fails the task. Another agent
is running an on-machine check that appends to `m3b-gate-report.md` and `m3b-env.md`; leave them. Never touch
`~/.archipelago`, `~/Library`, `~/.claude`, `~/.claude.json`, `~/.codex`, `~/.ssh`, `/Users/Shared/archi-m3b` or
linus-vault; never run the real claude or codex.

## Report

`docs/fleet-handover/ledger/task-36a-review.md`: verdict (Approved / Needs fixes), findings ranked Critical / Important /
Minor with file:line, evidence and suggested fix, what you verified clean. End your reply with the verdict line and the
finding counts.
