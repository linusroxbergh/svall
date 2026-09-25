# Task 27 report — the end-to-end controller transaction

Status: **DONE_WITH_CONCERNS** (all obligations met with code and tests; concerns below are sizing, untested real-SSH wiring, and two judgement calls for review).

Commits on `fleet-handover-impl` (BASE 127ac37):

- `3b2e642` The daemons answer a controller's claim, inspect and complete, and read a request too large for one message in parts
- `8c8fce9` The controller sends a large call in parts and filters a Git directory carried on its own as its claim was proven
- `3b0216d` The controller advances one recoverable handover transaction

No attribution lines in any commit.

## What was implemented

### Controller (`packages/cli/src/controller/`)

- **`handover.ts`** — `Handover`, one transaction driven from this controller:
  - `preflight(to, choices)`: gateway record → identities/generations/open transaction; source `system.info` + `ownership.get`; destination `system.info`; the source's `handover.preflight` (given the destination's info, path roots and fleet home); the destination's `handover.inspect` (replica occupancy/divergence per carried root, path roots present/writable, free space for roots that are a first copy, case collisions where the destination folds case); controller-side warnings (`config_difference` for agent CLI versions that differ, `codex_trust` per Codex session). Emits `handover.preflight`.
  - `start(to, choices)`: preflight; stops with `blocked` before Begin; otherwise journals intent and runs Begin → Freeze → Transfer → Verify → Prepare → Ready → Commit → Activate → Complete, checking every answer against what was asked (transaction id, generation, from/to, fleet id, manifest digest, claimed root set, verified root set, prepared digest, committed owner/generation).
  - `resume()`: observes the four journals, `assess()`es them, and does the one safe thing: continue forward (pre- or post-commit), finish a moved fleet's Complete, or finish an abort the gateway already made.
  - `abort()`: pre-commit only (refused with `interrupted, safe: ['resume']` once the gateway has committed); gateway `owner.abort` first, then source abort, then destination abort.
  - `status()`: observation + verdict, read-only (for `archi handover status`).
  - `choose(choices)`: new rest choices while a freeze still waits → Freeze asked again with the same transaction id.
  - `cancel()`: before Freeze a clean stop (gateway abort only); after Freeze a safe abort; after Commit it only detaches the watcher (`start()` resolves `detached`, `finished` carries the rest of the move to completion).
  - Real adapters: `sshGateway` (`archi gateway owner` over the gateway's ssh master; refusal → `Refused`, silent authority → transport error), a local-socket gateway for a controller on the gateway machine, `reconnecting` (a daemon client reopened after a call whose answer never came; `ApiError` → `Refused` with its data), and `connectHandover({ fleetHome, profile })` assembling it all from `machines.json`, the fleet's `fleet.json`, one ssh master per remote machine, and tokens held only in memory (and handed to the transfer engine and the journal scrubber as secrets).
- **`recovery.ts`** — `ControllerJournal` (routes, generation, choices, phase, manifest/landed/prepared digests, per-entry transfer status, pending Complete work; no token field), `fileStore(dir)` (`<fleetHome>/controller/handover.json` plus `<fleetHome>/controller/handover/<tx>/{manifest,landed}.json` beside the transfer's `progress.json` and filters; temp+fsync+rename, mode 0600, dirs 0700; an unreadable journal is set aside and rebuilt from the other three), and the pure `assess(observation)` that names the standing (`none | open | committed | moved | returned | superseded | unknown`), the safe actions and the one way on. Works without the controller journal (from the gateway's transaction, else whichever daemon holds a journal).
- **`events.ts`** — the NDJSON vocabulary (`handover.preflight | changed | entity | blocked | retry | result`), `Outcome`, `entryEvent` (transfer progress → root/session rows), and an `Observer` that can be detached and never lets a throwing watcher stop a move.
- `transfer.ts`/`rsync.ts`: `RootEntry.rootKind`; a `gitdir` root's filter is `GIT_KEEP_RULES`, `GIT_DIR_KEEP_RULES`, then the excludes, and its verification scan reads with `rootMatcher(kind)`.
- `client.ts`: a request over `PART_BYTES` (4 MiB) goes as base64 parts; `ApiError` carries the error frame's `data` (blockers, generations).
- `authority.ts`: `remoteOwner` takes non-string params (generations) and keeps the refusal's `data`.
- `paths.ts`: re-exports the probe, now in archid.

### Daemon and protocol (within the single protocol bump)

- `handover.claim` (destination): identity as prepare's (manifest digest, g+1, to this machine, fleet, gateway), refuses once this machine has prepared (a second copy would undo its Git repair), asks the gateway that the transaction is `preparing` to this machine at g, then `ReplicaStore.claim` per carried root with the manifest's excludes and incoming files; archives a diverged/occupied root the `archive` choice names, then claims it again. Answers `{ id, excludes, check, archivedTo? }` per root.
- `handover.inspect` (destination, read-only): `ReplicaStore.inspect` per root + `probeRoots` (moved from cli to `archid/handover/probe.ts`).
- `handover.complete`: dispatched by journal role; none open → `{}`.
  - destination: only at phase `activate`; seals every root from `handover/seal-<tx>.json` at its generation (g+1) as the repair left it; removes seal/prepared/stage; closes the journal.
  - source: asks the gateway; only once the fleet has moved on (owner ≠ this machine, generation > g, and not a still-uncommitted own transaction); seals each carried root with `seal(root, { transactionId, generation: g + 1, manifestDigest, files: landed }, 'source')` (the manifest's own files where the controller no longer has `landed`); installs the gateway's record (this machine becomes a replica); closes the journal; removes the kept manifest.
- `handover.preflight` also answers the manifest it counted.
- `system.info` answers `git` (its `git --version` number).
- Source `check()` (preflight and the freeze's pre-rest pass): `git_extension` blockers for a carried repository at format version ≥ 1 using an extension the destination's git cannot open (table of first versions: worktreeConfig 2.20, partialClone 2.22, objectFormat 2.29, refStorage 2.45, relativeWorktrees 2.48, …; an unknown one needs at least the source's git), and when the destination reported no git at all.
- API server: after the token, a socket may send a request as `{ part: { id, index, count, data } }` frames in order; reassembled up to `MAX_REQUEST_BYTES` (256 MiB); out of order → 4400, oversize → 1009, a phone socket sending parts → 4400.
- Budgets: `PREFLIGHT_TIMEOUT_MS` 10 min (preflight, inspect), `FREEZE_TIMEOUT_MS` 15 min (was 5), `CLAIM_TIMEOUT_MS` 15 min, `COMPLETE_TIMEOUT_MS` 2 min; prepare/activate unchanged (10 min).
- New issue codes: `git_extension`, `codex_trust`, `config_difference`.

## Obligations (task-27-carried.md)

1. **Claim RPC; entries only from claims; write only to the claim's path; stop on any refused entry.** `handover.claim` (destination.ts `runClaim`, service, methods, guard). `Handover.entries()` builds each `RootEntry.claim` from the claim answer (never `inspect()`); the engine writes only at `check.path`. Any `failed` entry (including `refused`, e.g. a `writeFilter` I/O error) stops the transaction as `interrupted` before prepare; the engine itself still finishes its other entries (Task 23 design), but nothing is prepared from a transfer with a refused entry. Tests: destination.test "destination claim" ×4; handover.test "writes each root only where its claim says…" (claim answers `/real/…` paths the manifest does not know), "stops without preparing when the transfer refuses an entry", claim-set tampers ("leaves a root out", "names a root the manifest does not carry"). Mutation E (write to the manifest path) killed.
2. **Claim excludes = rsync excludes; no `--delete-excluded`.** The claim proves each root with `m.excludes` and answers them per root; the controller passes `c.excludes` into the entry, which `filterRules` writes. `rsyncArgv` has no `--delete-excluded`. Tests: destination claim test asserts the answered excludes; handover.test asserts entries carry the claim's excludes.
3. **gitdir filter: `GIT_KEEP_RULES`, `GIT_DIR_KEEP_RULES`, excludes.** `RootEntry.rootKind`; `filterRules(excludes, kind)`; the transfer's scans use `proveReplica(…, rootKind)`. Tests: rsync.test gitdir rules; transfer.test scripted gitdir root and a real-rsync push where `logs/` is excluded yet `.git`-dir `logs/HEAD` lands (fails with the keep rules removed); handover.test asserts `rootKind: 'gitdir'`. Mutation H killed.
4. **Landed to prepare; destination seals the post-repair scan; source seals at Complete before the gateway clears.** Prepare gets the transfer's verified scans; destination Complete seals from `seal-<tx>.json`; the controller's Complete runs destination complete → source complete (with `landed`) → `owner.complete`. Tests: destination.test "destination complete…" (records sealed at 5 with the repair scan; the next transaction's inspect finds `replica`); source.test "source complete" ×3 (sealed at g+1 with `landed`, the way back finds `replica`); handover.test asserts the source sealed exactly what prepare received. Mutation G killed. See concern 4 for the unreachable-source case.
5. **Sessions staged at `sessionStage(tx, i)` by exact-file entries.** Each session file is a `FileEntry` (mkpath, never `--delete`) to `resolvePaths(destinationFleetHome).sessionStage(tx, i)/<file>`. Test: handover.test "…each session file into its stage".
6. **8 MiB cap.** Chunked: requests over 4 MiB go as parts (each < 5.4 MiB on the wire) up to 256 MiB. Tests: protocol `RequestPart`; api.test answers a 9 MiB request sent in parts, closes on out-of-order/oversize/phone parts; client.test sends ≥ 3 parts under the cap and hands on the refusal's data.
7. **Destination Complete seals and closes; source journal closed at Complete.** See 4. Tests: destination complete; source complete (journal gone, restart finds none, replica mode); service.test dispatch.
8. **`owner.abort` first.** `undo()` calls the gateway's abort and acts on its answer (committed → forward; other/no transaction → let go; unknown → stop without touching the source) before `letGo()` aborts source then destination. Tests: op-order assertions in "aborts, gateway first…" and "after Freeze, aborts at the gateway first…"; the fake source records any abort asked after a commit as a violation. Mutation B killed.
9. **Preflight composition + material differences.** `destinationChecks()` (inspect → diverged/occupied roots, `path_root_missing`, unwritable root, `destination_no_space` for first copies, `path_collision` on case-folding destinations); agent CLI/login/hooks come through the source's preflight against the destination's `system.info` the controller supplies; `config_difference` warns of differing agent CLI versions. Tests: "adds the destination's roots and room…", "blocks a missing destination root, a fleet already in a handover, and a destination that is the owner".
10. **Destination git version at preflight.** `system.info.git`; source `gitBlockers()` in `check()` (preflight and freeze's pre-rest pass, before any terminal is touched). Tests: source.test real-git worktreeConfig@2.19, relativeWorktrees@2.43, no git; pure-function cases (unknown extension vs source version, version-0 repo, reftable@2.44.9, noop); api.test `system.info` reports git.
11. **Codex trust warning.** `codexTrust()` → `codex_trust` per Codex session's character. Test in the preflight composition test.
12. **Rest choices per Freeze call.** A `blocked` freeze goes to `decide`; its choices are a Freeze asked again with the same transaction id (no gateway abort). `choose()` mid-rest asks the source to freeze again, which cancels the waiting one. Tests: "freezes again under the same handover…" (freezes `[{}, {interruptAfterMs: 0}]`, no `gateway:abort`), "takes Interrupt and carry chosen while the rest still waits…". Mutation F killed.
13. **Budgets.** See the timeout list; the `Client` waits the budget plus 30 s; gateway calls are 30 s each, retried. Test: protocol "gives every call that hashes, rests or starts a fleet a budget of its own".
14. **Destination wire shape.** Prepare sends manifest + `landed` (+ no relay secret yet, see concern 6); every destination call names g+1 (claim, prepare, activate, complete, abort); activation's per-character results become entity rows and the `complete` outcome. Tests: happy path (characters incl. the SessionStart error), fault tables.

## Brief steps

- Spec order with checks at every boundary: happy-path test asserts the op order and the phase events `begin…complete`; eight tamper cases (Begin for other machines, manifest generation/transaction, claim sets, verified set, Ready digest, Commit owner) each stop before the next step and never activate.
- Journal with routes and progress, no tokens: see `recovery.ts`; test "keeps a journal of routes and progress, and never a token, not even in what a failure said" (a daemon error carrying the token is `[redacted]` in events, outcome and journal; the transfer gets the secrets). Scrub mutation killed.
- Cancellation semantics: three cancellation tests, plus "while activation runs, lets the watcher go at once…". Mutation I (cancel after commit aborts) killed after adding the activation-time test.
- Status reconstruction and the only safe action: 14 `assess` cases (incl. no controller journal, lost Begin answer, gateway unreachable, another transaction) + "never offers an abort once the gateway has moved the fleet".
- Unknown Commit → query authority: "asks the gateway, and goes forward when it committed"; "never aborts the source while the gateway cannot say" (outcome `interrupted, safe: []`, source still frozen; a later resume completes). Mutation C killed.
- Complete only after activation; the source's update best effort: "seals and closes the destination first, finishes the source when it can, and a resume finishes it later".
- Death/network failure after every await: two table tests over every effectful call of a full run (~35 calls incl. every journal write) × {death, lost answer, lost request, machine dropping off}; each then recovered by fresh controllers (resume, or abort first). Asserted after each: no violation (never both running, no activation before commit, no source abort after commit, no copy into a prepared root), the fleet on exactly one machine with nothing left open, the destination whenever the commit took effect, and an abort refused once it had.

## Tests and results

- Verify: `pnpm vitest run --project cli test/controller/handover.test.ts test/controller/recovery.test.ts` → **2 files, 42 passed**.
- `pnpm typecheck` → clean.
- `pnpm vitest run --project cli` (ARCHI_HOME/ARCHI_CHAR_ID/TMUX unset) → **26 files, 361 passed, 3 skipped**.
- `pnpm vitest run --project archid` (unset) → **69 files passed, 1 skipped; 1078 passed, 3 skipped**. An earlier full run at load ~27 had the known `fleet.test` revive flakes (×3) and one `source.test` handover-file (FIFO/1 s timer) failure; `fleet.test` alone 39/39 twice, `source.test` alone 34/34, `test/handover` 368/368, and the next full run was clean.
- `pnpm vitest run --project protocol` → **113 passed**.
- Real rsync (vendor 3.4.4 + fake ssh) ran for the new gitdir transfer test.

## TDD evidence

- Protocol (RED, `pnpm vitest run --project protocol test/messages.test.ts`): 6 failed / 25 passed — every new method, the preflight manifest, `git`, budgets, `RequestPart`. GREEN: 31 passed.
- archid (RED, `pnpm vitest run --project archid test/handover/{service,destination,source}.test.ts test/api.test.ts`): 11 failed + source.test failed to load (`git-extensions.js` missing): `handover.claim/inspect/complete is not a function`, parts test timed out, `system.info` without `git`. GREEN: 106 passed.
- cli engine (RED, `pnpm vitest run --project cli test/client.test.ts test/controller/rsync.test.ts test/controller/transfer.test.ts`): 3 failed — client error without `data` (and the whole 10 MiB frame sent at once), gitdir filter without `GIT_DIR_KEEP_RULES`, gitdir scan. GREEN: 49 passed + 1 skipped.
- handover.test (RED: `Failed to load url ../../src/controller/handover.js` — written before the module). GREEN: 26 passed.
- recovery.test: **written after `recovery.ts`**; RED shown by moving the module aside (`Failed to load url ../../src/controller/recovery.js`); GREEN 16 passed. The mutation checks below compensate.
- Mutations of `handover.ts`, each run against handover.test (all killed): A abort on any pre-commit failure (2 failed); B no gateway abort first (5); C unknown commit stops pre-commit without asking (2); D ignore kept landed → copy after prepare (1); E write to the manifest path (1); F rest blocker aborts (1); G source not completed (10); H gitdir kind dropped (1); I cancel after commit aborts (1, after adding the activation-time test); scrubbing removed (1); lost-landed fallback disabled (1, after retargeting the test to a death between prepare's effect and its journal write). gitdir keep rules removed from `filterRules` → real-rsync transfer test fails.

## Files changed

- `packages/protocol/src/{handover,messages}.ts`, `packages/protocol/test/messages.test.ts`
- `packages/archid/src/handover/{destination,source,service,git-extensions,probe}.ts`, `packages/archid/src/api/{methods,server}.ts`, `packages/archid/src/ownership/guard.ts`, `packages/archid/package.json` (exports for hash, manifest, probe, replicas)
- `packages/archid/test/{api.test.ts,handover/destination.test.ts,handover/service.test.ts,handover/source.test.ts}`
- `packages/cli/src/controller/{handover,recovery,events}.ts` (new), `authority.ts`, `paths.ts`, `rsync.ts`, `transfer.ts`, `packages/cli/src/client.ts`
- `packages/cli/test/controller/{handover,recovery}.test.ts` (new), `rsync.test.ts`, `transfer.test.ts`, `packages/cli/test/client.test.ts`

## Self-review findings (fixed before commit)

- `this.d.moved?.(await gateway.complete(...))` skipped the gateway Complete entirely when no `moved` hook was given (optional call short-circuits its argument) — the fault tables caught it.
- A resume after the destination had completed tried to activate again and was refused forever; resume now skips activation when the destination is reachable and holds no journal of a committed handover.
- The prepared-without-landed fallback did not journal the digest it got back.
- `refused`-at-inspect (a destination that is the owner) threw out of preflight; it is now an `identity_mismatch` blocker.
- The "never a token" test was vacuous; secrets now flow into scrubbing and the transfer engine, and the test puts a token in a daemon's error.

## Concerns

1. **`handover.ts` is ~990 lines**: the transaction (~780) and its real adapters/wiring (`sshGateway`, local gateway, `reconnecting`, `connectHandover`, ~180). The plan lists one file; splitting the wiring into its own module is the obvious cut if wanted. Not split on my own.
2. **Real wiring is not exercised end to end.** `sshGateway` and `reconnecting` are unit-tested with fakes; `connectHandover` (ssh masters, forwards, `remoteConnectionInfo`, lazily resolved rsync, route cache) is not. Task 28 builds on it and the M3 gate must run it against linus-vault in both directions.
3. **Remote fleet home is inferred**, as `profileHome(profileOf(localFleetHome), remote.record.home)` (e.g. `/home/linus/.archipelago`). Session staging and the source's fleet-home checks use it. If a companion runs with another `ARCHI_HOME`, this points wrong; the robust fix is `connection-info` answering its fleet home (additive). M3 should confirm.
4. **Source Complete is best effort (brief) vs. "before the gateway clears" (obligation 4).** In the normal path the source seals and closes before `owner.complete`. If the source cannot be reached, the gateway is still cleared, the outcome is `complete` with `pending: ['source']`, and the controller journal stays until a `resume` finishes it (source Complete accepts "the fleet moved on" after the gateway cleared). Meanwhile the old source stays fenced by its journal, and a return trip to it is refused at claim/prepare with a clear message rather than finding its roots occupied. Holding the gateway transaction open until the source answers is the alternative (blocks any new Begin); flagging for a ruling.
5. **8 MiB cap**: solved by parts up to 256 MiB (~1.5M files); beyond that the daemon closes with 1009 and the controller stops `interrupted` (no preflight blocker for that size).
6. **No relay secret at prepare** — Phase E (Task 31) provisions it; the prepare call is ready to carry it.
7. **Daemon events are not relayed.** The source's per-character rest progress during Freeze and the daemons' own `handover.entity` events are not forwarded (the CLI `Client` ignores events); Task 29's sheet sees root/session rows from the transfer, character rows from activation, blockers and phases. A `Client.onEvent` relay is small if the sheet needs rest rows.
8. **Task 28/29 must wire**: `decide` (interactive choices; non-interactive passes none, so blockers after Begin abort), `choose()` for Interrupt and carry mid-rest, `cancel()` on Ctrl-C/app quit semantics (post-commit it detaches; `finished` carries the move), `status()` for `archi handover status`, and reading `Outcome.safe`.
9. **Git extension table** is curated; M3 on linus-vault (git 2.43) should confirm a `relativeWorktrees` or reftable repository blocks at preflight. `system.info` now runs `git --version` per call (uncached).
10. **Source records itself inactive at Complete**, not at Activate (spec step 7); its surrendered journal fences it in between, as the brief allows. The destination's cached owner record keeps the committed transaction after Complete until the next handover (harmless: `assertOwner` only refuses a transaction committed to another machine).
11. `handover.inspect` writes and removes a probe file in each destination path root (Task 6's probe), though classified `read`.

## Fix round 1 (review M3: a cancel was not honoured before the next step was sent)

Commit: `177a359` A cancelled handover sends no further step, and never asks the gateway to commit again (on top of 3b0216d; no attribution lines).

### Change (`packages/cli/src/controller/handover.ts`)

- `raceCancel(promise)` became `cancellable(send, race = true)`: it takes a thunk, refuses to send once a cancel has been asked, and otherwise stops waiting on the answer when one arrives. Every pre-commit send goes through it: Begin, the destination `system.info` before Freeze, Freeze (and `orChosen` now takes a thunk too), claim, the ssh master for rsync, prepare (including the lost-landed fallback), Ready and `decide`. The transfer is not started once cancelled. Because the thunk sits inside `retrying`, a retry after its backoff is not sent either.
- Begin is checked before it is sent but its answer is always read (`race = false`). It names the transaction the abort has to close; racing it lost that id (the existing "before Freeze" test caught this during the fix).
- `commit()`: a cancel asked before Commit is sent means no Commit is sent (a safe abort follows). If Commit's fate is unknown and a cancel has been asked, the controller still asks the gateway and follows its answer. Committed goes on to activation, and the watcher is detached. Still ready-to-commit (at generation g) means the run stops as `interrupted` with `safe: ['resume', 'abort']`, and Commit is not sent again. Without a cancel, it retries the commit as before.

### Tests (`packages/cli/test/controller/handover.test.ts`, describe "cancellation")

- asked while Freeze is being readied (during the destination `system.info`): no Freeze sent, nothing rested, fleet the source's (**RED before the fix**)
- asked while a Commit's fate is unknown and the gateway still holds it ready: Commit sent once, gateway queried, `interrupted` with abort on offer, source untouched, a later abort takes the fleet back (**RED before the fix**)
- asked while a Commit's fate is unknown and it committed: goes on to activation, `detached`, completes, Commit sent once (guard)
- asked once Ready is recorded: no Commit sent, gateway abort before source abort (guard)
- asked while a call waits to be tried again (cancel during the retry backoff): the call is not sent again, no Freeze. This pins the pre-send check, which the first test alone did not.

### RED

`pnpm vitest run --project cli test/controller/handover.test.ts test/controller/recovery.test.ts` before the fix:

```
     → expected [ 'gateway:get', …(16) ] to not include 'mac:handover.freeze'
     → expected [ 'gateway:commit', …(2) ] to have a length of 1 but got 3
 FAIL |cli|  test/controller/handover.test.ts > cancellation > asked while Freeze is being readied, sends no Freeze, so nothing is rested
 FAIL |cli|  test/controller/handover.test.ts > cancellation > asked while a Commit's fate is unknown, never sends it again, and stops with the abort on offer while the gateway still holds it ready
 Test Files  1 failed | 1 passed (2)
      Tests  2 failed | 44 passed (46)
```

### GREEN (covering tests)

```
$ pnpm vitest run --project cli test/controller/handover.test.ts test/controller/recovery.test.ts
 Test Files  2 passed (2)
      Tests  47 passed (47)
$ pnpm typecheck
(clean)
```

Full `pnpm vitest run --project cli` (ARCHI_HOME/ARCHI_CHAR_ID/TMUX unset): 26 files, 365 passed, 3 skipped (run before the backoff test was added; handover.test with it: 31/31).

### Mutation checks (all killed)

- send before checking the cancel → "asked while a call waits to be tried again" fails
- re-send Commit after a cancel → the ready-to-commit case fails
- race Begin's answer → "before Freeze, clears the Begin…" fails (gateway transaction left open)
