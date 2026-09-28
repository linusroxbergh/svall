# Task 37b — review (brief)

Worktree `/Users/linusroxbergh/linus_laboratory/archipelago/.claude/worktrees/fleet-handover-impl`, branch
`experimental-remote-sessions`, commits 0d85957b..ac94cf15 (701b5b93 in the range is a ledger entry; diff with context:
`.superpowers/sdd/plan/review-2bd314ad..ac94cf15.diff`). Brief `docs/fleet-handover/ledger/task-37-brief.md` (37b part:
Do items 3, 4, 5 and 7, and its rulings); report `task-37b-report.md`; 37a's review `task-37a-review.md` (M1–M6, fixed
here); plan Task 37; spec `docs/fleet-handover/spec.md` (release/companion signing and verification, "Verification");
delivery rules `ledger/review-constraints.md`.

## Check

1. 37a's M1–M6: each fixed as the review asked (read each finding in `task-37a-review.md`).
2. Fresh install (item 3): a clean Ubuntu 24.04 per architecture with no Node or checkout on PATH, provisioned through
   the controller release tree (`build-controller.mjs` output) as a user would; systemd units (archid, gateway, linger)
   verified running; `host upgrade` to a second build and `setup --rollback` back, with the rollback proven to reach
   every service (2431ce5f).
3. The scans (item 4): `scripts/release-scan.mjs` catches secrets, developer paths and checkout dependencies in every
   archive (planted hits fail it; is anything it should catch missed — e.g. a path inside a binary, a `.map` file, a
   credential file name?); no user credential reaches an artifact or log the jobs upload.
4. `release.yml` (item 5): upload `needs:` every build, integration and fresh-install job; signs with `ssh-keygen -Y
   sign` only when its secret is present, else a dry run that uploads nothing; the secret never reaches a log, argv
   shown in a log, or an artifact; permissions minimal; tags and triggers sensible. `actionlint` clean.
5. The three product fixes (a2dfadad rsync build paths stripped; 7aa2afca `host add` listing lingering twice; 2431ce5f
   rollback leaving the gateway on the newer release): each correct, minimal, with its failing test or run first.
6. The implementer's concerns: the gateway crash-loops (EINVAL) when the home path is over ~60 bytes and nothing names
   the cause — how does this reach a user (a Linux account whose home matches a long Mac home path), and should
   `host add` preflight refuse it with a named cause before version 1?; what only a real runner can prove; the first
   signed tag needing the key's public half in `allowed_signers`.
7. `docs/integration.md` accurate against the scripts.

Every shell: `unset -f node npm npx pnpm _load_nvm nvm 2>/dev/null; export PATH="$HOME/.nvm/versions/node/v24.18.0/bin:$PATH";
unset ARCHI_HOME ARCHI_CHAR_ID TMUX TMUX_PANE`. The implementer's report carries the run evidence (the x86-64 runs take
~40 min under emulation); rerun only to verify a claim — the scan and unit tests are cheap. If you run docker, use
colima's default profile (start if stopped, stop after, docker context back to `desktop-linux`) and build from a
`git archive ac94cf15` snapshot in your scratchpad.

## Rules

Read-only. Editing, creating, staging or committing any file in the worktree other than your review file fails the
task. Never touch `~/.archipelago`, `~/Library`, `~/.claude`, `~/.claude.json`, `~/.codex`, `~/.ssh`,
`/Users/Shared/archi-m3b` or linus-vault; never run the real claude or codex.

## Report

`docs/fleet-handover/ledger/task-37b-review.md`: verdict (Approved / Needs fixes), spec compliance per item (✅/❌) and
quality, findings ranked Critical / Important / Minor with file:line, evidence and suggested fix, what you verified
clean. End your reply with the verdict line and the finding counts.
