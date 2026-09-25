# Task 16 — Gateway authority compare-and-swap service

Branch `fleet-handover-task16`, one commit: `c3d0866 The gateway is the durable authority for fleet ownership`.

## What was implemented

**`packages/archid/src/gateway/authority.ts`**

- `gatewayPaths(prefix)` → `{ dir: <prefix>/gateway, fleets: <prefix>/gateway/fleets, socket: <prefix>/gateway/authority.sock }`.
- `OWNER_PARAMS`: a zod schema per op (`owner.get/create/begin/ready/commit/abort/complete`), with
  `owner.ready` requiring `sourceFrozen: true` and a `Sha256` `preparedDigest`. `OwnerOp`,
  `OwnerParamsOf<O>`, `OwnerParams` (the union) and `isOwnerOp` come off that table.
- `transition(record | undefined, op, params, now, newTransactionId?)` → `{ record } | { error }`, pure.
  Error codes: `not_found`, `already_exists`, `not_owner`, `generation_mismatch`,
  `transaction_mismatch`, `handover_committed`, `invalid_phase`, `invalid_request`,
  `authority_corrupt`, `internal`. Each carries the detail a caller needs (`expected`/`actual`
  generation, `expected`/`actual` transaction id, `ownerMachineId`, `phase`).
- `FleetAuthority(prefix, opts)`: one `DurableJson(OwnerRecord)` per fleet at
  `<prefix>/gateway/fleets/<fleetId>.json`, mode 0600, directories 0700. `apply(op, params)`
  serialises per fleet through a promise chain, loads, transitions, and writes the result before the
  promise resolves. A malformed record is renamed to `.broken-<ts>`, the fleet is marked quarantined,
  and every op on it answers `authority_corrupt` until a readable record is put back (the next read
  clears the mark, so repair needs no restart). The fleet id is `FleetId.parse`d before it becomes a
  path segment.

**`server.ts`** — `startAuthorityServer({ prefix, log?, durable? })`. Unix socket only, never a port;
socket chmod 0600 under a 0700 directory. A socket file no listener answers is removed; a live one
makes the start fail. One JSON object per line: `{ id, op, params }` → `{ id, result: { record } }`
or `{ id, error: { code, message, data? } }`. Requests on one connection are answered in arrival
order. A line that cannot be parsed or addressed, or more than 1 MiB without a newline, destroys that
connection alone; an unknown op or bad params get an `invalid_request` frame and the connection
lives. A write that throws becomes an `internal` frame — never a record.

**`client.ts`** — `AuthorityClient.connect(prefix, { timeoutMs = 10_000 })` over the same socket, one
typed method per op returning `OwnerRecord`, rejecting with `AuthorityFailure` (`code`, `message`,
`data`). Every call is bounded by a timer; a closed socket rejects everything outstanding.

**`bin.ts`** — `gatewayPrefix(env)` (`ARCHI_GATEWAY_PREFIX` or `~/.local/share/archipelago`),
`startGatewayFromEnv()`, and `main()` that starts the server and closes it on SIGTERM/SIGINT. No
top-level side effects, so tests and the coming CLI wrapper can import it.

**`packages/protocol/src/handover.ts`** — `TransactionRecord` gained `sourceFrozenAt?: number` and
`preparedDigest?: Sha256`; `Sha256` moved above `TransactionRecord` so it is defined where it is now
used. No other protocol change; `HandoverError` was left alone and the authority's codes stay local
to the gateway module.

**`packages/archid/package.json`** — exports `./gateway/authority`, `./gateway/server`,
`./gateway/client`, `./gateway/bin`.

## State machine as implemented

- `create`: only on an absent record → generation 0. An existing record is returned unchanged only
  when its owner matches and it is at generation 0; otherwise `already_exists`.
- `begin`: refuses from == to (`invalid_request`), a stale generation, a non-owner, a committed
  transaction (`handover_committed`), another party's open transaction (`transaction_mismatch`) and
  one already past `preparing` (`invalid_phase`). An identical open `preparing` transaction returns
  the same record.
- `ready`: generation and transaction id must match, phase `preparing` → `ready-to-commit` with
  `preparedDigest` and `sourceFrozenAt`. Already `ready-to-commit` on the same digest is idempotent;
  a different digest is `invalid_phase`.
- `commit`: only from `ready-to-commit` → owner becomes `toMachineId` at `g + 1`, phase `committed`.
  A repeat for the same transaction is answered with the committed record whether the caller sends
  `g` (it never saw the reply) or `g + 1`.
- `abort`: pre-commit only; `committed` → `handover_committed`; no open transaction at the expected
  generation is idempotent success.
- `complete`: phase `committed` at `g + 1` → transaction cleared, owner and generation kept; already
  cleared at that generation is idempotent.
- `get`: the record, or `not_found`.

## Tests and results

`packages/archid/test/gateway/authority.test.ts` (45 tests): a 30-row refusal table over every
op/phase/generation combination, the detail carried by `generation_mismatch` and
`transaction_mismatch`, each success transition, a replay of every op, and the store — a record that
survives a new `FleetAuthority`, 0600/0700 modes, the withheld answer, quarantine plus repair, and
two concurrent `begin`s of which exactly one wins.

`packages/archid/test/gateway/server.test.ts` (8 tests): a full begin→ready→commit→complete over a
real socket in a temp prefix (including a commit replay returning the identical record), the socket's
mode and bound address, refusal codes and their data reaching the caller, a malformed line and an
oversized line each closing only their own connection while another client keeps working, two
pipelined requests answered in order, a failed write answered as `internal`, taking over a dead
socket file while refusing a second live listener, and a call that times out.

- `pnpm vitest run --project archid --project protocol` → 65 files, 866 passed, 1 skipped, 0 failed.
- `pnpm typecheck` → clean.
- `pnpm vitest run --project archid test/gateway` → 67 passed (includes the untouched M0 relay spike).

## TDD evidence

1. The protocol test for `sourceFrozenAt`/`preparedDigest` was written first and failed
   (`preparedDigest`/`sourceFrozenAt` stripped by the schema) before `TransactionRecord` was extended.
2. Both gateway test files were written before `src/gateway/**` existed; with the implementation
   moved aside the suite fails to load (`Failed to load url ../../src/gateway/authority.js`, 2 files
   failed, no tests).
3. Mutation check that the tests bite: making `commit` not raise the generation and making the store
   skip its write turned 10 tests red across both files (commit, persistence, modes, withheld answer,
   concurrency, and five socket tests); reverting made them green again.

## Files changed

- `packages/archid/src/gateway/{authority,server,client,bin}.ts` (new)
- `packages/archid/test/gateway/{authority,server}.test.ts` (new)
- `packages/archid/package.json` (four exports)
- `packages/protocol/src/handover.ts`, `packages/protocol/test/handover.test.ts`

Untouched: `packages/cli`, `packages/archid/src/bin.ts`, and the M0 relay spike
(`test/gateway/fake-gateway.ts`, `relay-contract.test.ts`).

## Self-review findings, fixed before the commit

- An unused `authoritySocket` helper in `server.ts` was speculative API — removed.
- The `internal` log line claimed the failure happened "before it could be recorded", which is false
  for a failure after the rename — it now says the op did not complete.
- `AuthorityRequest.op` was typed `OwnerOp` before anything had checked it; it is a `string` that
  `isOwnerOp` narrows.
- `close()` unlinked the socket file after `server.close()`, which could delete a successor's socket;
  node already unlinks it (verified), so the call is gone.
- The server had no `error` handler once listening; one now logs.
- `FleetAuthority.dir` was public for no reason, and the record file was built twice per mutation.

## Concerns

- `test/fleet.test.ts` has two revive tests (`keeps a second terminal that ran an agent…`, `clears a
  stale agent status on revive`) that fail intermittently under full-suite load. They fail the same
  way on the base tree with this branch's changes reverted, and pass on reruns; they are tmux timing
  flakes, not this work.
- `from == to` on `begin` is reported as `invalid_request`, a code outside the seven the ruling
  enumerated. None of those seven describe a self-handover honestly. The code is local to the gateway
  module, as is `authority_corrupt`.
- `transition` takes an optional fifth argument, a transaction-id factory, so the table tests are
  deterministic; it defaults to `crypto.randomUUID`. `startAuthorityServer` takes an optional
  `durable` so a test can prove a failed write is never answered with a record.
- The quarantine mark lives in the process. A restarted gateway re-reads the fleet and, finding the
  record gone, would treat `owner.create` as a fresh fleet. The `.broken-<ts>` file is the only trace
  on disk. The follow-up that finishes `host enable` may want that refusal to survive a restart.
- Backpressure is not handled: a client that pipelines without reading grows the per-connection reply
  queue. The 1 MiB line cap bounds a single request, not the queue.

## Fix round 1

Finding 1 (quarantine refusal did not survive a restart, and a read error moved a good record aside).

### What changed

`packages/archid/src/gateway/authority.ts` — `FleetAuthority.load` only.

- **Marker shape:** a sibling file `<prefix>/gateway/fleets/<fleetId>.json.quarantined`, written through
  `writeDurable` (same-directory temp, fsync, rename, dir fsync, mode 0600, the injected `durable`
  stages). It holds `{ fleetId, quarantinedAt, movedTo, error }` — enough for an operator to find the
  `.broken-<ts>` file and the reason. It is written *before* the record is renamed aside, so a crash
  can never leave the fleets directory holding an absence with no refusal beside it.
- **The refusal is now a fact on disk:** the `missing` branch refuses with `authority_corrupt` when the
  in-memory mark is set **or** the marker file exists, so every op on that fleet — `owner.create`
  included — is refused by a `FleetAuthority` constructed fresh on the same prefix.
- **Repair path (unchanged for the operator):** put a readable record back at `<fleetId>.json`. The next
  successful read clears the in-memory mark and removes the `.quarantined` file. Nothing else to do,
  and no restart needed. Documented in a one-line comment at the `read.ok` branch.
- **A record that cannot be read is no longer moved aside.** `DurableJson.read` cannot distinguish an
  EACCES/EIO from bad bytes (`durable.ts:98-103` returns `malformed` for both), so rather than widening
  its contract the gateway makes the cheap distinction itself: on `malformed` it tries to read the
  file's bytes. Bytes it can read and `read()` would not parse are corrupt → marker + rename. A file
  whose bytes it cannot read may be a good record behind a transient IO failure → the fleet is refused
  in memory and the record is left exactly where it is, so the failure clearing is the whole repair.

### TDD evidence

RED — `pnpm vitest run --project archid packages/archid/test/gateway/authority.test.ts`:

```
 FAIL  test/gateway/authority.test.ts > the record store > refuses a quarantined fleet to a gateway that starts after the quarantine
AssertionError: expected 'not_found' to be 'authority_corrupt' // Object.is equality
 FAIL  test/gateway/authority.test.ts > the record store > leaves a record it cannot read where it is
AssertionError: expected [ Array(1) ] to deeply equal [ Array(1) ]
-   "3f1a0b1c-….json"
+   "3f1a0b1c-….json.broken-1790089290531"
 Test Files  1 failed (1)
      Tests  2 failed | 45 passed (47)
```

`not_found` is the finding verbatim: a restarted gateway would have let `owner.create` mint a fresh
generation-0 record for whoever asked.

GREEN — same command: `Test Files 1 passed (1) / Tests 47 passed (47)`.

### Covering tests

`packages/archid/test/gateway/authority.test.ts`:

- `refuses a quarantined fleet to a gateway that starts after the quarantine` — corrupts the record,
  quarantines it through one instance, then constructs a second `FleetAuthority` on the same prefix and
  asserts `owner.get`, `owner.create` (with a *different* owner) and `owner.begin` all answer
  `authority_corrupt`; then repairs the record, asserts the fleet answers again and that the
  `.quarantined` marker is gone.
- `leaves a record it cannot read where it is` — `chmod 000` on a good record, asserts the op is refused
  and that the fleets directory still holds exactly `<fleetId>.json` (no `.broken-`, no marker), then
  restores the mode and asserts the record reads back at generation 0. The seam is the real filesystem,
  not a module mock.

### Verification

- `pnpm vitest run --project archid packages/archid/test/gateway/server.test.ts` → 8 passed.
- `pnpm vitest run --project archid` → `Test Files 57 passed (57) / Tests 764 passed | 1 skipped (765)`.
  The two `test/fleet.test.ts` revive flakes noted above did not fire this run.
- `pnpm typecheck` → clean.

### Concerns

- A transient read failure that clears between `DurableJson.read` and the byte check would still be
  treated as corrupt (the bytes are readable by then, and `read()` already said they are not a record).
  Closing that window means either re-reading through the schema — a blind retry that does not help the
  persistent EACCES case the finding is about — or a `reason: 'unreadable'` on `DurableRead`, which is
  the contract widening the ruling asked me not to do.
- If the marker write succeeds and the rename then fails, the marker exists while the corrupt record is
  still in place. The fleet is refused either way, and the next load retries the rename.
- The marker is per fleet, not per prefix: a corrupt record for one fleet never refuses another.
