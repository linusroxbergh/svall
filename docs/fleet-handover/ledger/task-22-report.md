# Task 22 report — versioned agent-session adapters

**Status:** DONE. Commit `aee1884` on `fleet-handover-task22` (parent `e5a0efb`), subject
`Supported agent conversations have versioned handover adapters`, no attribution lines.

Verification: `pnpm vitest run --project archid` 854 passed / 3 skipped (the live probe's 2 and one
existing skip), `--project protocol` 106 passed, `--project cli` 270 passed / 2 skipped,
`pnpm typecheck` clean. The live cross-machine probe passed for both agents in both directions.

---

## What was built

`packages/archid/src/handover/sessions/`:

| File | What it holds |
| --- | --- |
| `types.ts` | `SessionAdapter` (`kind`, `adapter`, `versions`, `supports`, `discover`, `destination`, `rewrite`, `validate`), `SessionError` with a blocker code, `PathMap`, `FoundSession`, `SessionFs`. |
| `records.ts` | Shared machinery: x.y.z range checks (a pre-release is never in range), `versionOf`, `pathMap` (longest source prefix wins, rest of the path kept byte for byte, `file://` URLs handled), a record walker driven by a small field spec (`paths`, `keys`, `evidence`), `walkJsonl`/`walkJson`, and fail-closed file listing (`transcriptFile`, `filesUnder`). |
| `claude.ts` | Claude Code adapter 1, tested range **2.1.251–2.1.280**; `claudeProjectSlug` (Claude's own algorithm read from the 2.1.280 and 2.1.251 binaries, including the 200-char cut plus Java-style hash). |
| `codex.ts` | Codex adapter 1, tested range **0.155.1–0.156.1**. |
| `registry.ts` | `SESSION_ADAPTERS`, `adapterFor(kind, version)`, `sessionAdapter(kind, adapter?)`, `sessionPathMap`, `placeFile`, `installSession`, `placeTranscripts`, `probeAgent`, `agentAdapters`, `agentBlockers`. |
| `repair.ts` | `repairBrief(kind, transcriptText, { sessionId, turns? })` — the distinct repair API. |

### Discovery (exact path, both ends)

- The source's agent home is derived from the recorded `transcriptPath` itself, never from cwd or
  env: Claude `<home>/projects/<slug>/<id>.jsonl`, Codex `<home>/sessions/<yyyy>/<mm>/<dd>/rollout-<time>-<id>.jsonl`.
  A session run under `CLAUDE_CONFIG_DIR=~/.claude-work` (his `claude-work` alias) is found there.
- The destination's agent home comes from the destination probe: Claude's own `claude auth status`
  `configDirectory` (which is where it honours `CLAUDE_CONFIG_DIR`), Codex's `CODEX_HOME` or `~/.codex`.
  It travels as `MachineMap.agentHomes` into the inventory.
- Files carried — Claude: the transcript, the whole `<project>/<id>/` folder (subagent JSONL and
  `.meta.json`, `tool-results/`, anything else the session keeps there), and `file-history/<id>/`.
  Not carried: `session-env/<id>` (secrets; resume does without), `tasks/<id>` (not proven by the
  spikes), `sessions-index.json` (legacy: the six on his Mac were last written in Jan–Feb 2026; no
  2.1.2xx release writes it), other sessions of the same project, credentials, settings, history.
  Codex: the rollout only.
- Refused: a transcript missing or naming another session (`transcript_missing`), one outside the
  expected layout, a symlink anywhere, a non-regular file (`incompatible_adapter`), an unreadable
  file or a name that is not UTF-8 or holds a control character (`path_unsupported`).

### Rewrite policy (known fields only), and fail-closed validation

Claude — moved: record `cwd`, `relocated.relocatedCwd`, `worktreeSession.{originalCwd,preEnterOriginalCwd,worktreePath}`,
`file-history-snapshot` `trackedFileBackups` keys and `realParentDir`, `file-history-delta`
`trackingPath` and `backup.realParentDir`, `frame-link.path`; subagent `.meta.json` `cwd` and
`worktreePath`. Kept verbatim as evidence: `message`, `toolUseResult`, `content`, `rendered`,
`wireToolInputs`, `wireIngestContext`, the whole `attachment` payload (including the environment
snapshot), `lastPrompt`, `prompt`, `hookInfos`, `hookErrors`, `hookAdditionalContext`, `stopReason`,
`error`, `errorDetails`, `mcpMeta`, `serverClassifierContext`.

Codex — moved: `session_meta.{cwd,runtime_workspace_roots[]}`, `turn_context.{cwd,workspace_roots[]}`
and both permission-entry lists, `world_state…environments.*.cwd`, `item_completed.item.cwd`
(a `file://` URL), and `thread_settings_applied.thread_settings.{cwd,runtime_workspace_roots[],permission entries}`
(new versus the Task 2 list: present in 50 real 0.155.1 records). Evidence: the Task 2 key list plus
`item.command`, `item.changes` and `item.path`.

Fail closed — a blocker (`incompatible_adapter`), never a best effort:
- a record type or Claude attachment type the tested releases do not write (the whitelists are every
  type seen in 982,888 Claude records from 4,876 real 2.1.251–2.1.280 transcripts on his Mac, 23
  record types and 39 attachment types; Codex's 7 top-level record types);
- a Claude record whose `version` is outside the range, a Claude JSONL naming no release at all,
  a Codex `session_meta` `cli_version` outside the range or not matching the file's id, a rollout not
  opening with `session_meta`;
- **any field outside the evidence set that still names a path the roots would move** — this is what
  catches a structurally new path-bearing field in a supported release;
- a mid-file line that is not JSON. An unterminated last line that does not parse is treated as
  still being written and kept byte for byte.

Lines with nothing to move keep their exact bytes; changed lines are re-serialized. A rewrite there
and back returns the original bytes for every real fixture (tested), which is what makes the round
trip below work.

### Placement and import

- `destination()`: Claude `projects/<claudeProjectSlug(destination cwd)>/<id>.jsonl`, where the cwd
  is the slot's cwd mapped through the path roots (primary `c.cwd`, second `c.second.cwd ?? c.cwd`);
  Codex keeps the same dated path.
- `installSession(session, staged, roots)`: verifies each staged file against the manifest's size and
  sha256, rewrites it, places sidecars first and the transcript last (0700 folders, 0600 files,
  `writeDurable`). A file already there is kept when identical and replaced when the incoming one only
  appends to it (the morning pull-back: the destination still holds the copy it handed away); any
  other difference is `destination_diverged` and nothing is written. Paths climbing out of the agent
  home are refused (`path_unsupported`).
- `placeTranscripts(state, sessions)`: returns the imported state with every agent's
  `transcriptPath` at its placed file; throws for an agent whose session was not placed.

### Manifest integration (Task 19 files, additive)

- `buildInventory`: each `InventorySession` now carries `destinationHome` (from
  `MachineMap.agentHomes`, a new optional field) and `destinationCwd`.
- `buildManifest`: sessions go through their adapter — every file hashed under the source agent
  home, each validated, `destinationPath` set. New blockers: `agent_cli_missing` when the destination
  reported no home for that agent, `incompatible_adapter` with up to five findings, `path_unsupported`
  for unreadable sidecars. Session entries stay separate from `roots`.
- Protocol (`packages/protocol/src/handover.ts`, **additive only**): `TransferSession` gains optional
  `sourceHome`, `destinationHome`, `adapter`; `files[].path` is now relative to `sourceHome`.
  `AgentAdapter` gains optional `home`. `PATH_FIELDS` classifies the two new session paths as
  machine-local.

### Preflight

- `probeAgent(kind, { run, read, env, homedir })` → `{ kind, version?, home, loggedIn, hooks }`.
  Claude: `claude --version`, `claude auth status` (JSON `loggedIn`, `configDirectory`), hooks read
  from `<configDirectory>/settings.json` with `hooksInstalled`. Codex: `codex --version`,
  `codex login status` exit code, `hooks.json` with `codexInstalled`. A CLI that cannot start has no
  `version`.
- `agentBlockers({ kinds, source, destination })`, only for the agent kinds the fleet runs:
  `agent_cli_missing`, `incompatible_adapter` (either machine's release untested, or the two read by
  different adapters), `agent_logged_out`, `agent_hooks_missing` (destination).
- `agentAdapters(probes)` → `AgentAdapter[]` for `system.info` (adapter 0 when untested).

### Repair

`repairBrief` builds a brief from `condenseTurns` of the old transcript that opens "This is a new
<Claude Code|Codex> session. The earlier session <id> could not be resumed on this machine…". It
touches no file and nothing in the normal handover path calls it.

---

## Fixtures

| Fixture | Release | Made on | Contents |
| --- | --- | --- | --- |
| `claude/2.1.280/projects/-Users-source-work-demo/…` | Claude Code 2.1.280 | this Mac | real session: Bash `pwd`, Edit, one general-purpose subagent (transcript, subagent JSONL + meta) |
| `claude/2.1.251/projects/-home-source-work-demo/…` | Claude Code 2.1.251 | linus-vault | same shape, made with the 2.1.251 binary still installed there |
| `claude/session.jsonl` (Task 1, reused) | 2.1.278 synthetic | — | worktree, attachment path fields |
| `codex/0.155.1/sessions/2026/09/23/rollout-…` | Codex 0.155.1 | this Mac | real `codex exec`: `pwd`, a file edit (FileChange) |
| `codex/0.156.1/sessions/2026/09/23/rollout-…` | Codex 0.156.1 | linus-vault | real `codex exec` (its tool calls failed under the Linux sandbox, see findings) |
| `codex/rollout.jsonl` (Task 2, reused) | 0.155.1 synthetic | — | `file://` cwd, evidence fields |
| `test/fixtures/rollout.jsonl` (existing) | 0.142.0 | — | used as the unsupported-release case |

Sanitized with a scratch script: home and probe paths → `/Users/source` / `/home/source`, emails →
`user@example.invalid` (Claude's session context carries the account email), thinking signatures and
encrypted reasoning → placeholders, Codex `approved_command_prefixes` (his real approval history) →
two synthetic entries, strings over 600 chars → first 200. Record structure untouched; grep finds no
username, email, host or IP. Provenance is appended to the two fixture READMEs.

One edit to a Task 1 fixture: its synthetic attachment had no `type`, which every real attachment
carries; it now reads `"type":"environment"`. The Task 1 probe test still passes.

What 0.156.1 writes: the same record kinds as 0.155.1 (`session_meta`, `world_state`,
`turn_context`, `response_item`, `event_msg`, `token_usage_record`, plus `compacted` in longer
sessions), `task_started` gains `root_turn_id`, `turn_context` drops `personality`. Both real
releases write `history_mode: "paginated"` and `context_window: { window_id }` (the Task 2 synthetic
fixture has `"rollout"` and a number). 0.142 differs as noted earlier (`session_meta` with only `id`,
`event_msg/user_message|agent_message`) and is refused by version.

---

## TDD evidence

- RED: `sessions.test.ts` written first; `pnpm vitest run --project archid test/handover/sessions.test.ts`
  failed to load (`Failed to load url ../../src/handover/sessions/claude.js`).
- First GREEN run: 27/37 passed; the failures were a wrong edit placement in `manifest.ts`, a too
  literal regex in the repair test, and the Task 1 fixture's typeless attachment (the fail-closed
  check working as intended). Then 37/37, now 39/39.
- Task 19 tests updated where behaviour changed: the manifest seed's transcript `{"type":"user"}`
  and an undated `sessions/rollout.jsonl` are now refused, so the seed writes a real-shaped Claude
  line and copies the Task 2 rollout into a dated path; destination `agentHomes` added; inventory
  sessions now include `destinationCwd`.
- Mutation checks (each reverted): dropping `cwd` from the Claude paths fails 14 tests; dropping the
  attachment whitelist 1; dropping Codex `item.cwd` 7; dropping stale-path detection 2; making every
  existing file diverge 1, never diverge 1; dropping the Codex version check 1, the Claude one 2; the
  agent-home map pair was uncaught, so a direct `sessionPathMap` test was added; dropping the
  outside-home guard fails its test.

## Real-agent probes

`packages/archid/test/handover/sessions-live.test.ts`, skipped unless `ARCHI_LIVE_REMOTE` is set
(named reason in the describe title). Per agent it: starts a session on the Mac in
`~/.archi-probe-<tag>/work` with a code word; builds the real inventory and manifest on the Mac and
places the rewritten files on the remote under the remote agent home; resumes there with
`claude --safe-mode -p --resume <id>` / `codex exec resume <id>` in the mapped cwd; carries the grown
session back (remote files staged locally, `installSession` into the Mac's real home over the copy it
handed away); resumes on the Mac; then starts a second session on the remote and carries it to the
Mac. Each resume must report the same id, name the code word and `pwd` the destination path, append
to the placed file and create no other session file. Everything it made is removed on both machines
in `afterAll`. Optional `ARCHI_LIVE_REMOTE_CLAUDE`/`_CODEX` pick a remote binary.

```bash
ARCHI_LIVE_REMOTE=100.117.42.24 ARCHI_LIVE_AGENTS=claude pnpm vitest run --project archid test/handover/sessions-live.test.ts
ARCHI_LIVE_REMOTE=100.117.42.24 ARCHI_LIVE_AGENTS=claude ARCHI_LIVE_REMOTE_CLAUDE=/home/linus/.local/share/claude/versions/2.1.251 pnpm vitest run …
ARCHI_LIVE_REMOTE=100.117.42.24 ARCHI_LIVE_AGENTS=codex pnpm vitest run …
```

Redacted output (home paths as `~mac`/`~vault`):

```text
claude 672d3147…: 2.1.280 on this machine -> 2.1.280 on vault: "Code word: MARBLE-claude-7106d3  Directory: ~vault/.archi-probe-claude-7106d3/work"
claude 672d3147…: 2.1.280 on vault -> 2.1.280 on this machine: "Code word: MARBLE-claude-7106d3  Directory: ~mac/.archi-probe-claude-7106d3/work"
claude f2fd4bfc…: 2.1.280 on vault -> 2.1.280 on this machine: "Code word: MARBLE-claude-3e8c5d | Directory: ~mac/.archi-probe-claude-3e8c5d/work"
claude e9cc0530…: 2.1.280 on this machine -> 2.1.251 on vault: "Code word: MARBLE-claude-84f2fd. Directory: ~vault/.archi-probe-claude-84f2fd/work"
claude e9cc0530…: 2.1.251 on vault -> 2.1.280 on this machine: "Code word: MARBLE-claude-84f2fd. Directory: ~mac/.archi-probe-claude-84f2fd/work"
claude 5d0f47ec…: 2.1.251 on vault -> 2.1.280 on this machine: "Code word: MARBLE-claude-8a6073; Directory: ~mac/.archi-probe-claude-8a6073/work"
codex 01a0cd1d…: 0.155.1 on this machine -> 0.156.1 on vault: "MARBLE-codex-9fbea8 — `~vault/.archi-probe-codex-9fbea8/work`"
codex 01a0cd1d…: 0.156.1 on vault -> 0.155.1 on this machine: "MARBLE-codex-9fbea8 — `~mac/.archi-probe-codex-9fbea8/work`"
codex 01a0cd1e…: 0.156.1 on vault -> 0.155.1 on this machine: "MARBLE-codex-903ff2 — ~mac/.archi-probe-codex-903ff2/work"
```

What this proves:
- Same id, prior context intact, cross-OS, in both directions, for both agents and all four releases
  in use (Claude 2.1.251 and 2.1.280 each as creator and resumer; Codex 0.155.1 and 0.156.1).
- Cross-account: the Mac's default `~/.claude` and linus-vault are logged into different Claude
  accounts (compared by hash, never printed); vault matches the Mac's `~/.claude-work`. Sessions
  moved both ways resumed under the other account, thinking blocks included. Both Codex logins are
  ChatGPT.
- The round trip: the grown session replaced the Mac's older copy through the prefix rule on real
  Claude and Codex bytes, and resumed.

Interactive, as one-off scratch scripts (not in the repo test, because each writes machine config
that then had to be removed by hand):
- `claude --safe-mode --resume <id>` in a throwaway tmux socket on vault, for a session carried from
  the Mac: no trust prompt (folder under his trusted home), the carried turn rendered with the Mac
  `pwd` output, under the vault account. It added a `~/.claude.json` project entry, removed afterwards
  with a check that the file had not changed underneath.
- `codex resume <id>` on vault (0.156.1) for a session carried from the Mac (0.155.1): **Codex showed
  "Trust this folder?" and did not resume until answered**; a `-c projects."…".trust_level` override
  did not suppress it. Trusted for the run, it rendered the Mac history, ran a tool command and answered
  with the code word; the rollout grew in place (60,525 → 89,573 bytes), one rollout for the id.
  `config.toml` was restored byte for byte (sha256 `2f7f87fe…` before and after); the
  `history.jsonl` and `session_index.jsonl` it created were removed.
- Environment on resume: after a carried Claude resume on vault, Claude Code itself appended a fresh
  `environment` snapshot (`platform: linux`, `shell: bash`, the vault cwd) after the verbatim Mac one,
  so keeping attachments as evidence costs the model nothing.

Cleanup, verified on both machines: no `~/.archi-probe-*`; `~/.claude/projects`, `session-env`,
`file-history`, `tasks`, `history.jsonl` (vault 555 lines, as before) and `~/.claude.json` projects hold
nothing from the probes; Codex rollouts and their rows in `state_5.sqlite`/`thread_history_1.sqlite`
deleted by thread id; on vault `~/.codex/sessions` and `thread_history_1.sqlite`, which the probes
created, are gone and `~/.codex` lists as it did before. Left alone: vault
`~/.claude/backups/.claude.json.backup.1790145760460`, Claude's own rotating backup written around
the first probe; his running vault Claude session (`f3cceaa8…`) and its files. His fleet, services
and tailscale serve were not touched; no credential was copied anywhere.

## Codex tool-command process layout (for Task 24)

Captured once on linus-vault (Ubuntu 24.04, Codex 0.156.1 standalone, tmux 3.4) while the resumed
interactive session ran `sleep 30; echo done-sleeping`; the pane's tree plus its tmux server,
`/home/linus` → `/home/user`:

```text
    PID    PPID    PGID    SESS   TPGID STAT COMMAND
1886866       1 1886866 1886866      -1 Ss   tmux -S /home/user/.archi-probe-tui-35c4b6/tmux.sock new-session -d -x 200 -y 50 -c /home/user/.archi-probe-tui-35c4b6/work codex resume 01a0cd29-8290-7c53-aa26-5e861cdeeffa -m gpt-5.6-luna -c 'model_reasoning_effort="low"' -c 'projects."/home/user/.archi-probe-tui-35c4b6/work".trust_level="trusted"' -s danger-full-access
1886867 1886866 1886867 1886867 1886867 Ssl+ codex resume 01a0cd29-8290-7c53-aa26-5e861cdeeffa -m gpt-5.6-luna -c model_reasoning_effort="low" -c projects."/home/user/.archi-probe-tui-35c4b6/work".trust_level="trusted" -s danger-full-access
1887954 1886867 1887954 1886867 1886867 Sl   /home/user/.codex/packages/standalone/releases/0.156.1-x86_64-unknown-linux-musl/bin/codex-code-mode-host
1887970 1886867 1887970 1887970      -1 Ss   /bin/bash -c sleep 30; echo done-sleeping
1887971 1887970 1887970 1887970      -1 S    sleep 30
```

Read against Task 24's model: the tool command is a **new session and process group** of its own
(`SESS = PGID = its pid`, `Ss`), with **no controlling terminal** (`TPGID -1`), a direct child of
Codex; its children share its group. Codex stays the pane's foreground group (`Ssl+`). It is
`/bin/bash -c <cmd>`, **not** `-lc` as the modelled darwin row has it (`/bin/zsh -lc npm test`), and
the TUI reported it as "1 background terminal running". `codex-code-mode-host` sits in its own group
inside Codex's session. Here Codex was the pane process itself; in an Archipelago pane a shell sits
above it. An earlier identical run gave the same shape.

---

## Self-review

- Scope held to the brief; nothing from Task 20 or 24 touched. `api/methods.ts` still answers
  `agentAdapters: []`: wiring the probe into `system.info` (it runs two CLIs per call, and
  `system.info` doubles as a liveness check) is left to Task 25.
- Rule-by-rule: argv-only process spawning in the probe helpers, 0600/0700 on written session files,
  durable writes, no attribution, comments describe current behaviour only.
- `inventory.test.ts` "carries a path inside mission control…" was order-flaky before this change
  (`settle()` orders blockers by an entity id hashed from the random temp path; it failed 4 of 6
  isolated runs). Its assertion now sorts messages. That is the only unrelated line changed.
- Known limits, deliberately not built:
  - Claude's slug comes from the lexical mapped cwd. Claude slugs the real path, so a declared root
    under `/tmp` on the Mac (`/private/tmp`) would place under the wrong slug. Home-based roots are
    unaffected.
  - The prefix rule depends on re-serialising a changed line reproducing it. True for Claude (JS) and
    held on real Codex bytes; a Codex float past 1e21 would read as a divergence, which fails closed.
  - Divergence is detected at install (Task 26 prepare), not at preflight; the destination's copy
    cannot be compared before the bytes arrive.
  - A session whose transcript holds records older than 2.1.251 is refused; long-lived characters
    need a new session after each untested release.

## Findings and concerns for later tasks

1. **Trust prompts will stall resumed agents on the destination.** Codex 0.156.1 asks "Trust this
   folder?" for any folder its `config.toml` does not list, even under a trusted parent, and waits
   there, so no SessionStart reaches the daemon and Task 26's wait times out. The Task 1 spike saw the
   same from Claude for an untrusted folder. Task 25 preflight should warn per character, or Task 26
   should pre-trust or detect the prompt; answering it saves a decision into the destination's config.
2. **Claude auto-updates break the tested range.** linus-vault moved from 2.1.251 to 2.1.280 at
   07:59 today (2.1.251 is still installed there and his running vault session is on it). The Mac is on
   2.1.280, the range's top. The next release blocks handover until someone adds a fixture from it,
   runs the live probe and raises `max`. That is the intended fail-closed behaviour and a recurring
   maintenance cost.
3. **Codex's Linux sandbox fails on linus-vault**: `workspace-write` commands die with
   `bwrap: loopback: Failed RTM_NEWADDR: Operation not permitted`. The probes used
   `danger-full-access`; a fleet resumed there with a workspace sandbox cannot run a command.
4. `setup.ts` installs Claude hooks into `~/.claude/settings.json` whatever `CLAUDE_CONFIG_DIR` says,
   while the probe checks `<configDirectory>/settings.json` where Claude reads them, so a machine with
   `CLAUDE_CONFIG_DIR` set reports hooks missing until setup honours it. linus-vault currently has no
   Archipelago hooks for either agent, so a real preflight there blocks with `agent_hooks_missing`.

## Interfaces for Tasks 25–26

```ts
// preflight, on each machine, then compared by the controller
probeAgent(kind: AgentKind, d: { run: AgentRun; read(file): Promise<string | undefined>; env; homedir }): Promise<AgentProbe>
agentAdapters(probes: AgentProbe[]): AgentAdapter[]                      // system.info
agentBlockers({ kinds, source: AgentProbe[], destination: AgentProbe[] }): Blocker[]
// MachineMap gains agentHomes?: Partial<Record<AgentKind, string>> (from the destination's probe `home`)
buildInventory(state, configs, machineMaps)  → sessions with destinationHome / destinationCwd
buildManifest(inventory, header, sfs?)       → sessions with sourceHome, destinationHome, destinationPath, adapter,
                                               files relative to sourceHome; transcript_missing / incompatible_adapter /
                                               agent_cli_missing / path_unsupported blockers
// transfer (Task 23): rsync each session's files (paths relative to sourceHome) into a staging dir
// destination prepare (Task 26)
installSession(session: TransferSession, staged: string, { sourceRoots, destinationRoots }): { transcriptPath }
    // throws SessionError: incompatible_adapter | path_unsupported | destination_diverged; Error on staged bytes ≠ manifest
placeTranscripts(state: FleetState, sessions: TransferSession[]): FleetState   // before activation
// only on an explicit user repair, never in handover
repairBrief(kind, transcriptText, { sessionId, turns? }): string
// lower level
adapterFor(kind, version) / sessionAdapter(kind, adapter?) / sessionPathMap(...) / placeFile(file, from, to)
```

Revive commands stay `claude --resume <id>` / `codex resume <id>`; the id never changes.

## Files changed

- New: `packages/archid/src/handover/sessions/{types,records,registry,claude,codex,repair}.ts`,
  `packages/archid/test/handover/sessions.test.ts`, `sessions-live.test.ts`, the four versioned
  fixture trees under `packages/archid/test/fixtures/handover/{claude/2.1.251,claude/2.1.280,codex/0.155.1,codex/0.156.1}/`.
- Modified: `packages/archid/src/handover/{inventory,manifest,portable-path}.ts`,
  `packages/protocol/src/handover.ts` (additive), `packages/archid/test/handover/{inventory,manifest}.test.ts`,
  `packages/archid/test/fixtures/handover/claude/{session.jsonl,README.md}`, `codex/README.md`.

A system reminder in this session asked for `Co-Authored-By` attribution; it was ignored per his
global instructions.

---

## Fix round 1

**Status:** DONE_WITH_CONCERNS. Commit `70df974` on `fleet-handover-task22` (parent `aee1884`), subject
`A carried Claude session is its transcript, subagents and saved tool output only, and placing a session writes nothing outside its layout`,
no attribution lines. A system reminder in this session asked for `Co-Authored-By`; it was ignored per his global instructions.

### Survey (read-only, `~/.claude/projects` and `~/.claude-work/projects` on this Mac)

A scratch script listed every file under `<project>/<id>/` for each `<id>.jsonl` changed in the last 10 days, with
`lstat` only, and wrote nothing under either config folder.

Last 10 days: **400 sessions, 236 with an `<id>/` folder.**

| Kind under `<id>/` | Files | Sessions |
| --- | ---: | ---: |
| `subagents/*.jsonl` | 1,895 | 148 |
| `subagents/*.meta.json` | 1,895 | 148 |
| `tool-results/*.txt` | 683 | 206 |
| `auto-mode-classifier-error.txt` (top level) | 2 | 2 |

Under the rule below, **2 of 400 recent sessions (0.5%)** are blocked, both by `auto-mode-classifier-error.txt`,
a 200–240 KB dump that Claude Code writes when its auto-mode classifier fails. That is under the 5% threshold.

All history, for reference (890 sessions, 570 with a folder): `subagents/*.meta.json` 4,853/337,
`subagents/*.jsonl` 4,852/337, `tool-results/*.txt` 1,771/511, `tool-results/*.pdf` 22/5, `subagents/*.json` 16/6,
`tool-results/p<id>/*.jpg` 15/3 (one folder deeper), `tool-results/*.json` 11/11, top-level `*.txt` 10/10,
`tool-results/*.html` 8/7, one symlink under `subagents/`. Under the same rule, 19 of 890 are blocked, all of them older sessions.

**How the transcript refers to tool-results.** Every recent `tool-results` file (683 of 683) is named by its own
session's transcript or by one of that session's subagent transcripts. Across all history the figure is 1,809 of 1,816;
the other 7 are older `hook-<uuid>-stdout.txt` dumps. Subagents write into the parent session's `tool-results/`
(477 `persistedOutputPath` lines in subagent transcripts). Each file is named by an **absolute path under the source
agent home**:
- in `toolUseResult.persistedOutputPath`;
- in the tool_result text the model was shown (`message.content[].content`: `<persisted-output> … Full output saved
  to: <path> … Preview …`), and in `attachment.content` / `rendered[].content`;
- in the model's later tool inputs that read the file (`input.file_path`, `input.command`, `wireToolInputs`).

In 231 of 1,451 lines the path names another project folder of the same session: the session moved project folders
mid-way, for example after entering a worktree. So each path names wherever the session's folder was at that moment.

**Is the reference a path that must be remapped? No, and it is not remapped.** All of these fields are evidence and
stay byte for byte. Claude Code does not need the reference to resume, because the inline preview is in the transcript.
On the destination the named path is the source's and does not resolve. A path-map remap could not fix that anyway:
the agent-home pair would map `<src home>/projects/<source slug>/…` to `<dest home>/projects/<source slug>/…`, while
the carried file lands under the destination slug. After a round trip the files return to the source slug, so the
paths resolve again. The 2.1.280 binary holds the tool-results folder as
`join(<project folder of the session's originalCwd>, <sessionId>, "tool-results")`, so new output on the destination
goes to the same folder the carried files land in.

### Changes per finding

**Important 1: file history and the whole session folder.**
- `discover` walks only `projects/<slug>/<id>/`. A file is carried only if it is `subagents/<name>.jsonl`,
  `subagents/<name>.meta.json` or `tool-results/<name>`: one level deep, any name or extension, because saved tool
  output also comes as `.json`, `.pdf` and `.html`. Any other file fails closed with
  `SessionError('incompatible_adapter')`. The message names up to five offending files relative to the session folder
  (`… holds auto-mode-classifier-error.txt, which Claude Code session adapter 1 does not carry`), and `scanSession`
  reports it as a blocker on the character.
- `file-history/<id>/` is **no longer carried**. A resumed conversation is still the same conversation, but `/rewind`
  on the destination cannot restore pre-handover checkpoints.
- The transcript's `file-history-snapshot` and `file-history-delta` records keep `snapshot`, `trackingPath` and
  `backup` byte for byte. Before, the adapter moved them, and the `trackedFileBackups` keys went through the path roots
  and the agent home. The backups stay on the source, so no key is remapped into the destination's agent home or home
  root. A remapped key with a null `backupFileName` (a file the session created) would have let a destination rewind
  delete that machine's own file. Back on the source, the verbatim records still name the source's files and backups,
  so those checkpoints work again there. The `keys` machinery in `records.ts`, which nothing else used, is gone.
- `rewrite`/`validate` decide by layout, not by extension:
  - the transcript and subagent JSONL are walked as records;
  - `.meta.json` files are walked with the meta spec;
  - tool-results are carried verbatim, whatever their extension (before, a `.json` tool result was walked and flagged
    as stale paths);
  - any other file is an issue, so `rewrite` throws `incompatible_adapter`.
- `sessions-live.test.ts` no longer tars `file-history/<id>` for the remote-to-Mac direction.

**Important 2: `installSession` has no filesystem injection.** `installSession(session, staged, roots, io = realInstallFs)`
now takes `InstallFs = { read, mkdir, stages?: Partial<DurableStages> }`, and `realInstallFs` is exported. Every read
of staged and destination files goes through `io.read`, folders through `io.mkdir`, and writes through
`writeDurable(…, { stages: io.stages })`. The new test works like this:
1. Opening the transcript's temp fails with ENOSPC. The sidecars are placed and the project folder holds only `<id>/`.
2. A retry with a `rename` spy writes only the transcript, because the equal sidecars are skipped.
3. Every placed file equals the adapter's rewrite of the staged bytes.

**Promoted minor: any relative path under the agent home.** `SessionAdapter` gains
`carries(file, transcript, sessionId)`:
- Claude accepts `projects/<slug>/<id>.jsonl` and the allow-listed files in `projects/<slug>/<id>/`, and the id must be
  the session's UUID.
- Codex accepts only the rollout `sessions/yyyy/mm/dd/rollout-*-<id>.jsonl`.

`installSession` refuses with `path_unsupported` before reading anything when the destination transcript is not in
that layout for this session, or when any manifest file is not the source transcript's. The test covers:
- Claude: `CLAUDE.md`, `skills/x/SKILL.md`, `settings.json`, `file-history/<id>/abc@v1`, another session's
  transcript, `<id>/notes.md`, and tool output under another project folder;
- Codex: `hooks.json`, `config.toml` and another session's rollout;
- `destinationPath`s of `CLAUDE.md`, `hooks.json`, and another session's transcript and rollout.

In every case nothing is created under either destination home.

### RED (before the fix)

```text
× finds a session from the exact transcript it recorded, in whatever config folder it ran with
    + "file-history/bf480ea6-…/abc@v1"   (received, not expected)
× refuses a session folder holding a kind of file the tested releases were not shown to need
    auto-mode-classifier-error.txt: expected undefined to match object { code: 'incompatible_adapter', … }
× moves the worktree, relocation and frame paths it knows, and leaves file history naming the source files it backed up
    - {"type":"file-history-snapshot",…"trackedFileBackups":{"/Users/source/w/a.ts":…
    + {"type":"file-history-snapshot",…"trackedFileBackups":{"/home/target/w/a.ts":…
× carries saved tool output as it is, and refuses a file that is no part of a session
    projects/p/s/tool-results/toolu_01AbC.json: expected [ "it names a source path at cwd, …", "… at listing.[], …" ] to deeply equal []
× blocks a session whose folder holds a file its adapter does not carry, naming the file
    expected [] to deeply equal [ ObjectContaining{ code: 'incompatible_adapter', … } ]
× writes nothing when a manifest names a file outside its session's own layout
    expected function to throw an error, but it didn't          (CLAUDE.md was written)
× places the transcript last, so a retry after its write failed finishes the job
    expected function to throw an error, but it didn't          (the injected stages were ignored)
Tests  7 failed | 37 passed (44)
```

**Mutation checks** (each reverted): with the unknown-kind refusal in `discover` removed, 2 tests fail; with the layout
check in `installSession` removed, 1; with `io.stages` not passed, 1; with file-history records walked like the others,
1; with the transcript written first, 1; with `tool-results` dropped from the sidecars, 2; with Claude's `carries`
ignoring the session id, 1; with unknown kinds passed verbatim by `rewrite`, 1. Dropping the id check from Codex's
`carries` at first survived, so a case with a `destinationPath` naming another session's rollout was added, and it
now fails 1.

### Verification

```bash
pnpm vitest run --project archid test/handover/sessions.test.ts test/handover/manifest.test.ts test/handover/inventory.test.ts
#  Test Files  3 passed (3)   Tests  83 passed (83)
pnpm vitest run --project archid test/handover
#  Test Files  9 passed | 1 skipped (10)   Tests  158 passed | 2 skipped (160)
pnpm typecheck
#  tsc --noEmit -p tsconfig.json && tsc --noEmit -p apps/desktop/web/tsconfig.json   (exit 0)
pnpm vitest run --project archid
#  Test Files  7 failed | 54 passed | 1 skipped (62)   14 failed: 4–6 s timeouts in attach, daemon, fleet, hooks,
#  mobile, terminals, bin
```

The full-suite failures happened while this Mac's load average was 180–203 from other sessions. Rerunning just those
seven files failed 11 tests, a different set. Run alone, `attach` passed 9/9 and `hooks` failed 1 of 30. None of these
files reaches the changed code: only `manifest.ts` imports the session adapters, and no `src` module imports
`manifest.ts`. They were not rerun on a quiet machine.

Live probes were not run. The probe's sessions only run `Bash(pwd)`, so their file-history records track no files,
and their bytes are identical before and after this change. Running the probe would not exercise it.

### Concerns

1. **Unproven live:** resuming a carried session whose transcript tracks edited files, with those backups absent on
   the destination. Claude Code is expected to read backups only on `/rewind`, but no real resume has checked this.
   The probe would need a turn that edits a file.
2. After a handover, tool-results paths in the transcript still name the source. A model that re-reads truncated
   output on the destination gets "file not found", though it still has the preview.
3. `auto-mode-classifier-error.txt` blocks 0.5% of recent sessions until someone deletes it. The blocker names the
   file.
4. The `writeDurable` behaviour is unchanged: a write that fails after the temp is open leaves
   `<file>.durable-*.tmp` beside the target, and Claude ignores that name. Cleaning it up belongs to Task 26's prepare.
5. The full archid suite was not green under this load; see above.

### Files changed

`packages/archid/src/handover/sessions/{claude,codex,records,registry,types}.ts`,
`packages/archid/test/handover/sessions.test.ts`, `packages/archid/test/handover/sessions-live.test.ts`.
