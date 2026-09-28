# Task 37a — review (brief)

Worktree `/Users/linusroxbergh/linus_laboratory/archipelago/.claude/worktrees/fleet-handover-impl`, branch
`experimental-remote-sessions`, commits a1dd62b4..da059e2a (diff with context, ledger commits mixed in:
`.superpowers/sdd/plan/review-2feff6f6..da059e2a.diff`). Brief `docs/fleet-handover/ledger/task-37-brief.md` (37a part:
Do items 1, 2, 6 and 7, and its rulings); report `task-37a-report.md`; plan Task 37; spec `docs/fleet-handover/spec.md`
("Verification", "Failure and recovery", "Ownership authority"); delivery rules `ledger/review-constraints.md`.

## Check

1. The harness proves what it claims: each handover's assertions (manifest, worktree HEAD/branch/index/stash/working
   changes, state, ownership on both sides and the gateway, agent resumed under its session id) actually compare
   against the source's pre-move truth, and fail when the product is wrong (the report names two deliberately broken
   builds; is that enough, and would a lost stash or index change be caught?).
2. The fault scenarios: the controller killed and the link dropped at representative pre- and post-commit boundaries in
   both directions; recovery takes only the action `archi handover status` offers; after pre-commit faults only the
   source revives, after post-commit only the destination activates, and the source never reactivates. Is any
   assertion vacuous (e.g. passes when nothing ran)?
3. Script quality: argv-safe quoting, cleanup of containers/networks/volumes on success and failure, no host secrets or
   home paths mounted or logged, deterministic waits (no sleeps that hide races), runnable the same way on a runner.
4. `ci.yml`: the integration job and the rsync build + `ARCHI_REQUIRE_RSYNC` in the test job; trigger unchanged; the
   require flag really turns a skip into a failure (a1dd62b4).
5. `docs/integration.md`: accurate against the scripts, says what CI cannot run here.
6. The implementer's concerns, against the spec: no x86-64 run locally (qemu user-mode shows every process as
   `qemu-x86_64`); a killed controller leaves its ssh control master until the link drops; a dropped link takes 49–108 s
   before the controller gives up; remote → local with the link dropped right after Commit leaves the fleet running
   nowhere until the gateway is reachable; a resume can overlap an activation the killed controller started (is that
   serialized on the destination, or only lucky in 4 runs?).

Every shell: `unset -f node npm npx pnpm _load_nvm nvm 2>/dev/null; export PATH="$HOME/.nvm/versions/node/v24.18.0/bin:$PATH";
unset ARCHI_HOME ARCHI_CHAR_ID TMUX TMUX_PANE`. The implementer's report carries the run evidence (a full run is ~13
min); rerun a scenario only to verify a claim. If you run docker, use colima (start it if stopped, stop it after, set
the docker context back to `desktop-linux`) and build from a `git archive da059e2a` snapshot in your scratchpad.

## Rules

Read-only. Editing, creating, staging or committing any file in the worktree other than your review file fails the
task. Never touch `~/.archipelago`, `~/Library`, `~/.claude`, `~/.claude.json`, `~/.codex`, `~/.ssh`,
`/Users/Shared/archi-m3b` or linus-vault; never run the real claude or codex.

## Report

`docs/fleet-handover/ledger/task-37a-review.md`: verdict (Approved / Needs fixes), spec compliance per item (✅/❌) and
quality, findings ranked Critical / Important / Minor with file:line, evidence and suggested fix, what you verified
clean. End your reply with the verdict line and the finding counts.
