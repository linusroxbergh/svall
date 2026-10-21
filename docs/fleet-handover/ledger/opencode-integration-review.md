# OpenCode integration review — port-pr-1 4ea77cee..3aef03b5

Verdict: **Approved** (no Critical, no Important; Minors are doc wording and env reach).

## Verified
- Unit runs at HEAD: linux-setup, inventory, isolate, sessions 123 passed; cli host 96 passed.
- Mutation (scratch copy) 74607887: with `session delete` skipped, 161/161 svalld fault cases fail. The stale prefix copy on trift makes a delete necessary on every destination settle, and also makes the retry after `destination.prepare.import:after` idempotent. This closes OC-A I2.
- Mutation da6c8c77: dropping `opencode: opencodeFolders(...)` from destination.ts or source.ts fails the two new tests.
- 274ae561: the unit PATH and `agentHomesEnv` OPENCODE_DB are pinned by exact-string tests in linux-setup.test.ts and host.test.ts. A relative OPENCODE_DB is passed through unresolved, which is right because OpenCode resolves it against its data folder.
- 78f541b2: `process.title` is shorter than the exec'd argv, so the title fits on Linux. Splitting on spaces is fine for the harness's space-free paths.
- 3aef03b5: the walk by descent covers the ControlMaster, which is a detached direct child of the controller, plus rsync and its ssh. The controller is killed first.
- e10fe415: a timeout only.

## Seams checked
- Freeze runs rest (server exit, or SIGKILL past settleMs) before `inventory` and `exportSessions`. Preflight's export is dry (/dev/null).
- Probe, setup, doctor and the unit agree on the plugin path (`opencodePaths(daemon env)`) and on PATH (`unitPath` = host UNIT_PATH).
- agentsOff/integrations gates the plugin in Linux setup, setup --check and doctor. Add Machine warns regardless, per Ruling 952.
- Source and destination freeze/import use the same cwd rule (term 2 → `second.cwd`).

## Minor
1. spec.md:537-541, security/fleet-handover.md:38 and errors.md:97 say the state and cache folders are machine-local "where XDG_STATE_HOME and XDG_CACHE_HOME put them on each machine". Neither launchd.ts:30-31/login-env.ts:7 nor linux/setup.ts:69-78 gives the daemon those variables, so only the default state and cache folders are honoured in production. The destination.test.ts XDG_STATE_HOME test stubs the env. Fix: reword to "where the daemon's XDG_DATA_HOME and XDG_CONFIG_HOME put them", or carry XDG_STATE_HOME and XDG_CACHE_HOME in agentHomesEnv and login-env.
2. OPENCODE_DB has two gaps:
   - It is not in the Mac daemon env (login-env.ts:7, deferred). A Mac user who sets it is blocked at preflight with a misleading `transcript_missing` "holds no session".
   - doctor's `daemon env` check (doctor.ts:211) doesn't compare it, so a later change to it goes unnoticed.
   Fix: add it to NAMES and doctor, or document both in errors.md `transcript_missing`.
3. spec.md:940 names fixtures and a live probe for Claude Code and Codex only. Add "OpenCode has none; the integration mock follows 2.0.22", as security doc :272 says.
4. fleet-handover/README.md:16 says "94 failpoints", but the registry holds 63 (60 at 4ea77cee). Fix the number or drop it.
5. machine.mjs:124 `opencodes()` splits the retitled command line on spaces. A path with a space would mis-split. Note this in the comment.
