# Task OC-C — CLI: preflight, doctor, host add, setup --check, uninstall, controller

Worktree: /Users/linusroxbergh/linus_laboratory/svall/.claude/worktrees/oc-handover-c (branch oc-handover-c).
Owns: packages/cli/src/** (commands/{doctor,preflight,setup,agent,char,uninstall}.ts, controller/{host,handover}.ts, checks-view.ts, …), packages/svalld/src/uninstall.ts, and their tests. Not packages/svalld/src/handover/** (OC-A/OC-B).

Concurrent work you must fit: OC-A adds 'opencode' to `HANDOVER_KINDS` in packages/svalld/src/handover/sessions/registry.ts and makes `probeAgent('opencode', …)` return the same `AgentProbe` shape as claude/codex (installed + version >= 2.0.22, loggedIn via `opencode auth list --standalone`, hooks = Svall's OpenCode plugin installed), and stops `agentBlockers` refusing OpenCode. Code against that contract; where your tests need it, stub at the boundary rather than editing registry.ts.

Build, so the CLI covers OpenCode wherever it covers Claude and Codex for handover:
1. `host add` / Add Machine (controller/host.ts, the comment at ~221 saying OpenCode is not checked): check OpenCode on the Linux machine like Claude/Codex — installed, version floor 2.0.22, login, plugin installed — with the same severities (an agent the fleet doesn't run is not a blocker, etc. — mirror existing rules).
2. preflight and doctor (incl. `host doctor`): OpenCode rows/messages beside Claude/Codex; `config_difference` when the fleet runs OpenCode at different versions on the two machines; Linux doctor text that names CLAUDE_CONFIG_DIR/CODEX_HOME also names XDG_CONFIG_HOME/XDG_DATA_HOME for OpenCode; Linux `setup --check` reports the OpenCode plugin.
3. controller/handover.ts: the trust warning / any per-agent text and the "Terminate and carry" names include OpenCode characters.
4. svalld uninstall.ts on Linux: also remove the OpenCode plugin from `opencodePaths(agentHomes).plugin` when the login shell sets XDG_CONFIG_HOME (default location already removed).
5. Grep packages/cli for every 'claude' | 'codex' enumeration and handle opencode where handover is concerned.
