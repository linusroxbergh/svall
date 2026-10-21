# OC-D review (oc-handover-d, 8d5efd6e..bf5c9fa7)

Verdict: **Approved** (Minors only). Docker not run; the harness was checked statically against OC-A fd59f678, OC-B fa774bda and OC-C efc37353.

## Enumerations

The `claude|codex` grep over the handover diff (web src, mac, protocol src, scripts/integration, scripts/spikes) finds nothing else that needs OpenCode:
- `host.ts` PHASES was the only web list, and it is fixed.
- `blockerHint` has hints for `codex_trust`, `claude_trust` and `claude_bypass` only. OpenCode has no blocker or warning code of its own, and adding one belongs to OC-A/OC-C.
- Swift decodes host steps as strings, and `SvallHook` is not handover code.
- Protocol `TransferSession.agent` is already `AgentKind`.

## Tests

- `web/test/host.test.ts` is load-bearing. With 8d5efd6e's host.ts restored, 2 of 17 tests fail.
- `e2e/host.spec.ts` is load-bearing (checked statically). Without the fix, `host-phase` gets an extra "Setup" group.
- `protocol/test/handover.test.ts` passes at base, because the branch changes no protocol source. It is a guard only.

## Mock vs 2.0.22 and fit with OC-A/OC-B

Exercised the mock locally:
- export, then delete of a missing id → "Session not found", exit 1
- import → "Imported session: <id>", with `--directory` applied
- a second import → "Session already exists" on stderr, exit 0
- the id matches OC-A's `SESSION` regex

All of this matches the spike and OC-A's parsing.

The mock writes `<SVALL_HOME>/transcripts/opencode/<id>.jsonl` the way the real plugin does: it creates the file at start, then logs user and agent lines. It posts with the TUI's pid, which is the plugin's `process.ppid`. OC-A's `discover` therefore passes, and preflight does not hit `transcript_missing`.

OC-B's `program()` reads argv[0] `opencode`, and `PRIVATE_SERVER` matches `opencode …/opencode.mjs serve --stdio` in its own group. A tmux kill-window SIGHUPs the TUI, the server gets EOF and exits, and `serversGone` returns without SIGKILL.

The expectations hold:
- 2 sessions, and 4 roots + 2 sessions = 6 verified entities
- one server, whose ppid is the TUI
- no server left on the source
- the hand-back sha check proves delete-then-import replaced the stale copy

Green also needs OC-C 77d32bfe, because without it the `host add opencode` step and the "install OpenCode" action are missing.

## Minor

1. **Wrapper argv** (fleet-handover.mjs:72). With the `exec -a` wrapper, ps shows `opencode /opt/it/opencode.mjs --standalone`. `startFlags` (dormancy.ts:92) returns `undefined` there, where the real binary gives `[]`, so a kept switch (`--auto`/`--yolo`) would be dropped only in the container. Fix: say so in the wrapper comment, or avoid a launch flag in the harness.
2. **Session created at launch** (opencode.mjs:84-87). A fresh TUI creates its session and posts SessionStart at launch. The real 2.0.22 plugin does this only on `session.created`, at the first prompt. Fix: note it in the header, since a no-turn character is unrealistic here.
3. **Working directory of export/delete.** The mock ignores the cwd for export and delete. OC-A's `cliRunner` runs them from the daemon's cwd, but the spike's recipe `cd`s into the project first. Owed: a sandbox check with the real 2.0.22, `cd / && opencode session export --standalone <id>`.
4. **docs/integration.md:57-86,195 is stale.** It still describes one agent, 5 entities, and fresh-machine advice without OpenCode. Fix: the docs task.
5. **SMOKE.md has no real-binary check of the OC-B MCP ruling.** Fix: give the OpenCode character an MCP server, and check that it rests without Terminate.
