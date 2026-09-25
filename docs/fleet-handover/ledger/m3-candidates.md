# M3 deep review — candidates for validation (deduped from the panel and the Interpreter)
Full text of each: B* in m3-panel-bughunter.md, A* in m3-panel-architect.md, G* in m3-panel-guardian.md, I* in m3-intent-findings.md (all in W). Validate ONLY the section named in your dispatch.

## V1 — readiness checked too late
D1 = G1 (high) — a running daemon never learns a gateway named after it started (archid main.ts:81, source.ts:332, cli controller/host.ts:578).
D5 = G5 (medium) — the controller's (and far) rsync is first checked after Freeze rested every terminal (cli controller/handover.ts:416; build-companion ships no bin/rsync).
I1 (intent, missing) — no preflight check that SSH is non-interactive; `ssh_interactive` never raised.

## V2 — authority and guard
D2 = G2 (medium security) — phone sockets can call every handover 'transaction' RPC and handover.inspect (archid ownership/guard.ts:74).
D18 = G7 (low) — the ssh gateway frame is cast unchecked; a malformed one counts as "no answer" and relay adopts the relayed record (archid gateway/client.ts:123, handover/service.ts relay).
D19 = A12 (low) — letGo reads the abort guard's not_owner as "nothing to let go", swallowing any not_owner (cli controller/handover.ts:642, archid service.ts abort).

## V3 — path safety
D3 = G3 (medium security) — session file paths escape the stage because path.posix.join collapses `..` before pathProblem (cli controller/handover.ts:482, transfer.ts).
D4 = G4 (medium security) — claim reserves/creates roots at manifest paths never checked against path roots; containment checked only at prepare (archid handover/destination.ts:191, replicas.ts claim; cli handover.ts:374).
D17 = G6 (low security) — git repair writes `.git`/`gitdir` through carried symlinks (archid handover/git-repair.ts:80).
I2 (intent, missing) — preflight does not detect broken destination symlinks (spec "Path roots").

## V4 — transaction correctness
D6 = B1 (medium) — resume treats a quarantined destination journal as activated and completes (cli controller/handover.ts:224, archid service.ts:76-77).
D7 = B2 (medium) — a resumed same-transaction claim skips proof, so --delete wipes destination edits made before --resume (archid handover/replicas.ts:244, cli transfer.ts).
D8 = B3 (medium) — a superseded freeze retry loop resends stale choices and cancels the new freeze (cli controller/handover.ts:363, 849-856; archid source.ts freeze).
D14 = B5 (low) — Commit retries run back to back with no backoff (cli controller/handover.ts:533).

## V5 — transfer cost and progress
D9 = B4 + A1 (medium performance) — every rsync item/progress line becomes a synchronously recorded, relayed entity event (cli controller/transfer.ts:311/385-389, handover.ts:422, controller/helper.ts record; Swift bridge per event).
D10 = A2 (medium performance) — each session file is its own transfer entry: two rsyncs over ssh per file plus durable journal flushes (cli controller/handover.ts:482, transfer.ts).
D12 = A4 (medium) — session rows use an undocumented `s<index>:<file>` id the web parses; names has no sessions map (cli controller/events.ts:59, handover.ts:483; web handover.ts:85).

## V6 — contract, CLI and sheet
D11 = A3 (medium) — helper↔app NDJSON types hand-copied in three places, already drifted (web handover.ts:7, cli events.ts, protocol messages.ts:310).
D13 = A5 (medium dead-code) — controller/paths.ts is a re-export barrel only a test imports; resolvePortablePath unused elsewhere.
D15 = B6 (low) — decision answers can add choices but never retract one (cli commands/handover.ts:194, controller/handover.ts decide).
D16 = B7 (low) — the sheet reports an unknown commit as committed (web handover.ts:150).
I3 (intent, wrong) — `archi handover status` is not read-only: fileStore.read() renames an unparseable controller journal aside (cli controller/recovery.ts:84); the app runs status at every launch.
I4 (intent, wrong) — tmux-gated suites skip without a named reason (archid test/handover/processes.test.ts:182, rest.test.ts:737).
I5 (intent, creep) — `--archive` also accepts a destination path (CLI help, Swift guard Handover.swift:32, replicas.ts:205) and the CLI hint prints a path, while the contract says the root id.

Not sent to validation (Architect lows and nits, simplifications for the final review or folded in where the wave touches the code): A7–A11, A13–A20. Known: A6 (= C11).
