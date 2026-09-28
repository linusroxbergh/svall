# Task 38b — review (brief)

Worktree `/Users/linusroxbergh/linus_laboratory/archipelago/.claude/worktrees/fleet-handover-impl`, branch
`experimental-remote-sessions`. Task 38b's 11 commits are interleaved with Task 38a's fix commits; the 38b-only diff
with context is `.superpowers/sdd/plan/review-38b.diff`. Brief `docs/fleet-handover/ledger/task-38-brief.md` (38b part:
Do items 5–7 and the carried 38b items); report `task-38b-report.md`; the "Performance and limits" section of
`docs/security/fleet-handover.md`; plan Task 38; spec `docs/fleet-handover/spec.md` (binding); delivery rules
`ledger/review-constraints.md`.

## Check

1. The benchmark (429739a2, `scripts/bench/`): measures what the brief asks (first and incremental on small,
   large-file and ≥50k-file repositories; wall time, peak RSS per process, hashing memory, event count/volume, largest
   RPC message), records power and IO-stall state, and reruns as the doc says. Are the doc's numbers the script's
   output, and are void runs excluded honestly?
2. Each performance fix is correct and changes no behaviour a handover depends on: the dangling-link lookup (84532f80),
   streamed session hashing (c579374c), eight-at-once hashing listed in path order (0145948c — is the manifest still
   deterministic?), terminal backpressure (391ab4d4, f8981dd8 — a slow viewer never blocks others or loses output
   silently; the resync is correct), the collision blocker's bounded list (15181f00). Protocol stays 17; the fault
   suites and the integration run stay green.
3. The bound tests (f5340ba1, b4a6e8ef, d2373a47) fail when the bound is exceeded (mutate in a scratch copy,
   `git archive 09a23137`).
4. The carried items judged acceptable (surfaces past sshd's MaxSessions, double hashing at preflight and claim,
   unrecorded folders and modes) — sound reasons? And the implementer's concern that memory is the real ceiling (about
   5 KB per file at peak in a daemon, so the 128 MiB manifest cap implies several GB): is there a bound that refuses a
   handover before a daemon runs out of memory, and should there be one before version 1?

Every shell: `unset -f node npm npx pnpm _load_nvm nvm 2>/dev/null; export PATH="$HOME/.nvm/versions/node/v24.18.0/bin:$PATH";
unset ARCHI_HOME ARCHI_CHAR_ID TMUX TMUX_PANE`; single files as `pnpm test <path>` from the root. The report carries the
benchmark and suite evidence; rerun only what a claim needs. If you use docker: colima's default profile — another
reviewer may be using it; start it only if stopped, `docker ps` before stopping it, never remove containers you did not
start, and set the docker context back to `desktop-linux`.

## Rules

Read-only. Editing, creating, staging or committing any file in the worktree other than your review file fails the
task. Never touch `~/.archipelago`, `~/Library`, `~/.claude`, `~/.claude.json`, `~/.codex`, `~/.ssh`,
`/Users/Shared/archi-m3b` or linus-vault; never run the real claude or codex.

## Report

`docs/fleet-handover/ledger/task-38b-review.md`: verdict (Approved / Needs fixes), spec compliance per item (✅/❌) and
quality, findings ranked Critical / Important / Minor with file:line, evidence and suggested fix, what you verified
clean. End your reply with the verdict line and the finding counts.
