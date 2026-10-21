# OpenCode 2.0.22 session handover spike

Source: anomalyco/opencode v2.0.22 (shallow clone at `/private/tmp/claude-502/-Users-linusroxbergh-linus-laboratory-svall/30b37ba9-df94-4258-bcff-46da5a2191ea/scratchpad/oc/opencode`, paths below relative to its `packages/`). Binary: `~/.opencode/bin/opencode` 2.0.22. Live tests in `HOME=/tmp/svoc-spA|B|C|D`, project `/tmp/svoc-proj` (git, one commit, no remote), model `opencode/big-pickle`, no login needed. Sandbox removed afterwards; no sandbox processes left; user's `serve --service` (pid 31187) untouched. Sample export kept at `scratchpad/opencode-spike-export.json`.

## 1. Storage

- Roots: `util/src/global-roots.ts:5-8` — `XDG_DATA_HOME|~/.local/share`, `XDG_CACHE_HOME`, `XDG_CONFIG_HOME`, `XDG_STATE_HOME`, each + `/opencode`; `tmp` = `os.tmpdir()/opencode` (not under HOME). `OPENCODE_TEST_HOME` overrides `home` only (`util/src/global.ts:17`).
- DB: `cli/src/database-path.ts:4-13` — `$OPENCODE_DB` (absolute, relative to data dir, or `:memory:`), else `opencode.db` for release channels (`latest/dev/beta/next/prod` or `OPENCODE_DISABLE_CHANNEL_DB=1`), else `opencode-<channel>.db`. `opencode debug paths` prints it (`db /tmp/svoc-spA/.local/share/opencode/opencode.db`).
- WAL mode: `opencode.db-wal` and `opencode.db-shm` persist next to the db after every process exits (observed).
- Tables (live `.tables`): `session_v2`, `session_message`, `session_pending`, `session_inbox`, `instruction_entry/blob/state`, `event`, `event_sequence`, `project`, `project_directory`, `permission` (per project), `workspace`, `worktree`, `kv`, `credential`, `account*`, `migration`. Schemas `core/src/session/sql.ts:22-170`. Messages hold parts inline as JSON (`session_message.data`); there is no separate part table/dir.
- Per-session-ish files under data dir (observed after one run):
  - `snapshot/<projectID>/<hash(worktree)>/` — private git dir for undo/diff snapshots (`core/src/snapshot.ts:95-97`). Per project, not per session.
  - `shell/<projectID>/sh_<id>.out` — shell tool output (`core/src/agent.ts:11`). Not referenced by the export.
  - `tool-output/tool_*` — full text of truncated tool results, 7-day retention (`core/src/tool-output.ts:15-16,53,114`); messages reference it via `metadata.outputPath`.
  - `log/`, `repos/`.

## 2. export / import on 2.0.22

- Commands are `opencode session export [--standalone|--server URL] [--sanitize] <id>` and `opencode session import [--standalone|--server URL] [--directory DIR] <file|url>` (`cli/src/commands/commands.ts:444-468`). No top-level `opencode export`.
- Without `--standalone` they go through the shared service (`ServerConnection.resolve`, `cli/src/commands/handlers/session/export.ts:19-22`, `import.ts:28-31`). With it, a private server on the same db.
- Export = `{info: Session.Info, messages: SessionMessage.Info[]}` (`schema/src/session-transfer.ts:8-11`); only settled messages (assistant with `time.completed`, shell/compaction not running) (`core/src/session/transfer.ts:57-63,165-169`). Only that one session — no child (subagent) sessions.
- Import keeps the id: inserts `session_v2` via `SessionEvent.Created` with `sessionID = data.info.id`, inserts messages with their own ids, restores cost/tokens/created/idle/archived (`transfer.ts:64-153`). It re-resolves the project from the location it is given (`transfer.ts:74`).
- **Import binds to `--directory` or cwd, not to the exported `info.location.directory`** (`import.ts:36-49`). Live: import run from `/tmp` without `--directory` → session stored with directory `/private/tmp`, different project id.
- Live transcript:
  ```
  A$ opencode run --standalone --format json "Remember the codeword PELICAN-42. Then run 'ls'..."   # → ses_eeda388f0ffeOB6E6MBZswShKL, 5 msgs incl. tool calls
  A$ opencode session export --standalone ses_eeda… > export.json            # exit 0, 6.3 KB
  B$ opencode session import --standalone export.json                         # "Imported session: ses_eeda388f0ffeOB6E6MBZswShKL", exit 0
  B$ opencode session list --standalone --format json                         # same id, projectId db51e514… (= root commit), directory /private/tmp/svoc-proj
  B$ opencode run --standalone --format json -s ses_eeda… "What codeword… without tools?"
     → "Codeword: PELICAN-42 / Files from ls: README.md"; same sessionID; 8 msgs
  B$ tmux: opencode --standalone -s ses_eeda…   → TUI shows full history (prompt, thought, failed execute, $ ls, both answers), context 3%
  B$ export again → messages[0:5] == A's export (lossless); only time.updated/idle and tokens differ (new turn)
  ```

## 3. Importing an id that already exists

- Pre-check returns `ImportConflictError` → HTTP 409 (`transfer.ts:66-72`); CLI prints `Session already exists` to stderr and **exits 0** (`import.ts:51-54`). Nothing is overwritten or duplicated.
- Live: second import into B → `Session already exists`, exit 0. Importing B's newer 8-message export into A (which still had the 5-message original) → same; A keeps the stale copy.
- After `session delete` the id re-imports cleanly (no leftover event rows block it): A delete → import B's export → `Imported session: ses_eeda…`, 8 messages.

## 4. Delete and reading a stopped session

- `opencode session delete --standalone <id>` deletes the session and its children (`commands.ts:436-442`, `handlers/session/delete.ts`). Live: `Session ses_… deleted`, exit 0; `session_v2` and `session_message` empty after. Missing id → `Session not found: …`, exit 1 (same for export).
- Export works with no TUI running (A, after `run` exited) and also while a `--standalone` TUI holds the session (B, exit 0, 8 msgs) — each standalone server opens the same SQLite file.

## 5. Project association

- `Project.resolve` (`core/src/project.ts:337-379`): git repo → id = hash of normalized `origin` remote (`git-remote:host/path`) ?? cached `<git common dir>/opencode` file ?? first root commit; hg → cached/root changeset; else `hash("directory:" + realpath)`.
- Same repo at the same path on both machines → same project id (remote or root commit). Even if it differed, import resolves the destination's own project for the given directory, so the session lands correctly either way.
- `-s <id>` resumes in the session's stored `location.directory` (`cli/src/session-target.ts:46-52`), and **creates a new empty session with that id if it doesn't exist** (`session-target.ts:61-75`).
- Import into a nonexistent directory → server 500, exit 1, but a `project` row for that directory is left behind (C sandbox).

## 6. Alternatives

- Byte copy of `opencode.db(+wal/shm)`: replaces every other session, project, saved permission and credential on the destination. Out.
- Copying rows with sqlite3: a session spans `session_v2`, `session_message`, `event_sequence` (`Bus.reserveSequence`, `transfer.ts:114`), `instruction_*`, `session_pending/inbox`, plus `project`/`project_directory` upserts; writes bypass the bus so a running service/TUI caches miss it; depends on schema and migration version matching on both sides; WAL must be checkpointed or read via sqlite. More code, tied to internals, no version tolerance. `session import` does exactly the needed subset through the app.

## Not carried by export/import

Child (subagent) sessions (their results are in the parent's messages, so the resume has full context); unsettled in-flight messages (handover rests the agent first); queued prompts (`session_pending/inbox`); per-session instruction state (rebuilt on next turn); snapshot git dir (undo/revert of pre-handover steps won't work on the destination); `tool-output/` and `shell/` files (a pre-handover `outputPath` dangles); per-project saved permissions (machine-local, like other agents' config).

## Recommended mechanism

Treat the export JSON as OpenCode's "session file": produce it on the source, carry it byte for byte like Claude/Codex files, and turn it into db rows on the destination with `session import`.

Source, after the agent is rested:
```sh
cd "$CWD" && opencode session export --standalone "$ID" > "$STAGE/$ID.json"   # exit≠0 → transcript_missing
```
Destination, before the revive launches:
```sh
DIR=$(jq -r .info.location.directory "$STAGE/$ID.json")      # must exist (same path) → else path_unsupported
if opencode session export --standalone "$ID" >/dev/null 2>&1; then    # id already here (earlier handover)
  opencode session delete --standalone "$ID"                 # incoming copy is authoritative (or block as destination_diverged)
fi
opencode session import --standalone --directory "$DIR" "$STAGE/$ID.json"
# success only if stdout == "Imported session: $ID"; "Session already exists" on stderr with exit 0 is a failure
```
Then revive `opencode --standalone -s "$ID"` as today. After the destination confirms, source: `opencode session delete --standalone "$ID"` (exit 1 "Session not found" = already gone, fine).

Failure modes to handle:
- Import "succeeds" with exit 0 on conflict — parse stdout, never trust the exit code alone.
- Never launch `-s <id>` if import didn't succeed: OpenCode silently creates an empty session with that id, and a later import then conflicts.
- Omitting `--directory` binds the session to the importer's cwd/project.
- Source not deleted → Mac→Linux→Mac hits the stale copy; hence delete-before-import on the destination plus delete-on-source after.
- Always pass `--standalone`: without it the CLI starts/uses the shared `serve --service`, whose env and HOME may differ (and `auth list` hung without it in a scratch HOME).
- Honour the env that relocates the db on both sides by running the CLI with the character's env (`XDG_DATA_HOME`, `OPENCODE_DB`, `OPENCODE_DISABLE_CHANNEL_DB`) rather than computing paths.
- Export JSON holds the full transcript (and inline attachments as base64); never use `--sanitize` (redacts content).

Minimum version: 2.0.22 (Svall's existing OpenCode `minVersion`); all of the above verified on it. The shallow clone has no history to date when `session export/import --standalone` appeared, so don't go lower. A cheap probe: `opencode session import --help` exits 0 and lists `--standalone` and `--directory`.
