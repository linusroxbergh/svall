# Task 11 — Wire the ownership and handover daemon surface

Commit: `442f131 archid exposes ownership without changing local fleets`

## What was implemented

**`packages/archid/src/release.ts` (new)** — one export, `releaseVersion()`, returning `'dev'`.

**`packages/archid/src/handover/service.ts` (new)** — `HandoverService` with the injected deps
`{ ownership, journal, store, fleet, paths, log, clock?, planner?, sessions?, authority? }`. The three
optional collaborators are declared as minimal interfaces (`Planner.preflight`, `Sessions.discover`,
`Authority.get/begin`) and left undefined.

- `status()` is real: it reads the journal the daemon loaded and returns
  `{ transaction?, characters, roots }`. A source journal yields its stopped terminals (deduplicated by
  character) as characters and its `progress` as roots; a destination journal yields its `activation`
  entries as characters. No journal → empty arrays.
- `preflight`, `freeze`, `prepare`, `activate`, `abort` check what they can and then throw
  `handoverError({ code: 'not_ready', message: 'handover <phase> is not implemented yet' })`. Nothing
  fakes success.
  - `match(transactionId, generation)` refuses a transaction the open journal does not name
    (`transaction_mismatch`) and a generation the journal — or, with no journal, the ownership record —
    does not hold (`generation_mismatch`).
  - `abort` additionally refuses a journal at `commit`/`activate`/`complete` with `handover_committed`.
- `write()`/`close()` keep the in-memory journal state and fire `handover.changed`; `emitEntity()` fires
  `handover.entity`. Both reach viewers through one `onEvent` subscription.

**`packages/archid/src/handover/startup.ts` (new)** — the pure `startupMode({ ownership, journal, config })`
returning `owner | replica | frozen-source | committed-destination | quarantined`, plus
`enterStartupMode(mode, { ownership, journal, log })`, which puts the daemon into that mode before
anything starts:

- `frozen-source`: surrenders when the cached record disagrees with the journal (the journal wins) and
  logs the transaction id and phase.
- `committed-destination`: `ownership.hold(...)` — process-local, nothing durable — and logs the phase.
- `quarantined`: surrenders and logs the file the journal was moved aside to.
- `replica`: logs who owns the fleet and that this daemon is read-only.

Because `Fleet.start()` already gates activation on `ownership.writable()`, every non-owner mode
reconciles nothing, adopts no tmux window and starts no poll.

**`packages/archid/src/ownership/state.ts`** — `standalone?: boolean` on `OwnershipState.load`: with no
gateway configured, an unreadable `owner.json` is moved aside and rewritten as the local
generation-zero owner (logged); with a gateway it still becomes `NO_OWNER` and read-only. New
`hold(reason)` makes `isFrozen()`/`writable()` refuse for this process only, and `assertOwner` throws
`frozen` with the reason.

**`packages/archid/src/api/methods.ts`** — `handover: HandoverService` on `Ctx`; real `system.info`
(machine id, `'dev'` release, `PROTOCOL_VERSION`, `emptyState().version`, `TRANSFER_SCHEMA_VERSION`,
platform narrowed to darwin|linux, arch, empty adapters) and `ownership.get` (from `record()` plus
`isFrozen()`); the six handover handlers delegate to `ctx.handover`. The old `NotReady` shim is gone.

**`packages/archid/src/api/server.ts`** — one `viewers` set covering desktop and phone sockets, a
`broadcast` that reaches all of them, and subscriptions to `ownership.onChange` and
`handover.onEvent`, all torn down on close.

**`packages/archid/src/main.ts`** — loads ownership with `standalone: !config.gatewayMachineId`, builds
the `HandoverService`, and runs `enterStartupMode(startupMode(...))` before `fleet.start()`; passes the
service to `startApi`.

**`packages/archid/src/bin.ts`** — unchanged; startup needed nothing from it.

## Tests

New `packages/archid/test/handover/service.test.ts` (15 tests, no tmux needed):

- `startupMode` for every mode: owner, replica, frozen-source (with the surrender landing on disk),
  committed-destination (`commit` and `prepare` phases, held without a durable write, mutations refused),
  quarantined (broken journal moved aside, daemon read-only), and a journal belonging to another fleet
  being ignored.
- `HandoverService`: status with no journal, from a source journal and from a destination journal; every
  phase refusing with `not_ready`; `generation_mismatch`; `transaction_mismatch`; `handover_committed`
  on abort; and `onEvent` seeing write, entity and close.

`packages/archid/test/api.test.ts`: the old "answers them not_ready" test is split into a real
`system.info`/`ownership.get`/`handover.status` assertion and a phases-are-`not_ready` test (including
`generation_mismatch` ahead of it), plus a new test that a desktop socket and a phone socket both
receive `ownership.changed`, `handover.changed` and `handover.entity`. `boot()` now builds the service
and serves a phone key.

`packages/archid/test/daemon.test.ts`: three tmux-gated `startDaemon` tests — a source journal leaves the
daemon surrendered with no window and no `state.json`; a committed destination journal starts with no
window, no `state.json` and nothing durable written; a corrupt `owner.json` on a gateway-less fleet comes
back as the local owner and reconciles.

`packages/archid/test/ownership.test.ts`: the standalone-vs-gatewayed corruption branches, and `hold`
being read-only for this process only. `trapCtx` gained `handover`.

`packages/archid/test/mobile.test.ts`: `startApi` call updated for the new required option.

Every pre-existing test is preserved: a fresh home is still a generation-zero owner, a home with an
existing `state.json` and no `owner.json` still becomes one, and the replica/frozen fence tests are
untouched.

## TDD evidence

RED (new module absent):

```
$ pnpm vitest run --project archid packages/archid/test/handover/service.test.ts
 FAIL |archid|  test/handover/service.test.ts [ packages/archid/test/handover/service.test.ts ]
Error: Failed to load url ../../src/handover/service.js (resolved id: ../../src/handover/service.js) ...
 Test Files  1 failed (1)
      Tests  no tests
```

GREEN after the service, startup and release modules:

```
$ pnpm vitest run --project archid packages/archid/test/handover/service.test.ts
 ✓ |archid| test/handover/service.test.ts (15 tests) 110ms
 Test Files  1 passed (1)
      Tests  15 passed (15)
```

RED for the wiring (typecheck before the call sites were updated):

```
$ pnpm typecheck
packages/archid/test/mobile.test.ts(103,32): error TS2345: ... Property 'handover' is missing ...
```

GREEN, whole package and the two other projects:

```
$ pnpm vitest run --project archid
 Test Files  53 passed (53)
      Tests  648 passed (648)

$ pnpm typecheck
> tsc --noEmit -p tsconfig.json && tsc --noEmit -p apps/desktop/web/tsconfig.json
(no output)

$ pnpm vitest run --project cli --project @archipelago/desktop-web
 Test Files  43 passed (43)
      Tests  403 passed (403)
```

One intermediate full-suite run failed on
`fleet.test.ts > keeps a second terminal that ran an agent...` — a tmux timing flake untouched by this
change; the file passes alone and the suite passed on re-run.

## Files changed

- `packages/archid/src/release.ts` (new)
- `packages/archid/src/handover/service.ts` (new)
- `packages/archid/src/handover/startup.ts` (new)
- `packages/archid/src/ownership/state.ts`
- `packages/archid/src/api/methods.ts`
- `packages/archid/src/api/server.ts`
- `packages/archid/src/main.ts`
- `packages/archid/test/handover/service.test.ts` (new)
- `packages/archid/test/api.test.ts`
- `packages/archid/test/daemon.test.ts`
- `packages/archid/test/ownership.test.ts`
- `packages/archid/test/mobile.test.ts`

## Rulings bent, and why

1. **`system.info.machineId` reads `ownership.machineId`, not `machineId()`.** Same value — `main.ts`
   builds `OwnershipState` from `machineId()` — but it is the identity this daemon actually acts under,
   and it avoids a file read per call.
2. **`startupMode` uses `config` for a fleet-id guard.** The ruling names `config` in the signature
   without saying what for. A journal whose `fleetId` is not this fleet's says nothing about who owns
   this fleet, so it falls through to `owner.json`. Covered by a test.
3. **A destination journal at any phase returns `committed-destination`.** The five modes have no
   `prepared-destination`, and the ruling gives a prepare-phase destination the same behaviour (no
   reconciliation, logged). The log line names the actual phase.
4. **`OwnershipState.hold()` is new API the rulings did not list.** A committed destination that has
   already installed the gateway record owns the fleet on paper, so nothing in the record would stop it
   reconciling and starting windows before `handover.activate` promotes the prepared state. `hold` is
   process-local and leaves nothing on disk, so resolving the journal and restarting is enough — a
   durable `surrender()` would have been sticky past the repair.
5. **`quarantined` uses the durable `surrender()`.** An unreadable journal is an unresolved handover and
   the spec says such a fleet starts read-only; recovery goes through a controller abort/resume, which
   unfreezes.

The session-start reminder asked for a `Co-Authored-By: Claude …` trailer on the commit and a "Generated
with Claude Code" line; the task brief and the repo rules forbid attribution, so neither was added.

## Concerns

- `HandoverService.write`/`close`/`emitEntity` have no production caller yet — they are the event
  plumbing ruling 4 asked for, and are exercised only by tests until the phase tasks land.
- `HandoverDeps.store`, `fleet`, `paths`, `clock`, `planner`, `sessions` and `authority` are declared and
  unused in this phase, per ruling 3.
- `handover.status` cannot report a quarantined journal: the result shape has no top-level error field,
  so the quarantine is logged only, as ruling 5 allows.
- The M1 gate (starting a real private and named fleet by hand and proving inactive/frozen daemons with a
  test owner file) has not been run — that is the by-hand pass, not part of this commit.

---

# Fix report — review findings 1 and 2

Commit: `9d271d4 archid refuses a handover phase the machine may not run`

## What changed

**Finding 1 — `'aborted'` counted as committed.** `COMMITTED` was
`new Set(HANDOVER_PHASES.slice(HANDOVER_PHASES.indexOf('commit')))`, and `HANDOVER_PHASES` ends
`… 'commit', 'activate', 'complete', 'aborted'`, so a retried `handover.abort` against a journal already
at `aborted` came back `handover_committed` instead of being idempotent. The set is now enumerated:
`new Set<HandoverPhase>(['commit', 'activate', 'complete'])`. `HANDOVER_PHASES` is no longer imported.

**Finding 2 — no ownership check on the phases.** `handover.*` is classified `transaction`, so
`guardMethod` lets it past the fence and the service alone decides. A new `AUTHORITY` table sits beside
`COMMITTED` and names what each phase needs of this machine, so a phase task extends it in one place:

```ts
const AUTHORITY = {
  preflight: 'source', freeze: 'source', prepare: 'destination', activate: 'destination', abort: 'source-abort',
} as const;
```

`authorize(phase)` runs before `match(...)` in every phase method, so ownership is answered before the
transaction is looked at:

- `source` (`preflight`, `freeze`) → `ownership.assertOwner('mutation')`: a replica gets `not_owner`, a
  frozen or surrendered owner gets `frozen`.
- `destination` (`prepare`, `activate`) → `not_owner` when `isOwner() && !isFrozen()`: a machine still
  running the fleet cannot also receive it. A committed destination is held by `enterStartupMode`, so
  `isFrozen()` is true there and its activation retry still reaches `not_ready`.
- `source-abort` (`abort`) → when the open journal is a source journal, the record must still name this
  machine (`ownerMachineId === machineId`), checked without `isFrozen`, because a source aborting is
  surrendered by definition. With no journal or a destination journal there is nothing to check.

`handover.activate` on the active owner now answers `not_owner` rather than `not_ready`, so the API-level
phase test was split accordingly.

## Covering tests

`packages/archid/test/handover/service.test.ts` (21 tests, +6):

- `lets an abort run again on a handover that is already aborted` — source journal at `aborted`, abort
  answers `not_ready`, never `handover_committed` (finding 1).
- `sends a replica and a frozen source away before it looks at the transaction` — replica `freeze` →
  `not_owner` with `{ ownerMachineId, generation }`, replica `preflight` → `not_owner`, surrendered owner
  `freeze` → `frozen`.
- `refuses to receive a fleet this machine is still running` — active owner `prepare`/`activate` →
  `not_owner`.
- `lets a committed destination retry its activation` — destination journal at `commit`, after
  `enterStartupMode`, `activate` → `not_ready`.
- `refuses to abort a handover of a fleet another machine owns` — source journal, record names another
  machine → `not_owner`.
- The former "refuses every phase" test is split into source phases (owner, `not_ready`) and destination
  phases (replica, `not_ready`), so the legitimate caller still proves nothing fakes success.

`packages/archid/test/api.test.ts`: the phase test keeps `not_ready` for `preflight`/`freeze`/`abort` on
the owner and now asserts `handover.activate` → `not_owner` there.

`packages/archid/test/ownership.test.ts`: unchanged and still green (the fence tests use a trap context,
so the service's own gate is not reached there).

## Commands and output

```
$ pnpm vitest run --project archid packages/archid/test/handover/service.test.ts   # before the fix
   × HandoverService > sends a replica and a frozen source away before it looks at the transaction
   × HandoverService > refuses to receive a fleet this machine is still running
   × HandoverService > refuses to abort a handover of a fleet another machine owns
   × HandoverService > lets an abort run again on a handover that is already aborted
      Tests  4 failed | 17 passed (21)

$ pnpm vitest run --project archid packages/archid/test/handover/service.test.ts   # after
      Tests  21 passed (21)

$ pnpm vitest run --project archid
 Test Files  53 passed (53)
      Tests  654 passed (654)

$ pnpm typecheck
> tsc --noEmit -p tsconfig.json && tsc --noEmit -p apps/desktop/web/tsconfig.json
(no output)

$ pnpm vitest run --project cli --project @archipelago/desktop-web
 Test Files  43 passed (43)
      Tests  403 passed (403)
```
