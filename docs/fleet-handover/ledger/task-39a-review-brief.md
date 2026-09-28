# Task 39a — review (brief)

Worktree `/Users/linusroxbergh/linus_laboratory/archipelago/.claude/worktrees/fleet-handover-impl`, branch
`experimental-remote-sessions`. Task 39a's 9 commits are interleaved with Task 38a's; the 39a-only diff with context is
`.superpowers/sdd/plan/review-39a.diff`. Brief `docs/fleet-handover/ledger/task-39-brief.md` (39a part: Do items 1–5 and
the two rulings — the feature gate stays, no first-run self-install); report `task-39a-report.md`; plan Task 39; spec
`docs/fleet-handover/spec.md` (binding); delivery rules `ledger/review-constraints.md`.

## Check

1. Accuracy against the code: every command, flag, path, setting name, code and number the docs and SMOKE give — spot
   check them against the source, and run the cheap ones (`archi … --help` from the checkout under a temp HOME).
   Wrong instructions in recovery docs are Important.
2. Completeness against the spec and the ledger: supported hosts and prerequisites (same home path), what transfers and
   what stays, agent-version support, restart semantics, and the known limitations the ledger names (grep `known
   limitation`, `Task 39 docs`, `sheet wording`).
3. The catalogue (469e5321, 7a83d84e): exhaustive by construction — the test reads the codes from the code, fails on a
   missing one (plant one in a scratch copy, `git archive d2fdceb9`), and its regex reading of type-only unions fails
   loudly rather than silently.
4. Migration and downgrade (8a60fdcb): the recorded downgrade run is real and the restore steps are complete and safe
   (what the older build does with the new release's shim link and the named-fleet plists).
5. Copy in the app (49d1d213): behind `handover.enabled`, accurate, no change to the local-only experience; its tests.
6. README (dee440ba): the corrections the implementer made to lines the branch made false are right.
7. Writing: plain, for a user, describes what the code does now; no history, no revision notes.

Every shell: `unset -f node npm npx pnpm _load_nvm nvm 2>/dev/null; export PATH="$HOME/.nvm/versions/node/v24.18.0/bin:$PATH";
unset ARCHI_HOME ARCHI_CHAR_ID TMUX TMUX_PANE`; single files as `pnpm test <path>` from the root. The report carries the
suite evidence.

## Rules

Read-only. A Task 38a reviewer is working in this worktree too; leave everything alone. Editing, creating, staging or
committing any file in the worktree other than your review file fails the task. Never touch `~/.archipelago`,
`~/Library`, `~/.claude`, `~/.claude.json`, `~/.codex`, `~/.ssh`, `/Users/Shared/archi-m3b` or linus-vault; never run
the real claude or codex.

## Report

`docs/fleet-handover/ledger/task-39a-review.md`: verdict (Approved / Needs fixes), spec compliance per item (✅/❌) and
quality, findings ranked Critical / Important / Minor with file:line, evidence and suggested fix, what you verified
clean. End your reply with the verdict line and the finding counts.
