# Task 41a fix round 1 (findings)

Worktree `/Users/linusroxbergh/linus_laboratory/archipelago/.claude/worktrees/fleet-handover-impl`, branch
`experimental-remote-sessions`, FIX_BASE = HEAD at dispatch. The task: `ledger/task-41-brief.md` (41a half), its report
`ledger/task-41a-report.md`, the review with file:line and evidence `ledger/task-41a-review.md`. Spec
`docs/fleet-handover/spec.md` is binding; delivery rules `ledger/review-constraints.md`.

## Items

- **I1 (Important)** Preflight demands a writable parent for every carried folder outside the home, even one that already
  holds its replica (`packages/cli/src/controller/handover.ts` around 854), so a folder directly under a root-owned
  folder (`/Volumes/work`, `/opt/x`) goes out once and can never return. Demand a writable parent only for folders the
  handover will create (absent, or archived); a folder with a matching replica needs only itself writable. Test: the
  return trip of such a folder passes preflight; a new folder under a read-only parent still blocks.
- **M1** The home check trusts the registry. Make the destination refuse a claim whose `manifest.home` is not its own home
  (fail closed, `home_mismatch`), and have `host doctor` report a registry home that differs from the machine's. Keep
  the preflight check as it is.
- **M2** The parent check runs at preflight only, and claim `mkdir -p`s the parent (`replicas.ts` around 368). A claim for a
  folder outside the home whose parent is missing blocks `parent_missing` instead of creating it.
- **M3** The preflight `home_mismatch` message also names the next step after making the account: `archi host remove
  <name>`, then `archi host add` at the new account.
- **M4** `handover.test.ts` around 711 asserts `destinationPath === sourcePath`, which its own fixture sets; assert it on
  what the code produced instead, or drop that assertion.
- **M5** Remove the history-narrating comment in `server.test.ts` around 203; `host.test.ts` must not use a literal
  `/home/linus` as the "other" home (a runner whose home is that path fails) — derive one that differs from
  `os.homedir()`.

## Rules

Test first for I1, M1, M2 and M3, each failing before its fix. Every shell: `unset -f node npm npx pnpm _load_nvm nvm
2>/dev/null; export PATH="$HOME/.nvm/versions/node/v24.18.0/bin:$PATH"; unset ARCHI_HOME ARCHI_CHAR_ID TMUX TMUX_PANE`;
single files as `pnpm test <path>` from the root. Verify with `pnpm typecheck` and `pnpm vitest run --project protocol
--project archid --project cli`. No `~/.archipelago`, `~/Library`, `~/.claude`, `~/.codex`, `~/.ssh`,
`/Users/Shared/archi-m3b` or linus-vault; no bare `git stash`; don't rm gitignored build output. Comments only where
behaviour is not self-evident, 1–2 lines, describing what the code does now. Commit subjects one plain sentence, no
attribution lines; one commit per item or closely related pair; do not push.

## Report

`ledger/task-41a-fix1-report.md` (uncommitted): per item what changed, failing-first evidence, verification counts,
concerns. End your reply with one status line: DONE, DONE_WITH_CONCERNS, BLOCKED or NEEDS_CONTEXT, the commit range and
the counts.
