# PR #2: bring it up to main and get it mergeable

PR: https://github.com/linusroxbergh/svall/pull/2 (branch `worktree-port-pr-1`, head f8938750, draft).
It conflicts with main (185 commits behind, 29 conflicting files) and cannot merge.

## Done looks like

- `origin/main` merged into `worktree-port-pr-1`, conflicts resolved keeping both sides' behaviour, pushed
  without force. GitHub reports the PR `MERGEABLE`.
- Every check below passes at the pushed head.
- The PR description regenerated from the final diff.
- A report to the owner: head SHA, results, and anything left. Leave draft status and the merge to the owner.

## How

- Work in `/Users/linusroxbergh/linus_laboratory/svall/.claude/worktrees/port-pr-1`. No agent is in it. It is
  17 commits behind origin: `git pull --ff-only` first.
- Merge, do not rebase: the branch already holds two merges of main, so a rebase replays ~140 commits and
  re-resolves old conflicts, and needs a force push.
- Read `docs/fleet-handover/README.md` (pick-up guide, testing notes) first. `docs/fleet-handover/spec.md` is
  binding. Delegate conflict areas (web, svalld, Swift, protocol) to sub-agents on Opus 5.5 where it helps,
  then have a fresh Opus 5.5 reviewer check the merge resolution against both parents before pushing.
- Fetch again before pushing; if main moved, merge again.

## Known traps

- **Protocol collision.** Base ccdeaa17 had `PROTOCOL_VERSION = 20`. Main went to 21 for robots (f3848bd5);
  the PR went to 21 for handover. After the merge the protocol is 22, and every test, doc and message that
  names the handover protocol says 22.
- **State schema.** Main is still v8 but added fields since the base (a character's robot, among others). The
  PR's v9 schema and its v8→v9 migration must carry every field main's v8 has; add a migration test with a
  main-shaped v8 state if none covers it.
- `test/desktop-install.test.ts` fails 2 tests on main too (this Mac's Homebrew node is built `--shared`;
  copying `process.execPath` loses libnode). Not this work.
- Load flakes are listed in the README; rerun them alone before calling one a failure.
- Playwright's default port 5183 may be held by another worktree; use a scratch config on a free port.

## Checks

`unset SVALL_HOME SVALL_CHAR_ID TMUX` first. Then `pnpm typecheck`, vitest for every project, `pnpm test:faults`,
Playwright, `swift test --package-path apps/desktop/mac`, and the container harness per `docs/integration.md`
(`scripts/integration/fresh-install.sh` on arm64 and x86-64, `scripts/integration/fleet-handover.sh`). Afterwards
stop colima and set the docker context back to `desktop-linux`.

## Rules

- Never touch the real `~/.svall`, LaunchAgents, `/Applications` or `~/.ssh`.
- Behaviour fixes are test-first. Subprocesses are argv-only. Docs in present tense, no history.
- Commit subjects are one sentence; no Claude attribution in commits or the PR.
- PR description: TL;DR (≤2 sentences) → what changes for users → reviewer notes (≤3 bullets) →
  verification (one line). Max ~600 words, final state only, regenerated not appended. Update with `gh pr edit 2`.
- Ledger every dispatch, Ruling and push in
  `/Users/linusroxbergh/linus_laboratory/svall/.claude/worktrees/fleet-handover-impl/docs/fleet-handover/ledger/progress.md`.
- Ask the owner before anything on linus-vault or the Mac keychain.
