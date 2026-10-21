# Task OC-E — docs

Worktree: /Users/linusroxbergh/linus_laboratory/svall/.claude/worktrees/oc-handover-e (branch oc-handover-e, from 4ea77cee = merge + merge fixes).
Owns: docs/fleet-handover/spec.md, docs/fleet-handover/README.md, docs/remote-machines/* (except errors.md's Steps `opencode` row, already added by OC-C, and migration.md's Downgrading section, already rewritten), docs/integration.md, docs/security/fleet-handover.md, apps/desktop/mac/SMOKE.md only if OC-D's addition needs the MCP check below.

Read the implementation on branches oc-handover-a (sessions adapter), oc-handover-b (rest/processes/inventory/Linux setup), oc-handover-c (CLI checks), oc-handover-d (web, integration harness with a mock opencode) — `git log -p 8d5efd6e..oc-handover-X` — and every OpenCode Ruling at the end of ledger/progress.md. Those branches may still get small fixes; document the behaviour the Rulings fix.

Write: wherever these docs name Claude and Codex (as agents a handover carries, checks, setup, doctor, errors, security, integration harness), name OpenCode too, with its specifics:
- spec "Agent sessions": OpenCode is the exception to byte-for-byte placing — its session travels as `opencode session export` JSON (carried and hashed byte for byte with Svall's plugin log as the transcript), and the destination exports any copy it holds and refuses destination_diverged unless that copy's messages are a prefix, deletes it, imports with --directory, and refuses to activate unless the import names the id; minimum 2.0.22; what does not travel (undo snapshots, subagent child sessions, shell/tool-output files). "Terminal records": revive `opencode --standalone -s <id>`.
- spec rest/settle: the OpenCode private server, the idle-server-children rule and its unseen-orphan gap (same as Claude/Codex), the bounded wait and kill of the server.
- machine-local folders: ~/.local/share/opencode, ~/.config/opencode, ~/.local/state/opencode, ~/.cache/opencode and their XDG relocations.
- setup/doctor/host add on Linux: the version floor, `auth list` login, the plugin, XDG_CONFIG_HOME/XDG_DATA_HOME in the daemon env; Add Machine's opencode step and action.
- integration.md: the harness's mock opencode and the `oc` character.
- README pick-up guide: one line in Status that OpenCode characters hand over too; keep it terse.
Rules: describe the final state only, no history or "now also"; minimal words; match each doc's style. Commit in repo style, no attribution. Report SHAs and a one-line-per-file list.
