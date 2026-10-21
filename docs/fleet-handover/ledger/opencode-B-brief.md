# Task OC-B — rest/settle, processes, inventory, Linux setup, guard (svalld)

Worktree: /Users/linusroxbergh/linus_laboratory/svall/.claude/worktrees/oc-handover-b (branch oc-handover-b).
Owns: packages/svalld/src/handover/rest.ts, handover/processes.ts, handover/inventory.ts, handover/portable-path.ts, handover/replicas.ts, packages/svalld/src/linux/setup.ts, setup-plan.ts, guard.ts (api guard), and their tests. Not sessions/*, manifest/source/destination (task OC-A) and not fleet.ts/dormancy.ts unless unavoidable (say so).

Build:
1. Rest/settle for an OpenCode character per main's dormancy rules: an OpenCode TUI runs a private `opencode serve --stdio` child (own process group) and each shell command, MCP and language server under it holds off dormancy (`runsInBackground` in main). The handover's rest must wait for/refuse on these the way it does for Claude/Codex background shells and MCP, and must stop the TUI and its private server cleanly so the session settles before export.
2. processes.ts: recognise Svall's own OpenCode plugin processes and the private standalone server as the agent's own (not a foreign process blocking the handover), the way it recognises Svall's Claude/Codex hook processes. Never match the user's shared `opencode serve --service`.
3. inventory.ts excludes / portable paths: OpenCode's data and config dirs (~/.local/share/opencode incl. opencode.db/-wal/-shm, snapshot/, shell/, tool-output/; ~/.config/opencode) are machine-local and must never be carried as part of a root; mirror how ~/.claude and ~/.codex are handled.
4. Linux setup (linux/setup.ts, setup-plan.ts): install Svall's OpenCode plugin and env on the Linux machine the way main's Mac setup does (find main's opencode install code under packages/svalld/src — reuse it), honouring agentsOff; uninstall removes it.
5. guard.ts and any fleet/guard path main added for OpenCode (e.g. methods the plugin calls, mutations during a frozen fleet): make sure handover's freeze/ownership guard covers them like the Claude/Codex hook paths.
