# Task 27 — obligations carried from earlier reviews (binding)

Replicas and transfer (Tasks 20, 21, 23, 26)
1. The destination's replica claim must be exposed as an RPC (nothing exposes `ReplicaStore.claim` yet). Build rsync entries only from claim results (never an `inspect()` result), write only to the path each claim returned, and stop the transaction on any refused entry (a `writeFilter` I/O error currently reads as `refused` while other entries continue).
2. The excludes a claim was proven with must be exactly the excludes rsync runs with for that root; rsync never gets `--delete-excluded`.
3. A `gitdir` root's rsync filter is `GIT_KEEP_RULES`, then `GIT_DIR_KEEP_RULES`, then the fleet excludes (use `rootMatcher`); the Task 23 engine hardcodes only `GIT_KEEP_RULES`, so the entry must carry its root kind or its keep rules.
4. Pass each root's verified scan (Task 23's outcome) to the destination's prepare as the landed scan; seal the destination with the scan Task 26 records after Git repair (`handover/seal-<tx>.json`), and seal the source with `seal(root, { transactionId, generation, manifestDigest, files }, 'source')` at Complete, before the gateway clears the transaction (otherwise the return trip finds its roots occupied).
5. Session files: stage each carried session at `sessionStage(tx, i)` (Task 26) through exact-file entries (never `--delete`).
6. The daemon WebSocket caps a message at 8 MiB; a prepare carrying the manifest and landed scans passes it at ~25k files. Don't fail badly above it — chunk, stream, or refuse with a clear blocker.

Complete and journals (Tasks 25, 26)
7. A destination Complete seals and closes the destination journal; the source journal is closed at Complete too (else a return-trip prepare is refused).
8. Abort before Commit: call `owner.abort` at the gateway first — the source refuses Abort while the gateway still holds the transaction.

Preflight composition (Tasks 21, 22, 26)
9. Compose source preflight with destination checks (replica divergence/occupancy, space, path collisions, agent CLI/login/hooks) and report material configuration differences between the machines (spec "Agent sessions").
10. The destination's git version joins preflight so a repository using extensions it cannot open (relativeWorktrees, reftable on git 2.43) blocks before transfer, not at prepare.
11. A warning at preflight that Codex will ask to trust each moved folder on its first resume (Archipelago never writes the destination's Codex config).

Resting (Task 24)
12. Rest choices are read once per Freeze call: "Interrupt and carry" mid-rest and "Continue waiting" after the user answers a blocked agent both mean calling Freeze again with the same transaction id and new choices, not aborting on a not-ok rest result.

Timeouts (Task 25)
13. Budgets are tight: preflight hashes a full manifest with no server wait and a 30 s client timeout; Freeze can spend a 3 min rest wait plus the ssh authority call plus hashing against a 5 min budget. Give long calls adequate, explicit budgets.

Carried elsewhere (not Task 27's): pull-direction naming of a local writer (Task 29 sheet); Keep-on-this-machine setter (Task 28 CLI, Task 29 UI); the daemon ssh authority under launchd against linus-vault (M3 gate).

Destination wire shape (Task 26)
14. `handover.prepare` takes the whole manifest, the per-root landed (verified) scans and an optional relaySecret, and returns `{ preparedDigest }` for `owner.ready`; every destination call (prepare, activate, the destination's own abort) names generation g+1. Activation revives only terminals the handover rested (`restedBy: <tx>`) and reports each character's result; a Codex resume may time out at its trust prompt (reported as a character error that clears on a later SessionStart).
