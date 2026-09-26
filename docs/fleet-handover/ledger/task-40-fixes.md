# Task 40 fix wave (brief)

Worktree `/Users/linusroxbergh/linus_laboratory/archipelago/.claude/worktrees/fleet-handover-impl`, branch
`experimental-remote-sessions`. Spec `docs/fleet-handover/spec.md` is binding; delivery rules
`docs/fleet-handover/ledger/review-constraints.md`. Sources: the rebase review
`ledger/task-40-rebase-review.md` (M1–M7, with file:line and evidence) and the smoke report
`ledger/task-40-smoke-report.md` (D1–D5 and its notes; F8–F12). The branch was rebased again onto
current main (ledger/task-40-rebase2-report.md) before this wave.

## Items

- **F1 (M1)** A dormant second terminal must not travel with a revive command and no session. Keep a revive only when
  the slot still has an agent; extend main's dormant-SessionEnd guard (`fleet.ts`, "a dormant character keeps the
  agent its revive resumes") to the second slot, so a closed second terminal keeps its agent and its transcript
  travels.
- **F2 (M2)** Strip `agent.pid` and `second.agent.pid` in `exportSnapshot` (spec "Terminal records": agent pid fields
  are removed before export), and assert it in the forbidden-field test. Main's idle close SIGKILLs a stale pid, so a
  carried pid can kill an unrelated process on the destination.
- **F3 (M3 + rest flags)** Launch flags. Ruling: a terminal resumes after a handover with the launch flags main keeps
  for an idle-closed one (`dormancy.ts` `FLAGS`), whether the handover rested it or it was already dormant, minus
  flags whose values name machine-local agent config (Codex `-p`/`--profile`, `--local-provider`). Make the rest
  build its revive the same way the idle close does, and filter the machine-local flags at import. Amend the spec's
  "Terminal records" line to say so, in one sentence.
- **F4 (M4)** `attachSlot` keeps the previous `second.cwd` when tmux reports an empty path (`w.path || slot?.cwd`), as
  the rest and main's poll already do.
- **F5 (M5)** `archi doctor`'s config check fails for the two layouts the daemon refuses (a config.json beside
  fleet.json; a config.json with config.json.bak in the way). One pure helper in `config.ts` that both call.
- **F6 (M6)** Doctor's `daemon path` check reads the plist's first `ProgramArguments` entry, checks it exists, and
  says "its program is there" — so a release install is checked too.
- **F7 (M7)** The tests M7 lists: kept revive for the second slot and the agentless case; `toThrow(InvalidConfig)` for
  both refusals; `plistCurrent`/`shimsCurrent`/`setup --check --release` for a release; a selectors test for
  `resumeErrorOf` (flag off → undefined; a slot with a window → undefined; a dormant slot with the flag on → the
  error).

- **F8 (D1, Critical)** Ubuntu 24.04's tmux 3.4 prints the `\x1f`/`\x1e` separators of `listWindows`
  (`packages/archid/src/tmux/tmux.ts`) as the text `\037`/`\036`, so the Linux daemon parses no window. Make every
  tmux format the daemon parses work on tmux 3.4 and on the Mac's 3.7c, for names holding tabs or odd bytes too
  (grep every `-F` format). Unit tests on both output shapes, plus one run against a real tmux 3.4 in an
  `ubuntu:24.04` container (`docker` via colima; start colima if stopped and say so) — record the command and output.
- **F9 (D2, Important)** `scripts/release-stage.mjs` stages `packages/archid/agent-profiles` into the release beside
  `hooks`, `home` and `systemd`, so a release install seeds main's bundled profiles. A release-stage test lists it.
- **F10 (D3)** A listing row without a window name (or that fails to parse) is never adopted as a character
  (`reconcile.ts`), and nothing persists a character without the fields the schema requires.
- **F11 (D4)** `host add`'s claude/codex probes run with the PATH the unit and `host doctor` use (O10), so a CLI in
  `~/.local/bin` is found. Align with main's per-CLI adapters (binary, version floor, login probe) where they now
  exist.
- **F12** The release and companion name must not come from an unrelated tag: `git describe --tags` now meets main's
  `ghostty-kit` tag and names every build `ghostty-kit-N-g<sha>`. Name releases the way the release manifest expects
  (commit-based when no release tag matches), with a test.

## Rules

Test first for every behaviour change (F1–F6), each test failing before its fix. Every shell: `unset -f node npm npx
pnpm _load_nvm nvm 2>/dev/null; export PATH="$HOME/.nvm/versions/node/v24.18.0/bin:$PATH"; unset ARCHI_HOME
ARCHI_CHAR_ID TMUX TMUX_PANE`; single files as `pnpm test <path>` from the root. Verify with `pnpm typecheck` and
`pnpm vitest run --project protocol --project archid --project cli --project @archipelago/desktop-web`. No
`~/.archipelago`, `~/Library`, `~/.claude`, `~/.codex`, `~/.ssh` or linus-vault; no bare `git stash`; don't rm
gitignored build output. Comments only where behaviour is not self-evident, 1–2 lines. Commit subjects: one plain
sentence, repository style, no attribution lines. One commit per item or per closely related pair; do not push.

## Report

`ledger/task-40-fixes-report.md` (uncommitted): per item what changed, the failing-first evidence, verification
counts, concerns. End your reply with one status line: DONE, DONE_WITH_CONCERNS, BLOCKED or NEEDS_CONTEXT, the commit
range, and the counts.
