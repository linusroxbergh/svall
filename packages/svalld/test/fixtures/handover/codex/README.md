# Codex portability probe (2026-09-21)

## Verdict and scope

Codex CLI **0.155.1** resumes a moved session from its rollout file alone. A disposable session
created under one `CODEX_HOME` resumed from a second `CODEX_HOME` at a different home-shaped path
prefix, with only `sessions/<yyyy>/<mm>/<dd>/rollout-<timestamp>-<id>.jsonl` copied across: the
session remembered its pre-move marker, ran `pwd` in the destination workspace and appended the new
turn to the destination rollout (24 lines before, 49 after; the source rollout stayed at 24). The
same held for the probe's path-remapped copy. The non-interactive form was used throughout:
`codex exec resume <id> <prompt>`. Interactive `codex resume <id>` was not exercised.

Credentials are not portable content. Each disposable home got `auth.json` copied in by hand; with
the rollout present but no `auth.json`, the thread still resolves and the first model call fails
with `401 Unauthorized`, so a missing login does not look like a missing session. No auth, config,
history or real conversation text was copied into this repository. The 0.142 rollout shape (a
`session_meta` carrying only `id`) is accepted by the probe but was not resumed live.

## Reproducible observations

- A `SessionStart` and a `Stop` hook each delivered `hook_event_name`, `session_id` and
  `transcript_path` under the same keys Claude Code uses, so `packages/svalld/src/hooks/receiver.ts`
  normalizes both backends unchanged. `transcript_path` pointed at the rollout inside the live
  `CODEX_HOME`. Hook registration lives in `packages/svalld/src/codex/install.ts`.
- `codex exec` wrote no `session_index.jsonl` and no `history.jsonl`. It wrote `state_5.sqlite`
  (a `threads` row holding `rollout_path`, `cwd`, title and git fields) and `thread_history_1.sqlite`.
  None of those had to move: the destination rebuilt its own `threads` row pointing at the moved
  rollout and the destination cwd. `history.jsonl` holds every session's prompts and must never be
  copied wholesale.
- Id lookup is a scan, not an index. A rollout dropped straight into `<home>/sessions/` with no
  `yyyy/mm/dd` directories resumed fine; an id with no rollout fails with
  `no rollout found for thread id <id>`. The probe keeps the dated layout regardless.
- Path-bearing live metadata, from this session and six real 0.155.1 rollouts: `session_meta.cwd`,
  `session_meta.runtime_workspace_roots[]`, `turn_context.cwd`, `turn_context.workspace_roots[]`,
  `turn_context.permission_profile.file_system.entries[].path.path`,
  `turn_context.file_system_sandbox_policy.entries[].path.path`,
  `world_state.state.environments.environments.<env>.cwd`, and an `item_completed` item's `cwd`,
  which is a `file://` URI rather than a bare path. `session_meta.git` carries commit, branch and
  remote URL only.
- Kept verbatim as evidence: message text, tool arguments, stdout/stderr and the aggregated,
  formatted and parsed command output, `last_agent_message`, the rendered `world_state`
  `filesystem` XML and `host_skills.body`, and `world_state.state.permissions`
  `approved_command_prefixes`. That last one is an allowlist matched on exact command text: an
  entry naming a source path simply stops matching after the move, which fails closed.
- Codex writes a fresh `turn_context` and a delta `world_state` with the live cwd, workspace roots
  and filesystem XML on the first resumed turn, so the agent is told its new paths without any
  handover-supplied context. The stale `session_meta.cwd` at the head of the file is what a session
  list and the rebuilt thread index would otherwise show, which is why the probe remaps it.
- Resume appends to the moved rollout in place under the same session id; no second file is created
  and the source rollout is untouched.

## Commands and fixtures

Check the supported binary and login separately on each machine, before any handover:

```bash
codex --version                      # codex-cli 0.155.1
CODEX_HOME=<home> codex login status # "Logged in using ChatGPT", exit 0
CODEX_HOME=<home> codex exec resume <id> --skip-git-repo-check '<prompt>'
```

`codex login status` reads the `CODEX_HOME` it is given and prints `Not logged in` with exit 1
when that home has no `auth.json`, leaving the home otherwise untouched. It is the only up-front
login check Codex offers, and the host doctor needs it: without it the first sign of a missing
login is a `401 Unauthorized` in the middle of the resumed turn.

The live source ran under a disposable `CODEX_HOME` holding only `auth.json`, a `config.toml`
(`model = "gpt-5.6-luna"`, `approval_policy = "never"`, `sandbox_mode = "read-only"`) and a
`hooks.json` registering `scripts/spikes/probe-claude-hook.mjs` on `SessionStart` and `Stop`; a disposable
home has no persisted hook trust, so the run needed
`codex exec --dangerously-bypass-hook-trust --skip-git-repo-check`. That hook probe records only
hook name, session id and transcript path.

`scripts/spikes/probe-codex-handover.mjs <rollout> <source-cwd> <destination-cwd> <destination-codex-home>`
copies one rollout to the same dated path under another home, remapping only path-typed fields, and
copies this session's `session_index.jsonl` entry when the source home keeps one. It refuses a
rollout that is not UUID-named under `sessions/<yyyy>/<mm>/<dd>`, a symlink, a rollout whose
`session_meta` disagrees with its filename, and an existing destination rollout. It copies no
`auth.json`, `config.toml`, `history.jsonl` or sqlite index. This is a probe, not the production
adapter. The adapter (`packages/svalld/src/handover/sessions/`) copies the rollout byte for byte to
the same path, and carries every Codex release from its minimum on.

The checked-in rollout and session-index fixtures are synthetic. They preserve observed structural
fields but contain no real prompt, tool result or credential. Run:

```bash
pnpm vitest run --project svalld test/handover/codex-portability.test.ts
pnpm typecheck
```

## Remaining gate for full release confidence

Run the same moved session under a Linux Codex installation at a different user/home path, logged
in on its own, and version-match the CLI. The Linux target has no Codex installed today, so
cross-machine and cross-OS resume is out of scope here: this fixture proves a different home and a
different path prefix on macOS, on one CLI version, with one account's `auth.json` copied by hand.
Treat a separate login, a second OS and the interactive `codex resume <id>` as release integration
checks, not as already proven.

## Versioned rollout fixtures

`0.155.1/` and `0.156.1/` are real `codex exec` rollouts laid out as a Codex home
(`sessions/<yyyy>/<mm>/<dd>/rollout-<time>-<id>.jsonl`). 0.155.1 ran on macOS and 0.156.1 on
Ubuntu 24.04. Both write `history_mode: "paginated"` and the same record kinds. They were sanitized
by replacing the home and probe paths with `/Users/source` or `/home/source`, the approved command
prefixes with two synthetic ones, encrypted reasoning with a placeholder, and any string over 600
characters with its first 200. `test/handover/sessions.test.ts` checks the session adapter against each.
