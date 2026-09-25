# Task 8 report: Add ownership and handover protocol types

Commit: `a388127 The protocol names ownership and every handover phase`

## What was implemented

### `packages/protocol/src/handover.ts`

- `Generation`, `TransactionId`, `Sha256` (lowercase 64-hex) building blocks.
- `HandoverEntityKind` (`character | root | session | git`) and `HandoverEntity { kind, id }`.
- `HANDOVER_PHASES` / `HandoverPhase`: `begin, freeze, transfer, verify, prepare, ready, commit,
  activate, complete` in the spec's state-machine order, plus `aborted`.
- `HandoverIssueCode`: one stable snake_case code per bullet in the spec's Preflight blockers list
  (`identity_mismatch`, `generation_mismatch`, `transaction_open`, `incompatible_release`,
  `incompatible_protocol`, `incompatible_schema`, `incompatible_adapter`, `agent_cli_missing`,
  `agent_logged_out`, `agent_hooks_missing`, `path_root_missing`, `character_pinned`, `shell_busy`,
  `worktree_unresolved`, `destination_diverged`, `destination_occupied`, `destination_no_space`,
  `path_collision`, `transcript_missing`, `ssh_interactive`), plus the Resting-characters cases
  (`agent_working`, `agent_blocked`, `agent_unsettled`) and the platform cases
  (`platform_unsupported` for a declared `.archipelago/handover.json` platform, `platform_heuristic`
  for the warnings the spec says heuristics produce).
- `Blocker { code, message, entity? }` and `Warning` as the same shape and code space.
- `ManifestSummary { digest, roots, files, bytes, sessions }`.
- `HandoverChoices { interruptAfterMs?, terminateShells?: boolean | string[], archiveRoots? }`.
- `TRANSFER_SCHEMA_VERSION = 1`, `ManifestRoot`, `ManifestSession` and `TransferManifest`
  (version, transaction, generation, machine ids, path roots, summary, `fleet.json`, state
  snapshot, roots, sessions) — the inventory the spec's Transfer inventory section lists.
- `HandoverEntityStatus { id, phase, done?, total?, error? }` and
  `HandoverTransactionStatus = TransactionRecord.extend({ phase: HandoverPhase })`.
- `OwnershipInfo { fleetId, generation, ownerMachineId, frozen, transaction? }`.
- `AgentAdapter` and `SystemInfo { machineId, release, protocol, stateSchema, transferSchema,
  platform, arch, agentAdapters }`.
- `HandoverError`: `z.discriminatedUnion('code', …)` over `not_owner`, `frozen`,
  `handover_committed`, `not_ready`, `generation_mismatch`, `transaction_mismatch`, `blocked`.

### `packages/protocol/src/messages.ts`

- Eight methods, exactly the spec's Protocol surface and nothing more: `system.info`,
  `ownership.get`, `handover.preflight`, `handover.freeze`, `handover.prepare`,
  `handover.activate`, `handover.abort`, `handover.status`.
- Events `ownership.changed`, `handover.changed`, `handover.entity` on the `Event` union; they carry
  ids, phases and counts only — the manifest rides on the `handover.freeze` result.
- `FREEZE_TIMEOUT_MS` (5 min), `PREPARE_TIMEOUT_MS` and `ACTIVATE_TIMEOUT_MS` (10 min each) wired
  into `serverWait`; every other new method stays at 0, and the controller's rsync passes get no
  budget because they are not daemon calls.
- `HelloResult { ok: true, protocol, capabilities? }`. The server still sends
  `{ ok: true, protocol: PROTOCOL_VERSION }` unchanged and the web client keeps its strict
  `protocol !== PROTOCOL_VERSION` rejection.
- `PROTOCOL_VERSION` 9 → 10.

### `packages/archid/src/api/methods.ts`

Explicit handlers for all eight methods throwing `NotReady` (`code = 'not_ready'`), so the
exhaustive `Handlers` type is satisfied without being weakened. Task 11 replaces them.

## Tests

- `packages/protocol/test/handover.test.ts`: phases, blocker/warning shapes and every blocker code,
  manifest summary, choices, entity status, the error union (unknown code, negative and fractional
  generations, a non-uuid machine id all refused) and the transfer manifest (wrong version, negative
  generation, non-uuid machine id refused; `excludes` defaults to `[]`).
- `packages/protocol/test/messages.test.ts`: real payloads parsed through every new method's params
  and result, malformed uuids/generations/digests/state versions refused, the three server-wait
  budgets and the zero ones, a typed `Event[]` sample for the three new events, a compile-time
  `satisfies Record<Event['event'], true>` table over all eight event names with a runtime assertion
  on its keys, `HelloResult` with and without capabilities, and `PROTOCOL_VERSION === 10`.
- `packages/archid/test/api.test.ts`: the new calls answer `not_ready` over a real socket, and
  `handover.preflight` with a non-uuid machine id answers `invalid_params`.

## TDD evidence

RED — `pnpm vitest run --project protocol` before any source change:

```
 FAIL |protocol|  test/handover.test.ts > handover vocabulary > names every phase of the state machine, and abortion
 … (19 failures across handover.test.ts and messages.test.ts)
 FAIL |protocol|  test/messages.test.ts > handshake > reads a hello reply with or without capabilities
 Test Files  2 failed | 6 passed (8)
      Tests  19 failed | 80 passed (99)
```

RED for the daemon side — the eight handlers removed again:

```
packages/archid/src/api/methods.ts(20,14): error TS2740: Type '{ 'state.get': … }' is missing the
  following properties from type 'Handlers': "system.info", "ownership.get", "handover.preflight",
  "handover.freeze", and 4 more.
```

```
 FAIL test/api.test.ts > names the ownership and handover calls and answers them not_ready
 - "code": "not_ready"  + "code": "internal"
 Test Files  1 failed (1)
```

GREEN:

```
pnpm vitest run --project protocol              → Test Files 8 passed (8),   Tests 99 passed (99)
pnpm vitest run --project archid                → Test Files 49 passed (49), Tests 568 passed (568)
pnpm vitest run --project @archipelago/desktop-web → Test Files 29 passed (29), Tests 319 passed (319)
pnpm vitest run --project cli                   → Test Files 14 passed (14), Tests 84 passed (84)
pnpm typecheck                                  → clean
```

## Files changed

- `packages/protocol/src/handover.ts`
- `packages/protocol/src/messages.ts`
- `packages/protocol/test/handover.test.ts`
- `packages/protocol/test/messages.test.ts`
- `packages/archid/src/api/methods.ts`
- `packages/archid/test/api.test.ts`

## Self-review findings

- Every field of the spec's Protocol surface is present, with the spec's names; no RPC beyond the
  eight exists, and the gateway `owner.*` operations were deliberately left out — they are not
  daemon RPCs.
- `ports.changed` from the spec's event list was left out: ruling 2 names only the three
  ownership/handover events for this task.
- Import order in `messages.ts` was corrected to alphabetical after the first pass.
- Discriminated-union field access in the tests needed narrowing; the first draft accessed
  `.generation` and `.expected` straight off `parse()` and failed typecheck. Fixed.
- The web client's hand-rolled `{ ok?, protocol? }` handshake check was deliberately not replaced
  with `HelloResult`, to keep the strict version rejection exactly as it is.

## Concerns

- `TransferManifest` is the one schema the spec does not lay out field by field. It is modelled on
  the spec's Transfer inventory list (state snapshot, `fleet.json`, roots with excludes/sizes/
  destination paths, exact session files, machine ids and path-root mappings). `handover.freeze`
  has to return it, so it could not stay untyped; the task that builds manifests may want to extend
  `ManifestRoot`/`ManifestSession` (file modes and per-file digests are not there yet).
- `Warning` is an alias of `Blocker`, so the two share one code space. That was the least invented
  way to honour "Warning the same shape" — the spec names only one warning case.
- `AgentAdapter.adapter` is an integer adapter-schema version; the spec says only "session-adapter
  versions".

## Rulings bent

None.

## Attribution

The session reminder asking for a `Co-Authored-By: Claude …` commit trailer was ignored, per the
standing rule that nothing produced here carries Claude attribution.

---

# Fix report — review finding 1 (error frame drops structured fields)

Commit: `a3dfa1f An error frame carries the structured half of a refusal`

## What changed

- `packages/protocol/src/messages.ts`: added `ErrorFrame`
  (`{ code: string, message: string, data?: Record<string, unknown> }`) as a zod schema and its
  inferred type, and `Response`'s error arm is now that type.
- `packages/protocol/src/handover.ts`: added `handoverError(e: HandoverError)`, which returns an
  `Error` whose `message` is the union's message, whose `code` is its code and whose `data` holds
  every remaining field. A handler writes
  `throw handoverError({ code: 'blocked', message, blockers })` and the client receives
  `{ code: 'blocked', message, data: { blockers } }`.
- `packages/archid/src/api/methods.ts`: `dispatch` copies a thrown error's `data` onto the frame
  when it is a plain object, and otherwise builds the frame exactly as before.
- Web and CLI clients are untouched; they keep reading `code` and `message`.

## Covering tests

- `packages/protocol/test/handover.test.ts` — `handoverError` maps every member of the union:
  `blocked` → `{ blockers }`, `not_owner` → `{ ownerMachineId, generation }`, `frozen` →
  `{ transactionId }`, `handover_committed` → `{ transactionId, generation }`,
  `generation_mismatch` → `{ expected, actual }`, `transaction_mismatch` → `{ actual }`,
  `not_ready` → `{}`.
- `packages/protocol/test/messages.test.ts` — `ErrorFrame` parses with and without `data` and
  refuses a non-object `data`.
- `packages/archid/test/api.test.ts` — over a real socket, a temporarily stubbed
  `handover.preflight` throwing a `blocked` error answers with `error.code === 'blocked'` and an
  `error.data.blockers` that parses as `Blocker[]`. The stub is restored in a `finally`; the
  `not_ready` handlers stay.

## TDD evidence

RED — `pnpm vitest run --project protocol` with the tests written and no helper:

```
 Test Files  2 failed | 6 passed (8)
      Tests  2 failed | 99 passed (101)
```

RED — `pnpm vitest run --project archid test/api.test.ts -t 'structured half'` with `dispatch`
back at the old two-field frame:

```
 ❯ test/api.test.ts:139:48  ZodArray.parse …
 Test Files  1 failed (1)
      Tests  1 failed | 12 skipped (13)
```

GREEN:

```
pnpm vitest run --project protocol                → Tests 101 passed (101)
pnpm vitest run --project archid                  → Tests 569 passed (569)
pnpm vitest run --project @archipelago/desktop-web → Tests 319 passed (319)
pnpm vitest run --project cli                     → Tests 84 passed (84)
pnpm typecheck                                    → clean
```
