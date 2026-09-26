# M3b gate fix wave (brief)

Worktree `/Users/linusroxbergh/linus_laboratory/archipelago/.claude/worktrees/fleet-handover-impl`, branch
`experimental-remote-sessions`, BASE = HEAD at dispatch. Spec `docs/fleet-handover/spec.md` is binding; delivery rules
`ledger/review-constraints.md`. Source: `ledger/m3b-gate-report.md` (G1, m1, with logs and file:line). Precedent: M3 Part
C's Codex fix wave (`ledger/m3-onmachine-C-fixes.md`, report `m3-onmachine-C-fixes-report.md`: per-kind activation
readiness, `codex_trust`, the trust notice) — Claude gets the same treatment.

## Items

- **G1 (Important)** Claude 2.1.283 opens `claude --resume` in a folder its config has never trusted on the folder-trust
  prompt ("No, exit" preselected) and sends no SessionStart until answered. The Claude adapter has no `trusts`
  (`sessions/claude.ts`, `sessions/types.ts`), so preflight warns nothing, and activation waits 60 s, closes the window
  and leaves the character dormant with an error. Ruling: mirror Codex — do not write the destination's trust for the
  user.
  1. Claude `trusts(cwd)`: read the destination's Claude config (`~/.claude.json`, or under `CLAUDE_CONFIG_DIR` when set)
     the way Claude 2.1.283 decides whether to ask — find out from the real binary whether a trusted parent folder
     covers a child, and what else suppresses the prompt. Verify on this Mac with a scratch HOME and the real `claude`
     binary in a scratch tmux; if the prompt only shows when logged in, the owner approved copying his keychain Claude
     credential (`security find-generic-password -s "Claude Code-credentials" -w`) into that scratch HOME's
     `~/.claude/.credentials.json` (0600, never printed; check `claudeAiOauth.expiresAt` leaves 90 minutes and finish
     inside it so nothing refreshes; delete it after). Record what you found in the report.
  2. Preflight: a `claude_trust` warning, like `codex_trust`, when the destination's Claude has not trusted a carried
     Claude character's folder, saying what the user will see and do.
  3. Activation: when a Claude pane shows the trust prompt, keep the window, mark the character with the notice (answer
     Claude's trust prompt in its terminal), and do not count it as failed or close it. Notice it early (look at the pane
     while waiting) instead of waiting out the SessionStart deadline. After the user answers, the agent's SessionStart
     must land as the carried session as usual.
  Tests (failing first): `trusts` against config fixtures matching what the real binary does; the preflight warning;
  activation keeping a pane at the prompt with the notice and without the 60 s wait; the SessionStart after it.
- **m1 (Minor)** A refused second archid appends a full stack trace to the running daemon's log (`bin.ts` ~43). The
  refusal goes to the second process's own stderr and exit code only; the running daemon's log is untouched. Test it.

## Rules

Test first; argv-only subprocesses; no `~/.archipelago`, `~/Library`, `~/.claude`, `~/.codex`, `~/.ssh`,
`/Users/Shared/archi-m3b` or linus-vault (the scratch HOME and the approved credential copy above are the only
exceptions); no bare `git stash`; don't rm gitignored build output. Comments only where behaviour is not self-evident,
1–2 lines. Commit subjects one plain sentence, no attribution lines; one commit per item; do not push. Verify with
`pnpm typecheck` and `pnpm vitest run --project protocol --project archid --project cli --project
@archipelago/desktop-web` (every shell: `unset -f node npm npx pnpm _load_nvm nvm 2>/dev/null; export
PATH="$HOME/.nvm/versions/node/v24.18.0/bin:$PATH"; unset ARCHI_HOME ARCHI_CHAR_ID TMUX TMUX_PANE`).

## Report

`ledger/m3b-fixes-report.md` (uncommitted): what the real Claude does about trust, per item what changed, failing-first
evidence, verification counts, concerns. End your reply with one status line and the commit range and counts.
