# Task 26: Destination prepare and post-commit activation

Commit: `02905ad A committed destination activates the prepared fleet exactly once`. It is on branch
`fleet-handover-task26` in worktree `.claude/worktrees/fleet-handover-task26`, with parent `1ac6d5c`.

Status: DONE_WITH_CONCERNS. The concerns are three wire decisions Task 27 depends on and one payload-size risk. They are
listed under Concerns. Obligation 5 (wiring `discoverGit` into source.ts) was dropped by the controller mid-task, and
`source.ts` is untouched.

## What was implemented

### `handover/destination.ts` (new): `DestinationHandover`

`HandoverService` builds this class when it is given `destination` deps. Phases run one at a time on a promise queue.

**Prepare** (`runPrepare`) runs these steps in order:

1. **Identify.** Nothing is written in this step. A failure raises one of these errors:
   - `transaction_mismatch` when `manifest.transactionId` is not the transaction named in the call.
   - `generation_mismatch` when the call's generation is not `manifest.generation + 1`.
   - `transaction_mismatch` when the manifest does not hash to `manifestDigest`.
   - `blocked` with `identity_mismatch` in any of these cases: the manifest is not handed to this machine, it comes from
     this machine, it names another fleet id, or it names another gateway.
2. **Repeat check.** An open journal for the same transaction with another manifest digest is refused. One that already
   holds a `preparedDigest` answers that proof, clears the stage, and writes nothing else.
3. **Pure checks.** Every non-folded root must have a verified scan in `landed`; a missing one is `not_ready`. Then all
   of the following are collected into one `blocked` answer, before any write:
   - `manifestProblems`: every manifest path is re-validated (details under obligation 3).
   - `importState`: the path rewrite, with each rewritten value held inside its destination root by real path.
   - `sessionProblems`: each session's `destinationHome` must be the agent home this machine's probe reports, and every
     file it places must stay inside that home by real path.
4. **Journal and hold.** The destination journal is written at phase `verify`, for generation g+1. Then
   `ownership.hold(...)` is set, the same hold startup applies for a destination journal.
5. **Roots.** For each carried root:
   - `ReplicaStore.inspect` must return `resume`, meaning a `receiving` record claimed by this transaction. Anything
     else is a `destination_occupied` blocker ("was not claimed by handover …").
   - `landedProblem` compares the root on disk with the controller's verified scan through `proveReplica`, so the Git
     index is compared by what it stages and volatile Git state is ignored. A difference is a `destination_diverged`
     blocker naming the paths.
   - The journal records `landedDigest` once the roots pass. A retry with the same `landed` skips this comparison,
     because the Git repair has changed those roots since.
6. **Git.** `gitProblems` checks, by real path, that every place a repair writes (common dir, checkouts, git dirs) lies
   inside a carried root. Then `repairGraphs(manifest)` runs. Right after it, whatever it found, every carried root is
   re-scanned and the result is written to `handover/seal-<tx>.json` (`SealRecord`). Repair or validation blockers are
   thrown after that write.
7. **Sessions.** `installSession` runs for each session, from `paths.sessionStage(tx, i)`. A failure becomes a blocker.
   Then `placeTranscripts` sets each agent's transcript path, and `FleetState.parse` validates the result again.
8. **Writes.** In this order:
   - `handover/prepared-<tx>.json` (0600, durable);
   - the relay secret, when one is sent, to `<home>/relay-secret` (0600, durable);
   - the journal at phase `prepare`, with `preparedDigest`, `preparedPath` and the rewritten `fleet` config;
   - removal of the stage folder.

   It returns `{ preparedDigest }`, the digest of the canonical prepared state. This is what `owner.ready` takes.

`state.json`, the Store, tmux and the fleet are never touched during prepare.

**Activate** (`runActivate`) runs these steps:

1. Requires an open destination journal for this transaction, holding `preparedDigest` and `fleet`.
2. **`committed()`** asks the authority and requires all of the following:
   - the record names this machine as owner, at the journal's generation (g+1);
   - the transaction is this one, in phase `committed`, with a `preparedDigest` equal to the one this machine prepared.

   A record with no transaction is accepted only once the journal has already seen the commit (phase `commit` or
   `activate`). The refusals are:
   - `not_ready`: the transaction is still preparing or ready-to-commit;
   - `not_owner`: another machine is the owner;
   - `generation_mismatch`;
   - `transaction_mismatch`: another transaction, or another prepared state;
   - `authority_unreachable`.
3. `ownership.installCommitted(record)`, then journal phase `commit`.
4. **`promote()`:**
   - write `fleet.json` from the journal (0600, durable) and adopt it into the daemon's shared `Config` object in place;
   - rename the prepared file with `Store.promote`. The prepared file must hash to `preparedDigest`. If the prepared
     file is already gone and `state.json` hashes to `preparedDigest` (the rename landed before a crash), use
     `Store.reload`.
5. Journal phase `activate`, then `ownership.unhold()`, `fleet.activate()` and `fleet.reconcileNow()`.
6. **`wake()`** lists every slot with no window (main and second) and runs them through a pool, 4 at a time by default.
   For each slot:
   - It registers a SessionStart waiter before opening the window, then calls `reviveCharacter` or `openSecond`.
   - A plain shell gets a typed notice: `echo 'Archipelago restarted this shell after a handover; …'`. A notice that
     fails to send is logged, and the slot still counts as up.
   - A resumed agent waits up to 60 s for a SessionStart with a matching session id. On timeout, the slot's error says
     so. For Codex, the error names the "Trust this folder?" prompt as the likely cause.
   - Each slot's result (`ok`, `error`, `sessionId`) is written to the journal as it finishes, and a per-character
     `handover.entity` event is emitted.
7. Returns one result per character (ok only when all its slots came up).

A failed slot never touches ownership. A retry skips every slot that already has a window and runs only dormant ones.
A later matching SessionStart for a slot that timed out clears that slot's error in the journal.

**Abort** (`runAbort`, destination journal before commit):

1. Asks the authority.
   - A committed transaction, or a record naming this machine owner at g+1 or later, is `handover_committed`.
   - A transaction the gateway still holds is `not_ready` ("abort it there first").
2. `sealAborted` seals each root from the seal record at the source's generation g, so the next handover can claim what
   the repair touched.
3. Removes the prepared file, the seal record and the stage, closes the journal, and unholds.

### `handover/validate.ts` (new)

Pure checks and the state import:

- `within(p, dirs)`: containment by real path.
- `manifestProblems`, `gitProblems`, `sessionProblems`.
- `landedProblem`.
- `importState(manifest)`, which does the following:
  - `exportSnapshot` plus `markDormant`/`markSlotDormant` on every slot, which removes tmux ids and recomputes the revive
    command from the agent;
  - rewrites every portable `PATH_FIELDS` value in FleetState and FleetConfig through the named roots, keeping its form:
    `~` stays `~` under the home root, and a `file:` URL keeps its query and fragment;
  - returns `{ state, fleet, blockers }`, validated at schema v7.

### Other files

- **`service.ts`:**
  - `HandoverDeps.destination`.
  - `prepare`, `activate` and `abort` delegate to the destination.
  - `activate` and `abort` skip `authorize` when an open destination journal names the transaction. A retry comes from a
    machine that already owns the fleet; an abort comes from one the record does not name.
  - `prepare` checks the generation against the journal only, never the cached owner record. On a destination the
    cached record's generation is stale; the destination compares the call's generation with the manifest instead.
  - `status()` reports one row per character, from the per-slot journal entries.
- **`store.ts`:**
  - `promote` renames the prepared file, fsyncs both `state.json`'s directory and `handover/`, and publishes without
    writing `state.json` a second time. This fixes both deferred minors from Task 9.
  - New `reload()`.
  - `commit` is split into `persist` plus `notify`, with `publish` for the no-write path.
- **`fleet.ts`:**
  - New `onSessionStart(fn)`, which reports `(charId, term, sessionId)` once a SessionStart has landed on a slot whose
    agent has that id.
  - `activate()` forgets a failed attempt, so a later call can run it again. Before this change, a failed first
    `begin()` stayed rejected forever, and no activation retry could work.
- **`ownership/state.ts`:** new `unhold()`.
- **`journal.ts`:** `DestinationJournal` gains `landedDigest`, `preparedDigest` and `fleet`. Activation entries gain
  `term` and `sessionId`.
- **`paths.ts`:** `sessionStage(tx, index)`, `replicaSeal(tx)` and `relaySecret`.
- **`config.ts`:** `merge` is exported as `mergeConfig`.
- **`main.ts`:** wires the destination deps and shares one `authority` with the source.
- **Protocol:**
  - New `LandedRoot`.
  - `handover.prepare` params become
    `{ transactionId, generation, manifest (with transactionId), manifestDigest, landed: LandedRoot[], relaySecret? }`,
    and its result becomes `{ preparedDigest }`.

## Carried obligations

1. **`unhold()` before activation.** Activation calls `ownership.unhold()` after promotion. Prepare also holds the fleet
   in-process, not only after a restart. Otherwise a destination that never restarted would become writable at
   `installCommitted`, before promotion, and an API mutation could land in the window between them. Test:
   `lets a restarted destination out of its hold only by activating`.
2. **Snapshot at v7 before any replica reads it.** `importState` parses the manifest's snapshot as `FleetState` (the
   version literal is 7), rewrites it, and prepare validates it again before writing `prepared-<tx>.json`. Promotion
   renames that file, and `Store.load` after a restart finds v7 with nothing to migrate, so a migration persist never
   writes an imported snapshot.
3. **Manifest paths re-validated, and every destination write held inside its root by real path.**
   - `manifestProblems` checks:
     - root and session files are plain relative paths, reusing `relativeProblem`;
     - no control characters, symlink targets included;
     - no duplicates;
     - absolute paths are plain;
     - each root's `destinationPath` equals the root-mapping of its `sourcePath`;
     - each carried root's real path lies inside its mapped destination root;
     - the verified scans pass the same checks.
   - The state rewrite through `mapPortablePath` holds each value inside its root by real path (`importState`).
   - Session writes are held inside the reported agent home by real path (`sessionProblems`).
   - Git repair targets are held inside the carried roots (`gitProblems`).
   - Tests:
     - `refuses a manifest path that climbs out of its root before it writes anything` asserts `../../escape.txt` is
       refused and nothing is written.
     - `blocks a carried root, a rewritten path and a session whose real path leaves where it belongs` uses symlinked
       `work`, `scratch` and `.claude/projects` on the destination.
4. **`repairGraphs` and `installSession`/`placeTranscripts` wired into Prepare.** The real-git tests use the Task 21
   fixture: the worktree list names destination paths only, and the prepared cwd is mapped. In the main test, the
   placed Claude transcript has its `cwd` rewritten, the Codex rollout's `session_meta.cwd` is rewritten, and each
   `transcriptPath` points at the destination file.
5. **`discoverGit` in source.ts.** Dropped by the controller mid-task (Task 25's fix round does it). `source.ts` is
   untouched.
6. **Landed files and seal scan.**
   - `landed: LandedRoot[]` is a new prepare param. Each root is compared against its entry. `manifestDigest` stays the
     identity that is checked.
   - The seal record at `handover/seal-<tx>.json` holds every carried root re-scanned after the repair, in the shape
     `ReplicaStore.seal` takes (`{ id, kind, entry, path, files }`) plus `transactionId`, `generation` (g+1) and
     `manifestDigest`.
   - The test checks that the sealed `.git` gitfile of the nested worktree is the file the repair wrote, not the one
     the source sent.
   - The Task 21 note on a failed prepare is also covered: an aborted handover seals the repaired roots at g. Test:
     `leaves what an aborted handover repaired claimable by the next one`. It was RED before `sealAborted`, with
     `destination_diverged`.
7. **Codex.** Nothing writes any Codex config. A Codex resume that times out names the "Trust this folder?" prompt, and
   a later SessionStart for the same session clears the slot's error. A SessionStart for another session does not.
   Test: `names a resume that never reports back …`.
8. **Activate.**
   - It runs only after `committed()` confirms the record at g+1, the transaction and the prepared digest.
   - The promotion is an atomic rename plus both directory fsyncs, with no second write.
   - The Store is replaced by publishing the renamed file.
   - Revival runs with bounded concurrency; the test asserts a peak of 2 when the limit is 2.
   - Each slot's result is recorded, and ownership is never rolled back.
   - A retry opens only dormant slots; the test asserts only `open c_ada-2` on the second call.
   - Nothing here contacts or reactivates the source.

## Tests

Changed test files:

- `test/handover/destination.test.ts` (new, 20 tests):
  - prepare: 10 tests, 3 of them against a real Git graph (they skip with a named reason when git is not on PATH);
  - activate: 7 tests;
  - destination abort: 2 tests;
  - Store promotion: 1 test.
- `test/fleet.test.ts`: `activates again after an activation that failed` and
  `says which terminal a session started in, once the hook has landed there`.
- `test/handover/service.test.ts`: prepare calls updated to the new params.
- `packages/protocol/test/messages.test.ts`: the prepare surface.

Fakes and sandboxing:

- Tests use a fake crew (fleet and tmux), a fake gateway, and a hand-moved clock.
- The real-git tests run under `/tmp` via `seedHere`.
- `fleet.test.ts` runs its own tmux sockets. Every run had ARCHI_HOME, ARCHI_CHAR_ID, TMUX and TMUX_PANE unset
  (`env -u …`), and nothing touched `~/.archipelago`.

Results:

```
$ env -u ARCHI_HOME -u ARCHI_CHAR_ID -u TMUX -u TMUX_PANE pnpm vitest run --project archid test/handover/destination.test.ts test/fleet.test.ts
 Test Files  2 passed (2)
      Tests  59 passed (59)
$ pnpm vitest run --project protocol
 Test Files  8 passed (8)
      Tests  109 passed (109)
$ pnpm typecheck
 (clean)
$ pnpm vitest run --project archid --project protocol   # load avg ~10
 Test Files  1 failed | 76 passed | 1 skipped (78)
      Tests  1 failed | 1158 passed | 4 skipped (1163)
   × Fleet > keeps a second terminal that ran an agent, and revives it in its own cwd …   (known revive flake)
$ … -t "keeps a second terminal that ran an agent"   ×5 alone
      Tests  1 passed | 38 skipped (39)             (5/5)
```

The whole `fleet.test.ts` file also passed in both verify runs.

## TDD evidence

RED, protocol (the test was written first):

```
$ pnpm vitest run --project protocol test/messages.test.ts
 × ownership and handover methods > prepares from the manifest its digest names and what the transfer verified in each root, and answers the proof ready takes
 ZodError: [ …
 Tests  1 failed | 26 passed (27)
```

RED, destination (the whole file was written before `destination.ts` existed):

```
$ pnpm vitest run --project archid test/handover/destination.test.ts
 FAIL  test/handover/destination.test.ts
 Error: Failed to load url ../../src/handover/destination.js … Does the file exist?
```

RED, fleet:

```
 × Fleet > activates again after an activation that failed      → Error: tmux server would not start
 × Fleet > says which terminal a session started in, …           → TypeError: fleet.onSessionStart is not a function
 Tests  2 failed | 37 skipped (39)
```

RED, then GREEN, abort sealing (found in self-review):

```
 × … > leaves what an aborted handover repaired claimable by the next one
   → /private/tmp/archi-git-RrqBtT/home/dest/work/demo: expected { ok: false, …(3) } to match object { ok: true, kind: 'replica' }
 → after sealAborted: Tests 20 passed (20)
```

After the first implementation pass, four tests failed on test-side errors, which were fixed:

- The Codex assertion was too strong. Message text inside a rollout is carried verbatim by design (Task 22 ruling), so
  the test now checks `session_meta.cwd`.
- `loadConfig` in the harness wrote `node.json` after the tree snapshot was taken.
- The Git case ran `git add` in a worktree that is not linked yet before the repair. It now drops the stash in the main
  checkout instead.

Mutation checks: each change was applied, the covering test run, and the file restored. 15 of 16 were killed:

| Mutation | Killed by |
|---|---|
| landed verified again after repair | real-graph test (the retry fails) |
| no `unhold` | restarted-hold test |
| containment always holds | symlink test |
| unbounded pool | peak-2 test |
| promote writes `state.json` again | inode test |
| abort does not seal | abort-claimable test |
| late SessionStart does not clear | resume test |
| another prepared digest accepted | gateway-wait test |
| another machine accepted | identity table |
| session-start for any hook | fleet test |
| tmux ids kept | main prepare test |
| no restart notice | activation test |
| failed `activate` never retried | fleet test |
| landed not compared | unclaimed/edited test |
| both live-slot guards removed | retry test |

One mutation survived: removing only the `wake()` filter. `wakeSlot` repeats the live-window guard, so that mutation
changes nothing. Removing both guards was caught (last row above). Both guards stay, because the second covers a slot
that goes live while it waits its turn in the pool.

## Files changed

- New:
  - `packages/archid/src/handover/destination.ts`
  - `packages/archid/src/handover/validate.ts`
  - `packages/archid/test/handover/destination.test.ts`
- Modified:
  - `packages/archid/src/{handover/service.ts, handover/journal.ts, store.ts, fleet.ts, ownership/state.ts, paths.ts, config.ts, main.ts}`
  - `packages/archid/test/{fleet.test.ts, handover/service.test.ts}`
  - `packages/protocol/src/{handover.ts, messages.ts}`
  - `packages/protocol/test/messages.test.ts`

The files beyond the plan's list are:

- `ownership/state.ts`, for `unhold` (obligation 1);
- `journal.ts`, whose `DestinationJournal` Task 26 is the first to use;
- `paths.ts` and `config.ts`: one path each, and a one-word export;
- `main.ts`, for wiring;
- protocol, for the new prepare params (obligation 6).

## Self-review findings (fixed before commit)

- An aborted handover left the repaired Git roots unclaimable, and the next handover would have been blocked with
  `destination_diverged`. The seal record is now written right after the repair, and a destination abort seals from it
  (new test, RED first).
- Nothing held the fleet between `installCommitted` and promotion in a daemon that had not restarted. Prepare now holds
  it in-process.
- A shell notice that failed to send would have marked an opened window as failed. It is now only logged.
- A prepare repeated after a crash between its journal write and the stage removal left the stage behind. The repeat
  now clears it.

## Concerns (Task 27 must act on these)

1. **Wire shape differs from the spec's sketch.**
   - `handover.prepare` carries the whole `manifest` in place of `snapshot`. The destination rewrites the snapshot itself
     and needs the roots, sessions, Git graphs and root maps too.
   - Prepare also carries `landed` and an optional `relaySecret`, and returns `{ preparedDigest }`. Task 27 passes that
     digest to `owner.ready`.
   - Every destination call names generation **g+1**: prepare, activate and the destination's abort. Source calls name
     g. This matches the spec's "prepared journal for generation g + 1" and Task 11's fixtures.
2. **Inbound payload limit.** archid's WebSocket `maxPayload` is 8 MiB. A prepare carries the manifest and the verified
   scans, roughly 150 B per file each, so a fleet near 25k files would exceed it. Task 27 or 38 should either raise the
   limit for this call or hand the manifest over as a file (it is immutable and digest-checked).
3. **What Task 27 must provide:**
   - A destination **claim** RPC. Prepare requires each root to be `receiving` under this transaction, but no daemon
     call exposes `ReplicaStore.claim` yet (per the Task 23 ruling, this is Task 26/27's). Tests call it directly.
   - Session files rsynced to `resolvePaths(destinationFleetHome).sessionStage(tx, i)/<file.path>`, where `i` is the
     session's index in the manifest.
   - A destination **Complete** RPC that seals each root from `SealRecord` (`handover/seal-<tx>.json`) with
     `seal(root, { transactionId, generation, manifestDigest, files }, 'destination')` and closes the destination
     journal. While that journal stays open, a restarted destination starts held until activate runs again.
   - The source journal must be closed at Complete. Otherwise a return trip's prepare on the old source is refused with
     `transaction_mismatch`.
   - Destination abort needs the gateway's transaction closed first, the same order as the source's abort.
4. **Config adoption is in place.** Activation installs the imported `fleet.json` and assigns it into the daemon's
   shared `Config` object. Anything that copied a value out at startup keeps the old value until a restart: the scribe
   model, the mobile control's logins, and the pusher's contact. Mobile moves to the gateway in Phase 3.

## Fix round 1

Commit: `304070a An activated destination admits phones by the fleet it received and starts only the terminals its handover rested`,
on top of `02905ad`.

### Item 1 (Important): phones admitted by the imported lists after activation

The API copied `opts.mobile.logins` and `origins` into constants at startup, and `adopt` replaced `config.mobile` with a
new object, so the API never saw the imported lists.

- `api/server.ts`: `logins()` and `origins()` now read `opts.mobile` on every request. This covers the `/rpc` identity
  check, the `/rpc` origin check, the socket origin check and the socket identity check.
- `destination.ts` `adopt`: `config.mobile` is now replaced in place (`replaceIn`), keeping the object the API holds. The
  rest of the config is replaced the same way.
- New test `admits phones by the lists of the fleet.json it activated` runs the real `startApi` over the destination's
  shared `config.mobile`.
  - Before activation, the destination's own fleet.json is in force: it trusts every login and `https://old.example`.
  - After activation, the imported list is in force (`me@example.com` only, and `https://phone.example`):
    - a stranger's login gets 401;
    - the old origin gets 403;
    - a kept login and the new origin get past both checks (400 on an unreadable body).

### Item 2: activation revives only the terminals the handover rested

The signal is a marker on the slot record. The source's rest writes it and the snapshot carries it.

- Protocol `state.ts`: `TerminalSlot` and `Character` gain optional `restedBy: string`, the transaction whose rest closed
  that terminal's window.
- `portable-path.ts`: both fields are registered in `NOT_PATHS`, and the classifier test (`inventory.test.ts`) passes.
- `rest.ts` (source side, three lines): `lay` sets `restedBy` to the journal's transaction, but only for slots whose
  window the rest closed. A slot whose window had already gone is made dormant without the marker, the same line the
  abort draws with `stoppedTerminals`.
- `destination.ts` `wake`: only slots with no window whose `restedBy` equals this transaction are started.
  - A slot dormant before the freeze has no marker, or one naming an earlier handover. It stays dormant, on a retry too.
  - The marker survives `reconcile`'s `markDormant`, which rewrites only `revive`, so a failed rested slot is still found
    by a retry.
- Tests:
  - rest: rested slots carry `restedBy: 'tx-1'`, and the already-gone second slot does not.
  - destination: the scene gains `c_old`, dormant before the freeze, with an old `restedBy: 'tx-0'` on its main slot and
    none on its second. New test `starts only the terminals this handover rested, and leaves one dormant before the
    freeze as it was`, which runs activate twice. The existing expectations were updated for the marker.

### Item 3 (promoted): the pool settles every worker before the call answers

- `pool` now uses `Promise.allSettled` and rethrows the first failure only after every worker has stopped, so the serial
  queue cannot release while a worker is still opening terminals.
- The test harness `daemon()` gains `failWrite`, a journal write that throws for a chosen journal.
- New test `answers only once every terminal it started has settled, even when recording one fails`. The journal write
  that would record `c_ada` fails with ENOSPC. When activate rejects:
  - no open is still in flight;
  - nothing opens afterwards;
  - every rested slot was opened exactly once.

### RED (tests written first, before any source change)

```
$ env -u ARCHI_HOME -u ARCHI_CHAR_ID -u TMUX -u TMUX_PANE pnpm vitest run --project archid test/handover/destination.test.ts test/handover/rest.test.ts
 × restTerminals > rests idle agents and shells at their prompt, … → expected undefined to be 'tx-1'
 × restTerminals > captures scrollback before a window closes when asked, … → expected undefined to be 'tx-1'
 × resting real terminals > ends the chosen job in a real pane, … → expected { unread: false, …(2) } to deeply equal { …(4) }
 × destination prepare > rewrites the fleet for this machine beside the active state, … → expected { …(3) } to deeply equal { …(4) }
 × destination activate > promotes the prepared state and fleet.json, … → expected [ { id: 'c_ada', ok: true }, …(4) ] to deeply equal [ …(3) ]
 × destination activate > starts only the terminals this handover rested, … → expected [ 'c_ada', 'c_bo', 'c_cy', …(2) ] to deeply equal [ 'c_ada', 'c_bo', 'c_cy', 'c_dee' ]
 × destination activate > admits phones by the lists of the fleet.json it activated → expected 400 to be 401
 × destination activate > answers only once every terminal it started has settled, … → expected 1 to be +0
 × destination activate > retries only the terminals that are still dormant, … → expected [ 'open c_ada', 'open c_ada-2', …(5) ] to have a length of 5 but got 7
 Tests  9 failed | 41 passed (50)
```

### GREEN

```
$ pnpm typecheck
 (clean, exit 0)
$ env -u … pnpm vitest run --project archid test/handover/destination.test.ts test/fleet.test.ts test/handover/rest.test.ts test/api.test.ts test/mobile.test.ts test/handover/source.test.ts
 Test Files  6 passed (6)
      Tests  141 passed (141)
$ env -u … pnpm vitest run --project archid test/handover/inventory.test.ts     # path classifier
      Tests  25 passed (25)
$ env -u … pnpm vitest run --project archid --project protocol                  # load avg ~8
 Test Files  1 failed | 76 passed | 1 skipped (78)
      Tests  1 failed | 1161 passed | 4 skipped (1166)
   × Fleet > keeps a second terminal that ran an agent, … (known revive flake)
$ env -u … pnpm vitest run --project archid test/fleet.test.ts   ×5
      Tests  39 passed (39)   (5/5)
```

`fleet.ts` is unchanged in this round.

### Files changed in this round

- `packages/archid/src/{api/server.ts, handover/destination.ts, handover/rest.ts, handover/portable-path.ts}`
- `packages/protocol/src/state.ts`
- `packages/archid/test/handover/{destination.test.ts, rest.test.ts}`

`rest.ts` belongs to Task 25, and the change there is three lines inside `layToRest`.

### Left as it was

`mobileControl` still reports the logins it was given at startup (the `mobile.get` status only; admission reads live),
and the pusher keeps its startup `pushContact` until a restart. Neither affects who is admitted. Both move to the gateway
in Phase 3.

## Fix round 2

Commit: `533db86 A phone socket closes once the fleet it is connected to no longer lists its login`, on top of `304070a`.

### Item 1 (promoted): a phone socket that stays open across activation

A phone socket's login was checked once, at upgrade. A socket admitted by the destination's old list therefore kept
read and write access after activation until it dropped.

- `api/server.ts`: new exported `loginAdmitted(login, logins)`, and `identityOf` uses it. Inside `connect`, a phone
  viewer's login is checked against the live `logins()`:
  - before every event sent to it (`viewer.send`);
  - before every message it sends.

  A login no longer listed closes the socket with 4401 and nothing more is sent or dispatched. Promotion publishes a
  state patch, so a revoked phone is closed during activation itself. A phone that receives nothing is closed at its
  next call.
- Tests:
  - `destination.test.ts`, `closes a phone socket open across activation whose login the fleet.json it activated no
    longer lists`. Two phone sockets are opened before activation, when the destination's own fleet.json trusts every
    login. After `activate`, `them@example.com` is closed with 4401 and `me@example.com` stays open.
  - `mobile.test.ts`, `closes a phone socket at its next call once the fleet no longer lists its login`. The shared
    `mobile.logins` is changed in place, then the phone's next `state.get` closes it with 4401. The harness `boot` now
    returns its `mobile` object.

### Item 2: stale comments

The `DestinationHandover` class comment and the `runActivate` comment now say activation starts the terminals this
handover rested (still dormant, in `runActivate`), not every terminal.

### RED

Test written first:

```
$ env -u … pnpm vitest run --project archid test/handover/destination.test.ts -t "phone socket open across"
 × destination activate > closes a phone socket open across activation whose login the fleet.json it activated no longer lists
   → waitFor: timed out
 Tests  1 failed | 23 skipped (24)
```

Each check in `connect` was proven load-bearing by removing it:

```
# message-time check removed
 × phone sockets > closes a phone socket at its next call once the fleet no longer lists its login → Test timed out in 5000ms.
# event-time check removed
 × destination activate > closes a phone socket open across activation … → waitFor: timed out
```

Both pass with the checks restored.

### GREEN

```
$ pnpm typecheck
 (clean, exit 0)
$ env -u ARCHI_HOME -u ARCHI_CHAR_ID -u TMUX -u TMUX_PANE pnpm vitest run --project archid test/handover/destination.test.ts test/api.test.ts test/mobile.test.ts test/fleet.test.ts
 Test Files  4 passed (4)
      Tests  92 passed (92)
```

### Files changed in this round

- `packages/archid/src/{api/server.ts, handover/destination.ts}`
- `packages/archid/test/{handover/destination.test.ts, mobile.test.ts}`
