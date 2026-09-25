# Task 2 report — Prove Codex session portability

Status: DONE_WITH_CONCERNS (findings below are recorded, not hidden; nothing blocked).
Commit: `a161a0f A fixture proves a Codex session can cross homes`.

## What was implemented

Mirrors Task 1's shape exactly:

- `packages/archid/test/fixtures/handover/codex/README.md` — verdict and scope, reproducible
  observations, commands and fixtures, remaining gate.
- `packages/archid/test/fixtures/handover/codex/rollout.jsonl` and `session_index.jsonl` —
  synthetic fixtures carrying the observed structural fields and no real text.
- `packages/archid/test/handover/codex-portability.test.ts` — 7 tests.
- `scripts/probe-codex-handover.mjs` — discovery from a hook `transcript_path`, path remap, copy
  into another `CODEX_HOME`, refusals.

Also amended (both gitignored, in the main checkout):

- `docs/superpowers/specs/2026-09-20-fleet-handover-design.md` — the Codex adapter paragraph now
  says the rollout file is all the destination needs and that Codex finds the session by scanning
  `sessions/` and rebuilds its own thread index.
- `docs/superpowers/plans/2026-09-20-fleet-handover.md` — Task 2 boxes ticked.

## Live experiment

All under disposable `CODEX_HOME`s in the session scratchpad, deleted afterwards (they held a copy
of `~/.codex/auth.json`). Codex CLI 0.155.1, model `gpt-5.6-luna`, reasoning effort low; five small
model calls in total.

1. Source home `<tmp>/Users/source/.codex` with only `auth.json`, a four-line `config.toml` and a
   `hooks.json` registering the existing `scripts/probe-claude-hook.mjs` on `SessionStart`/`Stop`.
   `codex exec --dangerously-bypass-hook-trust --skip-git-repo-check '<prompt>'` in
   `<tmp>/Users/source/work/demo`. The prompt asked for one `pwd` and a marker line; the run did a
   `custom_tool_call` and answered `MARKER-ARCHI-7431 <source cwd>`.
   - Hook payloads carried `hook_event_name`, `session_id`, `transcript_path` under the same keys
     Claude Code uses; `transcript_path` = `<home>/sessions/2026/09/21/rollout-<ts>-<id>.jsonl`.
   - The home gained `state_5.sqlite` (a `threads` row with `rollout_path`, `cwd`, title) and
     `thread_history_1.sqlite`. `codex exec` wrote no `session_index.jsonl` and no `history.jsonl`.
2. Rollout-only move: copied just the rollout, byte-for-byte, into
   `<tmp>/home/target-rolloutonly/.codex` (plus hand-copied `auth.json`/`config.toml`) and ran
   `codex exec resume <id> --skip-git-repo-check '<prompt>'` from a different workspace. It
   remembered the marker, ran `pwd` in the destination, and appended in place (24 → 49 lines; the
   source rollout stayed at 24). The destination rebuilt its own `state_5.sqlite` row pointing at
   the moved rollout and the destination cwd.
3. Probe move: `node scripts/probe-codex-handover.mjs <rollout> <src-cwd> <dst-cwd> <dst-home>`,
   then the same resume. Same result. A walker over the destination rollout found zero stale source
   paths in metadata fields and 8 lines still carrying the source path as conversation or tool
   output evidence.
4. Edge probes: no `auth.json` in the destination → thread resolves, then `401 Unauthorized` at the
   first model call (a missing login does not look like a missing session). Rollout dropped flat in
   `<home>/sessions/` with no date dirs → resumed fine, so id lookup is a scan. Unknown id →
   `no rollout found for thread id <id>`.
5. Field inventory across this session plus six real 0.155.1 rollouts: `session_meta.cwd`,
   `session_meta.runtime_workspace_roots[]`, `turn_context.cwd`, `turn_context.workspace_roots[]`,
   `turn_context.permission_profile.file_system.entries[].path.path`,
   `turn_context.file_system_sandbox_policy.entries[].path.path`,
   `world_state.state.environments.environments.<env>.cwd`, and an `item_completed` item's `cwd`,
   which is a `file://` URI. `session_meta.git` holds commit/branch/remote only.

Resume form used: non-interactive `codex exec resume <id> <prompt>`. Interactive `codex resume <id>`
was not exercised; the README says so.

## Tests

RED: with the test written and the probe absent, `pnpm vitest run --project archid
test/handover/codex-portability.test.ts` → 7 failed (MODULE_NOT_FOUND on the probe).
GREEN after writing the probe → 7 passed.

The first GREEN run passed against a fixture that modelled `item.cwd` as a bare path. Checking the
real moved rollout showed `item.cwd` is a `file://` URI, which the probe was silently skipping. The
fixture, the probe and the test were corrected, and the live resume was repeated on the corrected
copy.

Final: `test/handover` 10 passed (Claude 3, Codex 7); `pnpm typecheck` clean; `pnpm vitest run
--project archid` 522 passed, 45 files. Output pristine.

## Files changed

- A `packages/archid/test/fixtures/handover/codex/{README.md,rollout.jsonl,session_index.jsonl}`
- A `packages/archid/test/handover/codex-portability.test.ts`
- A `scripts/probe-codex-handover.mjs`
- M (gitignored) fleet handover spec and plan, as above

## Self-review

- Against the brief: all five steps done; file names and commit subject verbatim.
- The probe copies nothing but the rollout and, when one exists, this session's `session_index.jsonl`
  entry; a test asserts the destination home holds only those two paths, with `auth.json`,
  `config.toml`, `history.jsonl` and a sqlite decoy present in the source.
- Rewrite rule matches Task 1's: path-typed keys move, prose and tool output do not. Documented
  deviation: an `item_completed` item's `cwd` is a past command's directory and is remapped as
  metadata while its `stdout` keeps the real source path.
- `world_state.state.permissions.approved_command_prefixes` is deliberately left alone: it is an
  allowlist matched on exact command text, so an entry naming a source path stops matching after
  the move, which fails closed.
- YAGNI: no rollout_path/agent_path handling (those live only in the rebuilt sqlite index), no
  version gating in the probe, no history.jsonl filtering.
- Temp homes holding the copied `auth.json` were deleted; nothing beyond synthetic fixtures entered
  the repo.

## Concerns for the controller

1. Cross-machine proof is out of scope: the Linux target has no Codex. Proven only on macOS,
   0.155.1, one account, with `auth.json` copied by hand into each disposable home. Recorded in the
   README's remaining gate.
2. The 0.142 rollout shape (a `session_meta` with only `id`) is accepted by the probe on the
   strength of the checked-in `rollout.jsonl` fixture, but no 0.142 session was resumed live.
3. Stale `session_meta.cwd` does not stop a resume — Codex re-emits `turn_context` and a delta
   `world_state` with the live cwd on the first resumed turn. The remap matters for what a session
   list, the rebuilt thread index and Archipelago's own transcript view show, not for correctness
   of the model's context. Task 22 should weigh validation strictness accordingly.
4. A missing destination login surfaces as a mid-turn 401, not a preflight-shaped error, so the
   host doctor must check login before any handover rather than relying on resume to fail cleanly.

## Fix pass (review round 1)

Commit: `a457353 The Codex probe notes the login check each machine needs`.

Important finding — the README gave no login check. Codex does have one: `codex login status`,
found under `codex login --help`. Verified both ways on this machine:

- real `CODEX_HOME` (read-only): `Logged in using ChatGPT`, exit 0.
- empty temp `CODEX_HOME` with no `auth.json`: `Not logged in`, exit 1; the temp home gained only
  a `tmp/arg0` helper directory and was deleted.

The README's "Commands and fixtures" block now runs `codex --version`, `CODEX_HOME=<home> codex
login status` and the resume command, with the expected output of each, and says the host doctor
must run the login check up front because the alternative signal is a mid-turn 401.

Minor finding — the probe's header comment now records that the `session_index.jsonl` branch is
defensive and was not observed from `codex exec`.

Covering tests: the login check is a CLI behavior of the Codex binary, not probe logic, so it is
recorded in the README rather than asserted in vitest; the probe change is a comment. Re-ran
`pnpm vitest run --project archid test/handover/codex-portability.test.ts` (7 passed) and
`pnpm typecheck` (clean).
