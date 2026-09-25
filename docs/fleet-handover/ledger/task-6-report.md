# Task 6 — Machine registry and named path roots

Commit: `fce23f3 The controller knows machines by stable identity and named roots`

## What was implemented

### `packages/cli/src/controller/registry.ts`

`MachineRegistry`, a class over `~/.config/archipelago/machines.json` shaped
`{ "machines": { "<machineId>": MachineRecord } }`.

- `MachineRegistry.load(dir = configDir(), { hostname? })` — takes the id from the existing
  `machineId(dir)`, parses the registry through
  `z.object({ machines: z.record(MachineId, MachineRecord) })`, auto-creates the local record when
  it is missing and writes the file.
- Local record: name from the short hostname lowercased and sanitised to `[a-z][a-z0-9-]{0,31}`
  (falling back to `mac`/`linux` by platform when nothing usable is left, when the result would be
  the reserved `local`, and suffixed `-2`, `-3`… if the name is taken), no `ssh`,
  `home = os.homedir()`, `archiBase = archiHome()`, `pathRoots: { home }`, `gateway: false`.
- Corrupt recovery: an unreadable or schema-invalid `machines.json` is renamed to
  `machines.json.broken-<iso timestamp>` and a fresh registry with only the local record is written;
  the moved file's path is reported on `registry.recovered` for the CLI to print. Nothing is
  discarded.
- CRUD: `save()`, `localMachine()`, `list()`, `get(idOrName)` → `{ id, record }`,
  `add(record, id = randomUUID())`, `rename(idOrName, name)`, `remove(idOrName)`. Records validate
  through `MachineRecord`, names are unique, `local` is refused as a stored name, the local machine
  cannot be removed, and `add` refuses an id already in the registry rather than clobbering it.
- `local` resolves to the invoking machine id on input and is never serialised.
- Persistence reuses `writeJsonAtomic` from `@archipelago/archid/atomic` (mode 0600) and the 0700
  directory `machineId()` creates.

### `packages/cli/src/controller/paths.ts`

- `PortablePath = { root, relative }`, `PathRootError` (house pattern: `code = 'invalid'`).
- `resolvePortablePath(absolute, roots)` — rejects NUL/newline and a relative input, normalises with
  `path.posix`, rejects a surviving `..`, picks the longest root matching on a path-component
  boundary, then checks realpath containment: the root itself must exist, and the real path of the
  input (its deepest existing ancestor realpathed, with the rest joined back on) must lie inside the
  root's real path. Relative never starts with `/`; a root of `/` is handled.
- `mapPortablePath(portable, roots)` — refuses an unknown root name, NUL/newline, an absolute
  relative and a `..` that climbs out, then joins under the destination root.
- `probeRoots(roots, paths = [], dep: ProbeFs = fs)` — per root: `exists`, `writable` (temp file
  created then removed), `caseInsensitive` (`…-a` written, `…-A` statted), `freeBytes`
  (`statfsSync`), and `collisions`: the relative paths of the given `PortablePath[]` for that root
  that only differ by case, reported only where the filesystem folds case. The filesystem calls go
  through a small injectable `ProbeFs` object defaulting to `node:fs`.

### Other files

- `packages/cli/src/target.ts` — `Target` gained an optional `machineId`, plus a `localMachineId()`
  helper; nothing else restructured.
- `packages/archid/package.json` — added `"./atomic": "./src/atomic.ts"` to the exports map.

No new dependencies, no shell interpolation.

## Tests

`packages/cli/test/controller/paths.test.ts` (9 tests) and
`packages/cli/test/controller/registry.test.ts` (9 tests), plus one case appended to
`packages/cli/test/target.test.ts`. Plain vitest, no mocks except the injectable `ProbeFs` fake;
real temp directories under `/tmp/archi-t-*` and `ARCHI_CONFIG_DIR`, so nothing touches the real
`~/.config`.

Required coverage:

- prefix confusion — `<tmp>/a` vs `<tmp>/ab`, including the negative (root `a` alone must not hold
  `<tmp>/ab/x`)
- longest root wins (`home` vs `home/work`), and a root of `/`
- spaces and unicode round-tripping both ways (`Ärende möte/fil (1).txt`)
- symlink escape (real symlink out of the root rejected; a symlink staying inside accepted)
- case collisions reported only on a case-folding destination
- missing destination root, both on resolve and on map
- corrupt registry recovery, from broken JSON and from a schema-invalid registry

### TDD evidence

RED — `pnpm vitest run --project cli test/controller test/target.test.ts`:

```
 FAIL |cli|  test/controller/paths.test.ts
Error: Failed to load url ../../src/controller/paths.js … Does the file exist?
 FAIL |cli|  test/controller/registry.test.ts
Error: Failed to load url ../../src/controller/registry.js … Does the file exist?
 FAIL |cli|  test/target.test.ts > target > carries the id of the machine the command runs on
TypeError: localMachineId is not a function
 Test Files  3 failed (3)
      Tests  1 failed | 4 passed (5)
```

Two later behaviours were driven the same way after their first RED:

```
 FAIL test/controller/paths.test.ts  (root "/" )
-   "relative": "etc/hosts",
+   "relative": "tc/hosts",

 FAIL test/controller/registry.test.ts  (add refusing a known id)
     91|     expect(() => registry.add({ ...trift, name: 'trift2' }, id)).toThrow(id)
 Test Files  1 failed (1)
      Tests  1 failed | 8 passed (9)
```

GREEN — `pnpm vitest run --project cli`:

```
 Test Files  14 passed (14)
      Tests  83 passed (83)
```

`pnpm vitest run --project archid`:

```
 Test Files  49 passed (49)
      Tests  563 passed (563)
```

`pnpm typecheck`: clean (`tsc --noEmit` on both projects, no output).

Test output is pristine — no stray logs, no skipped tests.

## Files changed

- `packages/cli/src/controller/registry.ts` (new)
- `packages/cli/src/controller/paths.ts` (new)
- `packages/cli/test/controller/registry.test.ts` (new)
- `packages/cli/test/controller/paths.test.ts` (new)
- `packages/cli/src/target.ts`
- `packages/cli/test/target.test.ts`
- `packages/archid/package.json`

## Self-review findings (fixed before the commit landed)

- A root of `/` sliced one character too many off the relative path. Test added first, then fixed.
- `add(record, id)` silently replaced an existing machine's record when the id was already known.
  Now refused; a re-registration goes through `remove` then `add`.
- The probe uppercased the whole path when checking case folding, which tested every ancestor rather
  than the root itself. It now uppercases only the probe file's name.

## Concerns

- `MachineRegistry.load()` creates `machine.json` as a side effect (through `machineId()`), so any
  code path that merely reads the registry mints the machine id. That follows the ruling to reuse
  `machineId()`, but callers should not call `load()` speculatively.
- `probeRoots` reports `collisions` only for case-insensitive roots. Case-folding names that collide
  with something *already on* the destination are not detected — that needs the destination
  inventory, which preflight (later task) has and this task does not.
- A broken symlink inside a root resolves to its lexical position and is accepted; the spec puts
  broken destination symlinks in preflight, so it is left there.
- `probeRoots` takes `PortablePath[]` and groups by root rather than a bare `string[]`, so one call
  covers every root with the paths that actually land in it.

## Rulings bent

None. Two additions beyond the literal ruling list, both one line: `MachineRegistry.list()` (a
registry with no enumeration is unusable for the CLI) and the optional `id` argument to `add` (a
remote machine already owns a `MachineId`; a later task will pass the discovered one instead of
minting a fresh one).

## Fix report — review finding 1 (duplicate names on load)

**Finding:** `Registry.parse` validated each name's shape but nothing rejected two machines sharing
a name, so a hand-edited or merged `machines.json` loaded clean and `get(name)` resolved to whichever
entry Map iteration reached first.

**What changed:** `packages/cli/src/controller/registry.ts` — the `Registry` schema's `machines`
record now carries a `.refine` that the distinct names number as many as the ids ("two machines share
a name"). A duplicate therefore fails `parse` and takes the existing corrupt-recovery path: the file
is moved to `machines.json.broken-<ts>`, `recovered` names it, and a fresh registry holding only the
local record is written.

**Covering test:** `packages/cli/test/controller/registry.test.ts` — "recovers the same way from a
registry where two machines share a name": writes two ids both named `trift`, loads, and asserts
`recovered` matches `machines.json.broken-`, the moved file still holds the original bytes, and
`list()` is the local record alone.

RED, `pnpm vitest run --project cli test/controller/registry.test.ts`:

```
 FAIL |cli|  test/controller/registry.test.ts > machine registry > recovers the same way from a registry where two machines share a name
TypeError: .toMatch() expects to receive a string, but got undefined
 ❯ test/controller/registry.test.ts:129:32
 Test Files  1 failed (1)
      Tests  1 failed | 9 passed (10)
```

GREEN, `pnpm vitest run --project cli`:

```
 Test Files  14 passed (14)
      Tests  84 passed (84)
```

`pnpm typecheck`: clean. (It first caught `'m' is possibly 'undefined'` from
`Object.values` over the branded-key record under `noUncheckedIndexedAccess`; the refine reads
`m?.name`.)
