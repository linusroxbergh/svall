# M3b fix wave, round 2 (findings)

From `ledger/m3b-fixes-review.md` "## Fix round 1" (file:line and evidence there). FIX_BASE = HEAD at dispatch. Rules as
`m3b-fixes.md`; report `ledger/m3b-fix2-report.md` (uncommitted).

- **I1 (Important)** C1's guard test runs a child vitest with `CI: '1'`, which turns colours on and breaks its "1 passed"
  match; it passes only where vitest detects an agent (`CLAUDECODE`/`AI_AGENT`), so the owner's own `pnpm test` in a
  terminal goes red. Give the child `NO_COLOR: '1'` (and check the match holds with neither agent variable set: run it
  with both unset).
- **I2 (Important, pre-existing)** The suite runs whatever `claude` and `codex` are on PATH — here the owner's real ones:
  `ownership.test.ts` starts real daemons that run `claude --version`, `claude auth status`, `codex --version`,
  `codex login status`; `fleet.test.ts` ~143-167 types `claude --resume <id> --add-dir /tmp` into a real tmux pane. Put
  `claude` and `codex` doubles in `test/isolate.ts`'s `bin`, as it already has for `gh` and `tailscale`, answering what
  those tests need (a version, logged in, a resume that fails like the real CLI). A test that needs the real binaries
  stays opt-in behind its env gate. Prove it: run the suite with a PATH whose real `claude`/`codex` are replaced by
  logging stubs and show nothing called them.
- **m1** Codex sends its SessionStart only with its first turn, so R1 watches an untrusted Codex until the user's first
  prompt (a `ps` every 2 s; answering trust then quitting before a prompt ends in an error saying to trust again). End a
  trust-prompt watch once `trusted()` holds.
- **m2** The watch's error always blames the trust prompt, even when "No, exit" was taken at a later prompt (the bypass
  warning). Name what the pane last showed, or word it for any startup prompt.

Test first for I2, m1 and m2.
