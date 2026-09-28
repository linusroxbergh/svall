# Task 38a — review (brief)

Worktree `/Users/linusroxbergh/linus_laboratory/archipelago/.claude/worktrees/fleet-handover-impl`, branch
`experimental-remote-sessions`. Task 38a's 13 commits are interleaved with Task 39a's docs commits; the 38a-only diff
with context is `.superpowers/sdd/plan/review-38a.diff` (commit list, stats, then each commit). Brief
`docs/fleet-handover/ledger/task-38-brief.md` (38a part: Do items 1–4 and 8–9 and the carried 38a items); report
`task-38a-report.md`; the new `docs/security/fleet-handover.md`; plan Task 38; spec `docs/fleet-handover/spec.md` (release
signing and verification, "Ownership authority", "Failure and recovery", what transfers and what stays); delivery
rules `ledger/review-constraints.md`.

## Check

1. m6 (53051df9): the far machine verifies the new release against the *installed* release's pinned signers with system
   tools before anything from the upload runs — try to make staged code run first, a signature by an unpinned key pass,
   or a digest mismatch slip through; `--allow-unsigned` and the no-pinned-key fallback say what they checked.
2. The threat model (item 1): SSH aliases (69c0c268's machine check; option injection through host or user names; a
   `ProxyCommand`), remote argv, malicious file names, symlinks, stale authority, destination-path confusion — each
   either tested or accepted in the doc with a sound reason. Judge the three accepted risks (gateway calls not checking
   the gateway's machine id; a root swapped for a symlink mid-transfer; another account squatting the Linux daemon's
   lock name) against the spec: acceptable for version 1, or a must-fix?
3. Secrets (item 2): each channel (argv, logs, NDJSON, state, manifests, repository roots) has a test that would fail if
   a secret leaked there; 89a8ec19's preflight block of agent logins and `~/.ssh` is correct and complete on both
   machines (what about `~/.codex/auth.json` under a root, `~/.config/gh`, a `.netrc`?).
4. Destructive sites (item 3): the doc's table lists every delete/rename/archive call site in the handover and host
   code, each traced to its authorising record and a test proving an unauthorised target is refused — look for sites
   the table misses.
5. Licences (item 8): every archive and the app carry the notices; the build check fails on an unlicensed component
   (3bf64226, 264d3c99); c9387b13's optional-module fix. The implementer's three licence items for the owner — are they
   described accurately?
6. Permissions and uninstall (item 9, 562b562b, 3e920585), and the carried install items (b5c162af, 730a1c4f,
   e3e67b2e): correct, minimal, test-first.

Every shell: `unset -f node npm npx pnpm _load_nvm nvm 2>/dev/null; export PATH="$HOME/.nvm/versions/node/v24.18.0/bin:$PATH";
unset ARCHI_HOME ARCHI_CHAR_ID TMUX TMUX_PANE`; single files as `pnpm test <path>` from the root. The report carries the
suite evidence; rerun what you need to verify a claim. Mutations only in a scratch copy (`git archive 4c671f4d`).

## Rules

Read-only. Another agent (Task 39a) is committing docs in this worktree; leave its files alone. Editing, creating,
staging or committing any file in the worktree other than your review file fails the task. Never touch
`~/.archipelago`, `~/Library`, `~/.claude`, `~/.claude.json`, `~/.codex`, `~/.ssh`, `/Users/Shared/archi-m3b` or
linus-vault; never run the real claude or codex.

## Report

`docs/fleet-handover/ledger/task-38a-review.md`: verdict (Approved / Needs fixes), spec compliance per item (✅/❌) and
quality, findings ranked Critical / Important / Minor with file:line, evidence and suggested fix, what you verified
clean. End your reply with the verdict line and the finding counts.
