# OC-B review — oc-handover-b, 8d5efd6e..d027960e

Verdict: **Approved**. No fixes needed for correctness. One item needs a coordinator ruling, plus minors.

Checked: typecheck clean; svalld 2413 passed / 4 skipped. Read against OpenCode 2.0.22 source in the spike clone (`cli/src/services/standalone.ts`, `server-process.ts`, `util/src/cross-spawn-spawner.ts:433`, `core/src/mcp/stdio.ts`, `core/src/job.ts`).

## Correctness findings

- **Process recognition is right.** The private server is spawned `detached` (setsid). Its ps row has no controlling tty: tpgid is 0 on macOS and -1 on procps, and `ROW` accepts both. The server is found as a child of the TUI that runs `opencode … serve --stdio` in another group (`processes.ts:102`).
  - The plugin's `ps -p` runs in the server's own group, so it is excluded by pgid (`:103`).
  - `serve --service` is excluded from children, from served processes and from `tree()`, so neither the wait nor Terminate ever reaches it.
  - `.exe` handling matches main's `runsAgent`.
- **Rest semantics match main's `runsInBackground`.** Everything the server runs in another group counts as a command.
- **SIGKILL safety.** `opencode.db` runs in WAL mode, and SQLite survives a process kill without corruption or loss of committed transactions.
  - On the idle path, the turn was already committed before the plugin reported it.
  - On the interrupt path, the server's EOF shutdown writes the interrupted turn, and it has `settleMs` (10 s) to do so. The TUI's own force-kill is 3 s, so the margin is ample.
  - A kill only after that can lose the partial assistant text of an interrupted turn. The export drops unsettled messages anyway.
- **The wait is bounded** by `settleMs` + one `callTimeoutMs` ps read + `pollMs`.
- **Inventory, Linux setup and guard are correct.**
  - Linux setup: agentsOff is honoured via `peekConfig(...).integrations`; `XDG_*` is read from the login shell into the unit; the plugin is installed in the XDG config. Linux `svall setup` is private-only (`cli setup.ts:277`), as on Mac.
  - The guard (`agent-events.ts:35`) already covers the plugin's late events, and the new test is load-bearing for that line.

## Mutations (scratch copy)

Each of these broke at least one test:

- removing `await gone`
- removing the SIGKILL
- removing the server lookup
- removing `served`
- removing the pgid filter
- removing the `serve --service` filter in children or in `tree`
- removing the `.exe` strip
- removing the opencode dirs or the agentHomes dir from inventory
- dropping the agentsOff check, the XDG read, or the env passed to `opencodePaths`

Gaps:

- Dropping `PRIVATE_SERVER.test` (`processes.ts:102`) breaks nothing. See M2.
- The interrupt test passes without its plugin status update. See M1.

## Important (ruling)

**I1. An idle OpenCode with any MCP or language server is always blocked** (`processes.ts:103-105`, `rest.ts:162,171`).
- 2.0.22 starts these under the server in their own groups, like background `job`s. ps cannot tell them apart.
- So a fleet with such a character must choose Terminate and carry at every handover. The spec says only a background *command* blocks, and Claude's MCP never blocks.
- The brief asks for exactly this, so the implementation is not at fault.
- Options:
  - Rule that it is accepted and document it.
  - Use the plugin's `execute.before`/`after` and job state to tell a background job from a server.
  - Since the server's EOF shutdown closes its MCP, LSP and job scopes, treat an idle OpenCode with no running shell tool or job as ready.

## Minor

- **M1. The interrupt path ignores the plugin's interrupted event** (`rest.ts:166`). OpenCode, unlike Claude, sends that event. The test "rests it once its plugin reports the turn over" (`rest.test.ts:~525`) still passes with the status update removed.
  - Fix: for `opencode`, also require `agent.status !== 'working'`. Otherwise rename the test.
- **M2. The server match is untested.** Add a test where the TUI's child in another group is `opencode run …` (for example, a shell tool that runs opencode). It must be counted as a command, not as the server.
- **M3. `serversGone` SIGKILLs only the server's group** (`rest.ts:286`). Anything it ran in other groups is orphaned, though only something started after the last ps read can exist there. It also returns without confirming the kill and writes no journal entry or boundary.
  - Fix: kill `table.tree([server])` groups, re-read once, and record the kill like `source.rest.forcekill`.
- **M4. The source side passes only Claude and Codex in agentHomes** (`source.ts:558`, OC-A's file). An XDG-relocated OpenCode dir is checked only against the defaults on the source. One `agentHomes.opencode` can name only one of data and config.
  - Carry to OC-A alongside the already-noted `destination.ts:177`.
- **M5. `~/.local/state/opencode` (TUI state, prompt history) and `~/.cache/opencode` (per-platform node_modules) are not machine-local.** The new test asserts `~/.local/state` is a valid root.
  - Fix: add both, or note why they may travel.
- **M6. No Linux-format (tpgid -1) fixture for the OpenCode pane.** The parser handles it, but the pane test is macOS-only.

## Implementer's note (stdio MCP ignoring EOF)

This is not a handover problem in practice:

- **No-terminate path:** an MCP under the server is counted as a command, so the rest blocks and no MCP is alive when the window closes.
- **Terminate path:** every group in the tree is sent SIGTERM, then SIGKILL after the settle time.
- **Normal close:** OpenCode's own EOF shutdown closes its MCP children (`mcp/stdio.ts`: stdin close, then SIGTERM, then SIGKILL).

The only gap is a server that `serversGone` SIGKILLs, plus a race where something starts after the last ps read. That leaves a process orphaned on the source. It never touches the session or `opencode.db`. M3's tree kill closes the gap.

# Re-review — d027960e..ea734002

Verdict: **Approved**.

- **I1 ADDRESSED** per ruling (ea734002): direct server children no longer block; `strays` = processes in TUI/server/direct-child groups outside the leader's tree block. Mutations: dropping strays (3 fail), counting served again (8), dropping TUI group (2) or served groups (3) all caught. Not load-bearing: `!this.installed(p)` in strays (`processes.ts:~108`) — removing it fails nothing (Minor, harmless). Residual by ruling: an OpenCode background job that is a direct server child neither blocks nor survives the server's exit.
- **M1 ADDRESSED** (c498e75a): interrupted OpenCode rests only when class ≠ agent-working; mutation caught. Plugin that never reports → bounded by settleMs, then blocker/Terminate.
- **M2 ADDRESSED** (fa774bda): `opencode run` child counted as command; dropping `PRIVATE_SERVER` fails 2.
- **M3 ADDRESSED** (248e054b): server tree journaled (`source.rest.terminated`) before SIGKILL of all its groups, re-read, throws if any survive. Each part load-bearing (no-journal, server-group-only, no-confirm each fail 1). Bounded at ≤2×settleMs + reads. Minor: reuses the existing failpoint names, so the fault suite doesn't hit this site separately.
- **M4** OC-A, not checked here.
- **M5 ADDRESSED** (a8fc7e1a): `~/.local/state/opencode`, `~/.cache/opencode` machine-local; each caught.
- **M6 ADDRESSED** (fa774bda): procps rows test.

No regressions: a working OpenCode still waits (step reaches `wait` before any commands check); Terminate still signals by group, so strays in the agent's groups are reached and waited on. typecheck clean; faults 1313 passed; svalld 2425/2429 with load flakes that differ run to run (isolate, scribe-opencode pass alone).
