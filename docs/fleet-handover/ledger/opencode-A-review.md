# OC-A review — fd59f678 on 8d5efd6e (oc-handover-a)

Verdict: **Needs fixes** (no Critical; 4 Important, 3 of them cross-task).

Verified: typecheck clean; sessions/source/destination/isolate 194 passed; mutations 15/16 unit-caught (survivor: cliRunner keeping SVALL_CHAR_ID); fault-suite mutation "no delete before import" survives (450 passed).

## Guarantees checked

- **-s on a failed import**: unreachable. The prepared state (destination.ts:494) is written only after importSessions returns no blockers; commit/activation need it. resumeInterrupted is gated by writable() (fleet.ts:584), so a non-owner never revives. The source keeps its copy, so its own revive after an abort is fine.
- **Crash between delete and import / after import, then retry**: retry re-runs delete (a "Session not found" counts as ok) then import, so it is idempotent. On abort, the destination keeps an imported session plus the placed log it doesn't own. That's harmless for ownership because a later handover deletes it first and nothing revives it without ownership. See M2.
- **Divergence** runs before delete (installSession at :484 throws first; mutation m6 caught).
- **Plugin log**: hooks/opencode-plugin.js:41-45,111 writes `$SVALL_HOME/transcripts/opencode/<id>.jsonl` for every top-level session of a Svall character (not under `--service`), creates it at start, and reports it as transcript_path. The adapter path matches.
- **Env**: every CLI call uses `--standalone`, so none reaches the user's `serve --service`. The daemon-spawned server's plugin no-ops (no SVALL_CHAR_ID). XDG_DATA_HOME comes from login-env/launchd (Mac) and OC-B's unit (Linux).
- **Fake**: matches the spike for already-exists exit 0, not-found exit 1, `-s` creating an empty session, and binding to `--directory`. The `-s` path is exercised by no test. That's OK, since the fault world's revives never run the fake.

## Important

- **I1 Divergence only sees Svall-run turns.** opencode.ts:57 deletes the destination's copy whenever the log is a prefix. A copy continued outside Svall (plain `opencode -s <id>`, or picked from the TUI's session list) writes no log, so it is silently destroyed. Claude's check is on the transcript itself, so it would catch this. Fix: before the delete, `session export --standalone <id>` the held copy and refuse `destination_diverged` unless its message ids are a prefix of the incoming export's.
- **I2 Fault suite doesn't prove idempotence.** With the delete removed, a crash at `destination.prepare.import:after` makes the retry hit "Session already exists". The handover aborts, and settledOn accepts either owner, so the suite stays green. Fix: in faults.test.ts, require `destination.prepare.import` crashes (and `destination.prepare.state:before`) to settle on the destination. Optionally split delete and import into two failpoints so a crash between them is modelled.
- **I3 (cross-task, OC-C) Branch is red alone.** cli error-catalogue "lists every code under Steps" fails, because the opencode row is missing. Land it only with OC-C's host.ts/errors.md change.
- **I4 (cross-task, verify, OC-B) Linux PATH.** The unit PATH (linux/setup.ts:73) lacks `~/.opencode/bin`, the installer's default. probeAgent's `opencode --version` would then fail with ENOENT, giving agent_cli_missing on a working Linux install. Add it to unitPath, or resolve the binary the way main's doctor does.

## agentHomes — one meaning (OC-A vs OC-B, and OC-B M4)

**Rule:** `agentHomes[kind]` (and `AgentProbe.home`) is where that kind's carried session files land. That is OC-A's meaning, which inventory.ts:309 already uses for placement and which the wire's agentAdapters[].home carries.

**Change in OC-B:** OpenCode's own folders stop riding on agentHomes. machineLocal takes them as a separate input, for example `opencode?: string[]` built from `opencodePaths(env, home)` (data, config) plus XDG_STATE_HOME/XDG_CACHE_HOME. inventory.ts:175 drops `m.agentHomes?.opencode`.

**Call sites:**
- source.ts:589 `maps()` passes the source's `opencodePaths(process.env, home)`. This fixes M4.
- destination.ts:179 passes its own the same way. This is the authoritative check for an XDG-relocated destination, because the far side only gets the defaults from the source.

## Minor

- **M1** registry.ts:182 drops SVALL_CHAR_ID/SVALL_TERM untested (the mutation survives). Add a cliRunner test that the child env lacks them.
- **M2** After an abort past import, the destination holds an unowned session (it shows in `opencode session list`). Accept and document, or delete it in destination abort.
- **M3** opencode.ts:49: when the source daemon can't spawn opencode (code -1/ENOENT), it reports transcript_missing "holds no session". Report agent_cli_missing instead.
- **M4** The export persists forever at `<fleet home>/transcripts/opencode/exports/<id>.json` on the source: a full transcript copy, including base64 attachments, where the brief said the staging area. Remove it after Complete/abort, or write it under the transaction's stage.
- **M5** registry.ts:184 spawns with the daemon's cwd. A standalone server may record a `project` row for it. Pass `cwd` (the terminal folder for import, os.tmpdir() otherwise).
- **M6** registry.ts:242: the agent_hooks_missing text names the transcripts folder for OpenCode. Name `opencodePaths().plugin`. Also, the probe's hooks check is "file exists", not `opencodePluginCurrent`.
- **M7** (not OC-A's file) login-env.ts:7 doesn't carry OPENCODE_DB / OPENCODE_DISABLE_CHANNEL_DB. If either is set only in the shell rc, the daemon's export/import read a different DB than the panes.
- **M8** A manual resume on a frozen source after export is lost silently (no log line, so no hash mismatch). Same root as I1. Accept.

## Re-review — e6b65dce (fix round on fd59f678)

Verdict: **Approved.**

Verified: typecheck clean; sessions/source/destination/faults 643/647, the 4 failures unrelated load flakes that pass alone (destination "resumed Codex", "plain shell"; faults source.complete.manifest:after, destination.claim.seal:after). Mutations 4/4 caught: no prefix check (new diverged test), no cwd, ENOENT not agent_cli_missing, and — in the fault suite now — no delete before import (destination.prepare.import:after / prepare.state:before resumes fail).

- I1 ADDRESSED — opencode.ts dropSession exports the held copy and refuses destination_diverged unless its message ids are a prefix of the incoming export's; an unreadable copy also refuses (conservative); `.here` temp removed in finally.
- I2 ADDRESSED — `resumes` on destination.prepare.{delete,import,state}; a resumed crash there must settle on the destination (faults.test.ts:214). Load-bearing (r4 above).
- M1 env strip ADDRESSED (test fails with strip removed earlier; cwd test also covers it). M3 agent_cli_missing ADDRESSED. M5 cwd ADDRESSED (terminal folder, home if gone). M6 hooks message ADDRESSED.
- Not addressed by decision: I3 merge order, I4 + OPENCODE_DB (OC-B), agentHomes wiring (integrated branch), M2/M4/M8.

Crash safety of the split failpoints:
- crash after export-check, before delete: resume re-checks, deletes, imports → destination owns and holds; abort → source owns and holds, destination keeps its unowned stale copy (a prefix of the source's; next handover replaces it).
- crash after delete, before import: resume → export says not found → import → destination; abort → source holds, destination holds none.
Either way exactly one owner holds the session; a non-owner may keep an unowned copy (M2, accepted).

New, Minor:
- N1 The fault world's trift never holds a stale copy, so destination.prepare.delete crashes never delete anything real; safe by the reasoning above, but a hand-back scenario with a stale trift copy would exercise it.
