# Task 41 — require the same home path and copy what the fleet records unchanged (brief)

Plan: `docs/fleet-handover/plan.md` Task 41. Spec (`docs/fleet-handover/spec.md`) is binding, in particular
"Supported environment", "Stable identities", "Add Machine flow" step 2, "Same paths", "Transfer inventory",
"Git repository graphs", "Agent sessions", "Preflight blockers". Delivery rules:
`docs/fleet-handover/ledger/review-constraints.md`. Worktree
`/Users/linusroxbergh/linus_laboratory/archipelago/.claude/worktrees/fleet-handover-impl`, branch
`experimental-remote-sessions`.

The probe (plan step 1) ran before this dispatch and passed both ways for Claude and Codex; its result is in
`ledger/task-41-probe-report.md`. Do not re-run it. Since this brief was drafted the branch was rebased onto newer main
and Task 40's fix wave landed (`ledger/task-40-rebase2-report.md`, `task-40-fixes.md`, `task-40-fix1-findings.md`): keep
what they established, in particular F3 (a revive keeps the launch flags an idle close keeps, less Codex
`-p`/`--profile`/`--local-provider`).

Task 41 is split in two, each its own implementer and review. Your dispatch names which half is yours.

## 41a — same home path, no path roots, real-path roots

1. Add Machine and preflight block when the destination's home differs from the source's. The message names the
   commands that make an account whose home matches (`sudo useradd -m -d <home> <user>`, or `sudo usermod -d <home>
   -m <user>` for an existing account). A transfer root outside home needs its parent present on the destination;
   preflight blocks otherwise. Give each a blocker code and user-facing text in the style of the existing ones.
2. Remove named path roots: `pathRoots` in the controller registry and machine records, `{ root, relative }` portable
   paths, the classifier that maps them, and the state path rewrite. State paths travel as they are. The machine
   record keeps `home` (spec "Stable identities"). Registry and protocol schemas must still load a
   `machines.json` or wire record written by the current build: drop the old field on read rather than fail.
3. Record and copy each transfer root at its real path. A character cwd whose real path differs from the recorded
   one blocks (spec "Same paths"), with a message naming both paths. `home.cwd`, context refs and non-repository roots
   follow the same rule.
4. Everything the removed rewrite fed — replica record keys, transcript placement (the O5/O7 real-path slug logic),
   manifest fields, the controller's `paths.ts`/`reach.ts` — uses the recorded absolute path directly.

Tests (write each failing first): a destination with a different home blocks at Add Machine and at preflight; a root
outside home with no parent on the destination blocks; a symlinked cwd blocks; an old `machines.json` with
`pathRoots` still loads; a round trip through the fake-dependency controller tests with identical homes carries every
path unchanged.

## 41b — Git and sessions copy unchanged

1. Git import: remove registrations not listed in the manifest from the destination copy without removing their
   branch refs, then validate (`git worktree list`, `git status`, staged changes against the manifest). Remove the
   gitfile rewrite and the `git worktree repair` step; delete `packages/archid/src/handover/git-repair.ts` and its
   test. Never run `git worktree prune` or `repair`. Keep what O6 (uncarried worktrees keep their registration on
   their own machine) and O8 (ignorecase/precomposeunicode re-probe) established where still meaningful.
2. Session adapters copy files byte for byte: remove path rewriting, the record and attachment type lists, and the
   version maximum. Keep file discovery (session JSONL plus its session-specific sidecars and subagent data for
   Claude; the rollout for Codex), a minimum version and the missing-file blocker. `agent.transcriptPath` on the
   destination is the same absolute path. The Mac's Claude 2.1.283 must pass preflight. Main now has an adapter per
   agent CLI with its binary, version floor and login probe (`eb849cb6`; the rebase2 report lists where the session
   adapters could share it): take the minimum from there rather than keeping a second floor, if that fits.

Tests (write each failing first): the Task 3 worktree fixture validates on the destination without repair; the
Claude and Codex fixtures resume after an unchanged copy (the fixture checks that exist today, minus the rewrite); a
session written by a CLI newer than every fixture is accepted; an unlisted registration is removed but its branch ref
stays.

## Both halves

- Delete what the change makes dead (types, helpers, tests, protocol fields, docs comments). No compatibility shims
  beyond reading an old registry/wire record.
- Protocol changes stay under `PROTOCOL_VERSION` 15 (one bump per release; this branch already took it).
- User-facing text in the web UI (host setup, handover sheet) that mentions path roots goes too.
- Verify: `pnpm vitest run --project protocol --project archid --project cli`, `pnpm vitest run --project
  @archipelago/desktop-web` if the web UI changed, `pnpm typecheck`. Known load flakes are listed in
  `docs/fleet-handover/README.md`; rerun them alone.
- Every shell: `unset -f node npm npx pnpm _load_nvm nvm 2>/dev/null; export
  PATH="$HOME/.nvm/versions/node/v24.18.0/bin:$PATH"; unset ARCHI_HOME ARCHI_CHAR_ID TMUX TMUX_PANE`. Single test
  files as `pnpm test <path>` from the root.
- Rules: test first; argv-only subprocesses; no `~/.archipelago`, `~/Library`, `~/.claude`, `~/.codex`, `~/.ssh` or
  linus-vault; no bare `git stash`; don't rm gitignored build output. Comments only where behaviour is not
  self-evident, 1–2 lines, describing what the code does now. Commit subjects: one plain sentence, repository style,
  no attribution lines. Commit as you go; do not push.

## Report

`docs/fleet-handover/ledger/task-41a-report.md` or `task-41b-report.md` (uncommitted): what changed per step, tests
added (with the failing-first evidence), anything deleted, verification counts, concerns. End your reply with one
status line: DONE, DONE_WITH_CONCERNS, BLOCKED or NEEDS_CONTEXT, the commit range, and the counts.
