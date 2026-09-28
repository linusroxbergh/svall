# Task 36b — review (brief)

Worktree `/Users/linusroxbergh/linus_laboratory/archipelago/.claude/worktrees/fleet-handover-impl`, branch
`experimental-remote-sessions`, commits 029709e4..174824cc (the diff with 10 lines of context is in
`.superpowers/sdd/plan/review-029709e4..174824cc.diff`). Brief `docs/fleet-handover/ledger/task-36-brief.md` (36b half:
items 2 controller side, 3 and 6); report `task-36b-report.md`; plan Task 36; spec `docs/fleet-handover/spec.md` (binding:
"Ownership authority", "State machine", "Failure and recovery"); contract `ledger/task-28-29-contract.md`; delivery
rules `ledger/review-constraints.md`. 36a's report `task-36a-report.md` says what already existed.

## Check

1. Item 2 controller side: lost, dropped, duplicated, stale (reordered) and partitioned messages at every request the
   controller makes to source, destination and gateway, with the invariant (at most one side can create, input to or
   attach a terminal; before Commit only the source may revive; after Commit only the destination may activate; the
   source never reactivates on its own after Commit) asserted at every step, and recovery through the action
   `archi handover status` offers. Is coverage enforced so a new controller request without a case fails?
2. Item 3: concurrent Begin / Resume / Abort from two controllers on one machine (shared store, lock) and on two
   machines (separate stores, racing at the gateway); duplicate and reordered responses; an unknown Commit response
   queries the authority and never aborts the source (answer lost after the gateway committed and before it did).
3. Item 6: the seeded random order over both fault suites — the seed printed on failure and a rerun reproducible from it.
4. The three product fixes (0a25fb07 rebuilt journal resumes from the daemons' phase; d3efb3b1 setting an unreadable
   journal aside inside `controller.journal`; 23070d66 a cancel during an unanswered Begin keeps the journal and offers
   abort): each correct and minimal, with its failing case as its test (revert each in a scratch copy and see its case
   fail). Anything else of the same shape left?
5. The two test-world moves (c923c2bc, 52ad0d18): behaviour-preserving (same cases, same counts as before the move), no
   third framework.
6. The implementer's concerns, against the spec: two controllers whose Begins meet both drive the same handover (is that
   safe under "Ownership authority", and is a protocol change needed for version 1?); a rebuilt journal has none of the
   user's choices and aborts on the same blockers; an interrupted result can list an abort `status` then refuses;
   prepare does not check the gateway as claim does.

Every shell: `unset -f node npm npx pnpm _load_nvm nvm 2>/dev/null; export PATH="$HOME/.nvm/versions/node/v24.18.0/bin:$PATH";
unset ARCHI_HOME ARCHI_CHAR_ID TMUX TMUX_PANE`; single files as `pnpm test <path>` from the root. The implementer's
report carries the full-suite evidence; rerun only what you need to verify a claim or a mutation.

## Rules

Read-only. Do mutation checks in a scratch copy (`git archive 174824cc` into your scratchpad), never in the worktree.
Editing, creating, staging or committing any file in the worktree other than your review file fails the task. Never
touch `~/.archipelago`, `~/Library`, `~/.claude`, `~/.claude.json`, `~/.codex`, `~/.ssh`, `/Users/Shared/archi-m3b` or
linus-vault; never run the real claude or codex.

## Report

`docs/fleet-handover/ledger/task-36b-review.md`: verdict (Approved / Needs fixes), spec compliance (✅/❌ per item) and
quality, findings ranked Critical / Important / Minor with file:line, evidence and suggested fix, what you verified
clean. End your reply with the verdict line and the finding counts.
