# Task 9 — Durable Store replacement and transaction journals

Commit: `4399faf Fleet snapshots and handover journals survive process death`

## What was implemented

**`packages/archid/src/handover/durable.ts`** (new)

- `DurableStages` — the five write boundaries (`open`, `write`, `fsyncFile`, `rename`, `fsyncDir`)
  with `realStages` defaults, injectable per call so a test can stop a write after any one of them.
- `writeDurable(file, Buffer | object, { mode?, stages? })` — mkdir, exclusive (`wx`) temp beside the
  file at mode 0600, write, fsync the file, close, rename, fsync the parent directory. The parameter
  is `Buffer | object` exactly as the ruling names it: a Buffer is written raw, anything else is
  JSON-encoded (`JSON.stringify(v, null, 2) + '\n'`, unchanged from the old `writeJsonAtomic`).
- `syncDir(dir, stages?)` — the directory fsync with the swallow list (`EISDIR`, `EPERM`, `EINVAL`,
  `ENOTSUP`). Only the directory fsync swallows; the file fsync never does.
- `DURABLE_TEMP` — `/\.durable-\d+-[0-9a-f]{8}\.tmp$/`, the pattern that names only this writer's
  temps.
- `cleanupDurableTemps(dir, maxAgeMs = 24h)` — removes a matching temp only when its sibling final
  file exists with an mtime at least as new, or when the temp is older than the bounded age. Anything
  it cannot prove finished is left alone; a non-existent directory is a no-op.
- `DurableJson<T>` — a zod schema plus a path. `read()` returns `{ ok: true, value }` or
  `{ ok: false, reason: 'missing' | 'malformed', error? }` (a schema rejection is `malformed`);
  `write(value)` validates first, then `writeDurable`s.

**`packages/archid/src/handover/journal.ts`** (new)

- `SourceJournal` / `DestinationJournal` zod schemas with the fields the brief names, and
  `HandoverJournal` as the discriminated union on `role`. Source carries `manifestDigest?`,
  `stoppedTerminals`, `error?`, `progress?`; destination requires `manifestDigest` and carries
  `preparedPath?` and `activation?`.
- `JournalFile` / `openJournal(paths, opts?)` — `load()` returns `{ kind: 'none' }`,
  `{ kind: 'open', journal }` or `{ kind: 'quarantined', file }`; a malformed or schema-rejected
  journal is renamed to `journal.json.broken-<ts>` (dir-fsynced) and reported, leaving no journal in
  place for a caller to mistake for writable. `write(journal)` goes through `DurableJson` at mode
  0600. `close()` unlinks the journal and fsyncs the directory. `load()` also runs
  `cleanupDurableTemps` over `handoverDir` — that is the "startup of a durable location" hook.

**`packages/archid/src/paths.ts`**

- `handoverDir: <home>/handover`, `journal` repointed to `<home>/handover/journal.json`, and
  `preparedState(transactionId)` → `<home>/handover/prepared-<id>.json`. `owner` and `replicas`
  unchanged.

**`packages/archid/src/atomic.ts`**

- `writeJsonAtomic(file, value)` keeps its signature and now delegates to `writeDurable` at mode
  0600, so there is one writer in the daemon. Callers (`machine.ts`, `config.ts`, the CLI registry)
  gain the fsync for free.

**`packages/archid/src/store.ts`**

- `replace(snapshot)` — `FleetState.parse`, one `jsonpatch.compare(current, snapshot)`, persist,
  swap, then emit that one ops array. Never merges: entities absent from the snapshot come out as
  `remove` ops.
- `promote(preparedFile)` — validates the prepared file, `rename`s it onto `state.json`, fsyncs the
  directory, then `replace`s from the read-back file. A prepared file that does not validate is left
  where it is and `state.json` is untouched.
- `static readSnapshot(file)` — validates a prepared file without making it active.
- `persist(state)` now takes the state to write and goes through `writeDurable` (mode 0600), and both
  `update` and `replace` funnel through one private `commit(next, ops)` that persists *before*
  swapping `current` and *before* any listener runs. A failed persist therefore rethrows with
  `current` unchanged and no listener told.
- `Store.load` runs `cleanupDurableTemps` over the state directory.

## Tests and results

New: `packages/archid/test/handover/durable.test.ts` (18), `test/handover/journal.test.ts` (9).
Extended: `test/store.test.ts` (+9), `test/config.test.ts` (paths assertion).

Durability boundaries covered by injected failure:

| injected failure after | asserted outcome |
| --- | --- |
| `open` | `state.json` is the whole old content; a temp is left and cleanup keeps it (unprovable) |
| `write` | whole old content; the temp is collected once the next write finishes |
| `fsyncFile` | whole old content |
| `rename` | whole new content |
| `fsyncDir` | whole new content; a platform `EPERM` is swallowed and the write succeeds |

Journal: write with a failure injected after the rename, before the directory fsync, then reload —
the phase written is the phase read back. Quarantine of both malformed JSON and a schema-rejected
journal, `close()` followed by a `none` load, and a second `close()` that does not throw.

Store: snapshot rejection leaves state alone; one patch with the right `remove` ops and the file on
disk agreeing; a throwing listener does not prevent persistence; a persist that fails (containing
directory chmod 0500) rethrows with `current` unchanged and no listener told; promote replaces the
live state and removes the prepared file; a prepared file that does not validate is left in place.

### TDD evidence

RED — `pnpm vitest run --project archid test/store.test.ts test/handover/journal.test.ts test/handover/durable.test.ts test/config.test.ts`

```
 ❯ |archid| test/handover/durable.test.ts (0 test)
 ❯ |archid| test/config.test.ts (5 tests | 1 failed) 19ms
   × config and paths > derives all paths from home
     → expected [ '/x/owner.json', undefined, …(2) ] to deeply equal [ Array(4) ]
 ❯ |archid| test/store.test.ts (16 tests | 5 failed) 65ms
   × Store.replace > emits one patch and drops entities the snapshot does not have
     → s.replace is not a function
   × Store.replace > persists before a listener can throw     → s.replace is not a function
   × prepared state > reads a prepared snapshot without making it active
     → Store.readSnapshot is not a function
   × prepared state > promotes a prepared file onto state.json and replaces the live state
     → s.promote is not a function
   × Store.load > collects a stale write temp that a finished write left behind
     → expected true to be false
 ❯ |archid| test/handover/journal.test.ts (0 test)

 FAIL  test/handover/durable.test.ts
Error: Failed to load url ../../src/handover/durable.js … Does the file exist?
 FAIL  test/handover/journal.test.ts
Error: Failed to load url ../../src/handover/journal.js … Does the file exist?

 Test Files  4 failed (4)
      Tests  6 failed | 15 passed (21)
```

GREEN — same command:

```
 ✓ |archid| test/config.test.ts (5 tests) 62ms
 ✓ |archid| test/handover/journal.test.ts (9 tests) 119ms
 ✓ |archid| test/handover/durable.test.ts (18 tests) 208ms
 ✓ |archid| test/store.test.ts (16 tests) 176ms

 Test Files  4 passed (4)
      Tests  48 passed (48)
```

Whole-suite verification:

```
$ pnpm vitest run --project archid
 Test Files  51 passed (51)
      Tests  605 passed (605)

$ pnpm vitest run --project cli --project protocol
 Test Files  22 passed (22)
      Tests  185 passed (185)

$ pnpm typecheck
(clean)
```

## Files changed

- `packages/archid/src/handover/durable.ts` (new)
- `packages/archid/src/handover/journal.ts` (new)
- `packages/archid/src/atomic.ts`
- `packages/archid/src/paths.ts`
- `packages/archid/src/store.ts`
- `packages/archid/test/handover/durable.test.ts` (new)
- `packages/archid/test/handover/journal.test.ts` (new)
- `packages/archid/test/store.test.ts`
- `packages/archid/test/config.test.ts`

## Self-review findings (fixed before commit)

1. `writeDurable` first accepted `Buffer | string | object` and wrote a string raw. `writeJsonAtomic`
   takes `unknown`, so a string argument would have silently stopped being JSON. Narrowed the
   parameter to `Buffer | object`, as the ruling names it.
2. The `preparedState` path assertions sat under `describe('openJournal')` in the journal test, where
   they do not belong. Moved into the paths test in `config.test.ts`.
3. `DurableJson`'s schema was typed `ZodType<T>`, which forced the schema's *input* type to equal its
   output and broke on the branded `MachineId`/`FleetId` ids. Typed as
   `ZodType<T, ZodTypeDef, unknown>`.

## Deliberate calls

- **A failed write leaves its temp behind.** `writeDurable` does not unlink on failure, so an
  injected failure looks exactly like a crash and the cleanup rule is the only collector. That is
  what makes the cleanup tests meaningful.
- **`cleanupDurableTemps` uses `>=` on the final file's mtime**, not `>`. Cleanup only runs at the
  startup of a durable location, where no write of ours is in flight, and an equal mtime with a
  sibling final file still means that temp is not the one being written now.
- **`replace` does not apply `sinkHome`.** The spec calls state import a validated replacement; the
  layout invariant belongs to the mutation path, and applying it in `replace` would mean the emitted
  patch is not exactly `current → snapshot`.
- **`promote` validates twice** — once before the rename so garbage never lands on `state.json`, once
  after so the in-memory state is built from the file that is actually there. The ruling's shape
  (`rename` then `replace(readBack)`) is preserved.
- **`preparedState` encodes the transaction id** with `encodeURIComponent`, so the name stays one
  path segment for any id the protocol's `TransactionId` (`z.string().min(1)`) permits.

## Bent rulings

One: the brief's file list names `test/store.test.ts` and `test/handover/journal.test.ts`, but the
`writeDurable` / `cleanupDurableTemps` / `DurableJson` fault-injection tests went into a third file,
`test/handover/durable.test.ts`, matching the repo's one-test-file-per-module pattern. The brief's
`Verify` command therefore does not run them; the global `pnpm vitest run --project archid` does, and
that was the command used to verify.

## Concerns for later tasks

- Nothing is wired into `main.ts` and no ownership check was added — Task 11 and Task 10, per the
  rulings. `openJournal(...).load()` returning `quarantined` is the signal Task 11 must treat as "not
  writable".
- `state.json` is now written at mode 0600 rather than 0644. Allowed by the ruling, but an existing
  install's file changes mode the first time the new daemon persists.
- `Store.update` now persists before swapping `current` (it swapped first). Same helper, better
  failure behaviour, and the full archid and cli suites pass — but it is a real ordering change for
  every mutation, not only for `replace`.

---

# Fix report — three Important review findings

Commit: `629338e A short write can no longer truncate a durable file, and an unreadable journal is never read as absent`

## Finding 1 — a short `write(2)` could rename a truncated temp

`realStages.write` called `fs.writeSync(fd, bytes)` once and ignored the return value, so a short
write (ENOSPC among others) returned without throwing and the truncated temp was fsynced and renamed
over `state.json`.

**Changed** — `packages/archid/src/handover/durable.ts`. The `write` stage is now the raw single
syscall, `write(fd, bytes, offset): number`, returning the count; the completion loop moved up into
`writeDurable`, where an injected stage cannot bypass it:

```ts
for (let at = 0; at < bytes.length;) {
  const n = stages.write(fd, bytes, at);
  if (n <= 0) throw new Error(`durable write stalled at ${at} of ${bytes.length} bytes for ${file}`);
  at += n;
}
```

`encode(data)` now runs before `open`, so a value that cannot be serialised no longer leaves a temp.

**Covering tests** — `packages/archid/test/handover/durable.test.ts`:

- *finishes a write the platform cuts short instead of renaming a truncated temp* — the injected
  stage writes 5 bytes on its first call and then behaves like the real stage; the final file is
  byte-identical to the whole new content.
- *leaves the whole old content when the write stalls part way* — the injected stage writes 5 bytes
  and then returns 0 forever; `writeDurable` throws `stalled at 5 of …`, the final file is the whole
  old content, and the temp is left for the cleanup rule.

## Finding 2 — an unreadable journal read as absent

`DurableJson.read` caught every `readFileSync` error as `reason: 'missing'`, so an EACCES/EIO
journal, or a directory at that path, made `JournalFile.load` answer `{ kind: 'none' }` — a daemon
would have started writable with a handover open.

**Changed** — `packages/archid/src/handover/durable.ts`: only `ENOENT` is `missing`; every other read
error is `malformed` and carries the error, so the quarantine path in `JournalFile.load` runs.

**Covering tests**:

- `durable.test.ts` *calls a file it cannot read malformed, never missing* — a directory at the path,
  and a `chmod 0000` file (skipped under uid 0).
- `journal.test.ts` *refuses a journal it cannot read rather than reporting none* (directory at the
  journal path) and *refuses an unreadable journal file rather than reporting none* (`chmod 0000`,
  skipped under uid 0, asserting the file is moved aside).

## Finding 3 — `stoppedTerminals[].term` disagreed with the protocol

The journal encoded a terminal index as a required `1 | 2`; everywhere else in the protocol it is
`Term = z.literal(2).optional()` — absent is the main terminal.

**Changed** — `packages/protocol/src/messages.ts` exports the existing module-local `Term` (const and
type; it was already the single definition, just not reachable), and
`packages/archid/src/handover/journal.ts` uses it for `stoppedTerminals[].term`.

**Covering test** — `journal.test.ts` *names a stopped terminal the way every other call does: absent
is the main one*: `{ characterId }` parses with `term` absent, and `term: 1` is rejected.

## Verification

Each of the six new tests was run against the pre-fix source (checked out from `4399faf`) and each
one failed:

```
$ pnpm vitest run --project archid test/handover/durable.test.ts test/handover/journal.test.ts
   × journal schemas > names a stopped terminal the way every other call does: absent is the main one
   × openJournal > refuses a journal it cannot read rather than reporting none
   × openJournal > refuses an unreadable journal file rather than reporting none
   × writeDurable > finishes a write the platform cuts short instead of renaming a truncated temp
   × writeDurable > leaves the whole old content when the write stalls part way
   × DurableJson > calls a file it cannot read malformed, never missing
      Tests  6 failed | 27 passed (33)
```

With the fixes in place:

```
$ pnpm vitest run --project archid test/store.test.ts test/handover/journal.test.ts test/handover/durable.test.ts test/config.test.ts
 ✓ |archid| test/config.test.ts (5 tests) 58ms
 ✓ |archid| test/handover/journal.test.ts (12 tests) 146ms
 ✓ |archid| test/store.test.ts (16 tests) 200ms
 ✓ |archid| test/handover/durable.test.ts (21 tests) 283ms
 Test Files  4 passed (4)
      Tests  54 passed (54)

$ pnpm typecheck
(clean)

$ pnpm vitest run --project archid
 Test Files  51 passed (51)
      Tests  611 passed (611)

$ pnpm vitest run --project cli --project protocol
 Test Files  22 passed (22)
      Tests  185 passed (185)
```

## Files changed by the fix

- `packages/archid/src/handover/durable.ts`
- `packages/archid/src/handover/journal.ts`
- `packages/protocol/src/messages.ts`
- `packages/archid/test/handover/durable.test.ts`
- `packages/archid/test/handover/journal.test.ts`

## Note

Finding 1's suggested test shape was "an injected `write` stage writes only part of the bytes then
behaves like the real stage, and assert the final file is whole old content" — those two halves pull
apart, because a stage that resumes normal behaviour completes the write and the file is correctly
the *new* content. Both properties are worth holding, so there are two tests: the resuming stage
proves the loop finishes a short write, and the stalling stage proves the old content survives when
it cannot. Making `write` the raw syscall is what puts the guarantee in `writeDurable` rather than in
a stage a test can replace.
