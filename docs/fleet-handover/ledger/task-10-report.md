# Task 10 — Local ownership state and the complete mutation fence

## What was implemented

**`packages/archid/src/ownership/state.ts`**

- `OwnerCache = OwnerRecord.extend({ frozen: z.literal(true).optional(), surrendered: z.literal(true).optional() })`,
  persisted at `paths.owner` through `DurableJson` at mode 0600.
- `OwnershipState.load({ paths, fleetId, machineId, log })`:
  - record present and valid → cached as-is;
  - absent → writes and returns `{ fleetId, generation: 0, ownerMachineId: machineId }`;
  - malformed → renames the file to `owner.json.broken-<ts>`, logs, and writes a record naming the nil
    machine id as owner. The daemon is therefore read-only, and stays read-only across restarts: a
    corrupt record is never allowed to look like a fresh fleet on the next start.
- `record()`, `isOwner()`, `isFrozen()`, `writable()` (owner and not frozen), `assertOwner(kind)`,
  `freeze(tx)`, `surrender()`, `unfreeze()`, `installCommitted(record)`, `onChange(fn)`.
- `assertOwner` order: a committed transaction naming another machine → `handover_committed` (final and
  more informative than the freeze it left behind); then `not_owner`; then `frozen`.
- `freeze`/`surrender`/`unfreeze`/`installCommitted` are `async` and persist through the durable writer
  before resolving; `onChange` listeners fire on every persisted change (Task 11 broadcasts from there).

**`packages/archid/src/ownership/guard.ts`**

- `classification: Record<MethodName, 'read' | 'mutation' | 'terminal' | 'transaction'>` — exhaustive by
  type, so a new protocol method without a class fails `pnpm typecheck`. Classes exactly as ruled.
- `guardMethod(ownership, method)` — read and transaction pass; mutation → `assertOwner('mutation')`;
  terminal → `assertOwner('terminal')`.

**Wiring**

- `Ctx` carries `ownership`. `dispatch` calls `guardMethod` inside the `try`, **ahead of parameter
  parsing**, so a refusal never depends on the shape of the parameters and the handler is never reached.
- `startApi` takes `ownership` and passes it into both dispatch sites (socket and `/rpc`).
- `startDaemon` builds it from `config.id` and `machineId()` and hands it to `Fleet` and `startApi`.
- `Fleet` takes an `ownership` dep and a private `writable()`:
  - `start()` returns right after `tmux.ensureServer()` when this machine is not the owner — no
    reconciliation, no home-island write, no control client, no poll;
  - `reconcileNow()` and `tick()` return early unless `writable()` (this also covers the `recover()`
    path and, through `tick`, `scribe.tick()` and the periodic `refreshLinks` fan-out);
  - `onSocketEvent` is ignored on a non-owner but still applies agent status while frozen, so the freeze
    step can watch terminals settle; the `followCwd` link refresh it triggers is gated on `writable()`.

**Not modified, deliberately**: `terminals.ts` and `workspace/workspace.ts`. `TerminalHub.open/attach`,
`Workspace.write`, `Fleet.createCharacter/reviveCharacter/openSecond` have exactly one caller each —
`handlers` in `methods.ts` — so the dispatch fence already sits ahead of every side effect (verified by
grep over `packages/archid/src` and `packages/cli/src`). A second check inside them would be dead code.
Same reasoning for `Scribe.tick`/`Scribe.sweep`: `tick` is only reached through the gated `Fleet.tick`,
and `sweep` only through the `scribe.sweep` RPC, which is classified `mutation`.

## Tests

`packages/archid/test/ownership.test.ts` (12 tests):

- generation-zero local ownership on a home with no record, including 0600 on disk;
- `not_owner` with `{ ownerMachineId, generation }` in `data` for a record naming another machine;
- a corrupt record: moved aside byte-exact, owns nothing, and still owns nothing on the next load;
- `freeze` — the file already shows `frozen: true, surrendered: true` and the transaction when the
  promise is read, before it is awaited; still frozen after a reload;
- `surrender` / `unfreeze` / `installCommitted` round trip, on the object and on disk;
- a committed transaction reports `handover_committed`, not `frozen`;
- `onChange` fires per persisted change and stops after unsubscribe;
- **exhaustive fence**: `Object.keys(classification)` equals `Object.keys(methods)`; every `mutation` and
  `terminal` method dispatched against an inactive context answers `not_owner` and against a frozen
  context answers `frozen`; every `read` and `transaction` method answers something that is neither.
  The context's services are Proxies that throw `handler_reached` on any property access or call, so a
  refusal code proves the handler never ran, and a leak through the fence shows up as `handler_reached`.
- **inactive replica, end to end** (needs tmux): a daemon started on a home whose `owner.json` names
  another machine, over a real WebSocket — `state.get`, `char.show`, `char.read` (transcript) and
  `repo.status` all answer from the imported snapshot, while `island.create`, `char.create`,
  `term.attach`, `fs.write` and `browser.open` each answer `not_owner`; `state.json`'s mtime is unchanged
  and `tmux list-windows` is empty.

Existing suites: `test/helpers.ts` gained `ownerOf(home, fleetId)`, and the six test `Fleet`
constructions plus the two `startApi` calls pass it. Those homes have no `owner.json`, so they become
generation-zero local owners and behave exactly as before.

## TDD evidence

RED — test written before any of `src/ownership/*`:

```
$ pnpm vitest run --project archid test/ownership.test.ts
 FAIL |archid|  test/ownership.test.ts [ packages/archid/test/ownership.test.ts ]
Error: Failed to load url ../src/ownership/guard.js (resolved id: ../src/ownership/guard.js) ...
 Test Files  1 failed (1)
      Tests  no tests
```

GREEN:

```
$ pnpm vitest run --project archid test/ownership.test.ts
 ✓ |archid| test/ownership.test.ts (12 tests) 294ms
 Test Files  1 passed (1)
      Tests  12 passed (12)
```

Full verification:

```
$ pnpm vitest run --project archid
 Test Files  52 passed (52)
      Tests  623 passed (623)

$ pnpm typecheck
> tsc --noEmit -p tsconfig.json && tsc --noEmit -p apps/desktop/web/tsconfig.json
(no output)

$ pnpm vitest run --project cli --project @archipelago/desktop-web
 Test Files  43 passed (43)
      Tests  403 passed (403)
```

## Files changed

- new `packages/archid/src/ownership/state.ts`
- new `packages/archid/src/ownership/guard.ts`
- new `packages/archid/test/ownership.test.ts`
- `packages/archid/src/api/methods.ts`, `packages/archid/src/api/server.ts`
- `packages/archid/src/main.ts`, `packages/archid/src/fleet.ts`
- `packages/archid/test/helpers.ts` and the six suites that build a `Fleet` or call `startApi`

## Self-review

- Every store, filesystem, browser and terminal mutation path is fenced before its side effect: the RPC
  surface at `dispatch` ahead of parsing, and every background writer (`reconcileNow`, `tick`, the
  scribe and link refresh reached from `tick`, `followCwd`) behind `writable()`.
- Reconciliation cannot run at all on an inactive replica: `start()` leaves before it, and
  `reconcileNow()` refuses even if something else calls it (the `recover()` path).
- The classification table is exhaustive by type and by test.
- Tests exercise `dispatch` and a real daemon, never the handlers directly.
- `pnpm typecheck`, the three suites and the archid run are clean; no lint script exists in this repo.

## Concerns / rulings bent

1. **The guard runs before parameter parsing**, not between parsing and the handler. Ruling 2 only says
   "before the handler". Fencing first means a refusal never depends on the parameters and no parsing
   work happens for a call this machine may not make; the cost is that a malformed mutation from a
   non-owner answers `not_owner` rather than `invalid_params`. The exhaustive test relies on this, since
   it dispatches every method with `{}`.
2. **`terminals.ts`, `workspace.ts` and `scribe.ts` were not modified**, though the brief's file list
   named them. Reasoning above: every one of their mutating entry points has exactly one caller, already
   behind the fence. Say the word and I will add the redundant checks.
3. **A corrupt `owner.json` is written back as owned by the nil machine id.** This is what keeps the
   daemon read-only across restarts instead of silently reclaiming ownership on the next start, and it
   matches the spec's "recovery requires `archi fleet recover --force-owner`; it is never automatic".
   The consequence is real: a standalone fleet that corrupts its record needs that command to run again.
4. **A frozen daemon stops its whole poll**, not only the store writes inside it. That also pauses the
   stale `v-` session sweep, which is tmux housekeeping rather than fleet state; it resumes on unfreeze.
5. `freeze`/`surrender`/`unfreeze`/`installCommitted` are `async` over a synchronous durable write —
   uniform for Task 11's handlers, and `freeze` genuinely has the bytes on disk before it resolves.

---

# Fix report — three Important review findings

## Finding 1: the control client's `window-close` handler was ungated

`packages/archid/src/fleet.ts`, in `attachControl`: `c.on('window-close', …)` now returns immediately
unless `writable()`. Its two `store.update` calls (`markDormant`, `loseSecond`) were the one writer that
a frozen owner still reached, and freeze is exactly when windows close.

Covering test — `packages/archid/test/ownership.test.ts`, `a frozen fleet > leaves a window that closes
under it alone`: an owner boots with a real tmux control client and a live character, freezes, settles,
then the character's window is killed. The character keeps its tmux ids, the serialized state is
byte-identical and `state.json`'s mtime has not moved.

## Finding 2: `freeze()` resolved with background writers still in flight

`Fleet` now keeps a `background: Set<Promise<unknown>>` and a private `track(work, what)` that swallows
and logs failures, so nothing tracked can reject. Everything fired off the critical path goes through it:
the poll's `tick`, the link refreshes at both former `void refreshLinks(...)` sites (now one private
`refresh(charId)`), and the `followCwd` launched from `onSocketEvent`. `Scribe` gained `settled()`, which
waits out the automatic pass and the sweep in flight.

`Fleet.settle(): Promise<void>` drains the set (looping, since a tracked task can start another) and then
awaits `scribe.settled()`. Its one-line contract, on the method: *after a freeze, none follows it* — i.e.
after `ownership.freeze()` then `fleet.settle()`, no background store write lands.

`Deps` gained an optional `refreshLinks?: RefreshLinks`, the seam the test needs (the same shape as the
existing `runScribe` injection).

Covering test — `a frozen fleet > settles the background writes that were already running when it froze`:
a `refreshLinks` that blocks on a gate and then writes a note. A character is created (its refresh starts
and blocks), the fleet freezes, `settle()` is started but observed not to resolve while the note is still
unwritten; the gate opens; `settle()` resolves and the note is there; two more poll intervals pass and the
serialized state does not change again.

## Finding 3: a daemon that became owner while running stayed inert

`start()` is now the gate alone: `ensureServer()`, then `activate()` when `writable()`. It also gates on
`writable()` rather than `isOwner()`, so a frozen owner no longer writes the home island at boot.

`activate(): Promise<void>` is public and idempotent — it memoizes `begin()`, which does `reconcileNow`,
`ensureHome`, `attachControl` and starts the poll. A second call returns the same promise and starts
nothing. `stop()` is unchanged and still tears down the interval and the control client. Nothing
subscribes to `ownership.onChange` here; a later task calls `activate()` after installing a committed
record.

Covering test — `a replica that becomes the owner > reconciles and polls only once activate is called,
however often it is called`: boots against an `owner.json` naming another machine, asserts the store is
still empty 300 ms later, installs a committed record naming this machine, calls `activate()`, and then
sees mission control created, a character run and its output read back through the control client. A
second `activate()` leaves `tmux.connect` called exactly once (so no second control client and no second
interval) and reconciles nothing again.

## Evidence the tests catch the regressions

With the `window-close` gate removed and `settle()` reduced to a no-op:

```
$ pnpm vitest run --project archid test/ownership.test.ts
   × a frozen fleet > leaves a window that closes under it alone 511ms
   × a frozen fleet > settles the background writes that were already running when it froze 286ms
      Tests  2 failed | 13 passed (15)
```

With `activate()` made non-idempotent (`return this.begin()`):

```
$ pnpm vitest run --project archid test/ownership.test.ts
   × a replica that becomes the owner > reconciles and polls only once activate is called, however often it is called
     → expected "connect" to be called 1 times, but got 2 times
      Tests  1 failed | 14 passed (15)
```

## Verification after the fixes

```
$ pnpm vitest run --project archid test/ownership.test.ts
 ✓ |archid| test/ownership.test.ts (15 tests) 2283ms
      Tests  15 passed (15)

$ pnpm vitest run --project archid
 Test Files  52 passed (52)
      Tests  626 passed (626)

$ pnpm typecheck
> tsc --noEmit -p tsconfig.json && tsc --noEmit -p apps/desktop/web/tsconfig.json
(no output)

$ pnpm vitest run --project cli --project @archipelago/desktop-web
 Test Files  43 passed (43)
      Tests  403 passed (403)
```

`test/fleet.test.ts`, `test/api.test.ts` and `test/daemon.test.ts` are inside that archid run and pass
unchanged.

## Files changed in the fix

- `packages/archid/src/fleet.ts` — the gate, `activate`/`begin`, `track`/`settle`/`refresh`, the
  `refreshLinks` dep
- `packages/archid/src/scribe/scribe.ts` — `settled()`
- `packages/archid/test/ownership.test.ts` — three tests (15 total)

## Note

`activate()` memoizes a rejected `begin()` too, so a failed activation is not retried in place. That
matches the old behaviour: `startDaemon` tears the daemon down when `start()` throws, and a lost control
client is still recovered separately by `recover()`.
