# M3b fix wave — review (brief)

Worktree `/Users/linusroxbergh/linus_laboratory/archipelago/.claude/worktrees/fleet-handover-impl`, branch
`experimental-remote-sessions`, commits 7bfb1666..1a07a72c. Brief `docs/fleet-handover/ledger/m3b-fixes.md`; report
`m3b-fixes-report.md` (what the real Claude 2.1.283 does about trust, 15 cross-checked cases); gate report
`m3b-gate-report.md`; the Codex precedent `m3-onmachine-C-fixes.md` / `-report.md`; spec `docs/fleet-handover/spec.md`
(binding: "Agent sessions", "Preflight blockers", "Resting characters", "Failure and recovery"); delivery rules
`ledger/review-constraints.md`.

## Check

1. G1: Claude `trusts` matches what the report says the real binary does (checkout top, parents only up to the checkout,
   real-path keys, `CLAUDE_CONFIG_DIR`, legacy `.config.json`); the `claude_trust` preflight warning; activation keeps a
   pane at the prompt with the notice after ~3 s instead of 60 s, and the SessionStart after the answer binds the
   carried session; a trusted folder keeps the SessionStart wait. The inspect answer's new `{kind, cwd}` shape within
   protocol 17 — safe given the exact-release rule?
2. m1: a refused second archid leaves the running daemon's log untouched.
3. Tests fail without their change (revert in a scratch copy); nothing wider than the items.
4. The implementer's three confirmed prompts that still stall activation 60 s and leave the character dormant: an
   unapproved project `.mcp.json` server, the bypass-permissions warning for a resume carrying
   `--dangerously-skip-permissions` (F3 keeps that flag), and parent-only trust with project permissions. Recommend
   the fix: a general activation rule (an agent process alive in its pane but silent at the deadline keeps its window
   with a notice to answer it there, rather than closing it dormant) and/or specific preflight warnings from the
   destination's Claude config (bypass acceptance, MCP approvals). Say which the spec's "remain dormant with their
   transcript and a visible error" allows, and what the Codex path does today in the same situation.

Every shell: `unset -f node npm npx pnpm _load_nvm nvm 2>/dev/null; export PATH="$HOME/.nvm/versions/node/v24.18.0/bin:$PATH";
unset ARCHI_HOME ARCHI_CHAR_ID TMUX TMUX_PANE`; single files as `pnpm test <path>` from the root. Run protocol, archid,
cli and web projects and `pnpm typecheck`.

## Rules

Read-only. Editing, creating, staging or committing any file other than your review file fails the task. Never touch
`~/.archipelago`, `~/Library`, `~/.claude`, `~/.claude.json`, `~/.codex`, `~/.ssh`, `/Users/Shared/archi-m3b` or
linus-vault. Never run the real `claude` or `codex`.

## Report

`docs/fleet-handover/ledger/m3b-fixes-review.md`: verdict (Approved / Needs fixes), findings ranked Critical / Important /
Minor with file:line, evidence and suggested fix, your recommendation for item 4, what you verified clean. End your reply
with the verdict line and the finding counts.
