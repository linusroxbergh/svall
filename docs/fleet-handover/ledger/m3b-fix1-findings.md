# M3b fix wave, round 1 (findings)

From `ledger/m3b-fixes-review.md` (file:line and evidence there) on the wave `ledger/m3b-fixes.md` /
`m3b-fixes-report.md` (read the report's account of what the real Claude 2.1.283 does; its probe scripts are in the
session scratchpad under `g1/`). FIX_BASE = HEAD at dispatch. Rules as `m3b-fixes.md`, including its one credential
exception; report `ledger/m3b-fix1-report.md` (uncommitted).

- **C1 (Critical)** `packages/archid/test/handover/sessions.test.ts` ~195-216 writes to the real `~/.claude` and
  `~/.claude.json` and ends with a recursive `rmSync` of both, when run outside the root vitest config (only
  `test/isolate.ts` moves HOME). Make the test own its HOME (`vi.stubEnv('HOME', <temp dir>)` or pass the config path in)
  so it can never touch the real home, whatever runner starts it. Grep the branch's other tests for any write or rm
  under `os.homedir()`/`$HOME` without such a guard and fix those the same way; list them in the report.
- **R1 (m-a, promoted)** "No, exit" is preselected on Claude's trust prompt; taking it leaves the character a plain shell
  with no agent, no revive and no error (before this wave the slot stayed dormant and revivable). Keep watching a slot
  counted up at a prompt until its SessionStart arrives; if the agent exits first, leave it dormant with its carried
  revive command and a visible error.
- **R2 (item 4)** Ruling: a Claude still running in its pane but silent after about 10 s counts as up — its window stays
  with a notice to answer the prompt in its terminal (R1's watch applies); one that exits or never comes up is left
  dormant with its error, as now. This covers the unapproved project MCP server prompt, the bypass-permissions warning,
  parent-only trust with project permissions, and a second terminal in another checkout. The trusted-folder
  SessionStart wait no longer runs 60 s against a live agent.
- **R3 (item 4)** One preflight warning, `claude_bypass`, when a carried Claude's resume carries
  `--dangerously-skip-permissions` and the destination's Claude has not accepted bypass mode — confirm on the real binary
  what gates the warning (`bypassPermissionsModeAccepted` plus whatever else its bundled JS checks) before coding, and
  say what you found.
- **R4 (m-b)** Compare folder paths the way Claude 2.1.283 does (NFC-normalised), so a decomposed å/ä/ö folder name
  gets no false `claude_trust` warning.

Test first for every item; C1's test must show the real HOME untouched when HOME is not moved by the runner.
