# Task 5 report — Add fleet and machine identity plus configuration schemas

Commit: `f32264c Every fleet and machine setting has a portable home`

## What was implemented

### protocol

`packages/protocol/src/handover.ts` (new), re-exported from `index.ts`:

- `MachineId`, `FleetId` — `z.string().uuid().brand<…>()`.
- `TransactionRecord` — `{ id, fromMachineId, toMachineId, phase: 'preparing'|'ready-to-commit'|'committed', startedAt: number }`.
- `OwnerRecord` — `{ fleetId, generation (int, non-negative), ownerMachineId, transaction? }`.
- `PathRootMap` — record of root name to absolute path.
- `MachineRecord` — `{ name /^[a-z][a-z0-9-]{0,31}$/, ssh?, platform, arch, home, archiBase, pathRoots, gateway }`.
- `FleetConfig` — `{ id, gatewayMachineId?, home, defaultCwd, scribe, linear?, mobile: { logins, origins, pushContact }, handover: { enabled, exclude, excludeDefaults, transferFleetEnv } }`.
- `NodeConfig` — `{ port, host, shell?, mobile: { httpsPort? } }`.

`state.ts` untouched (ruling 1); `handover.ts` only imports `Home`, `DEFAULT_CWD` and `AgentKind` from it.

### archid

- `src/paths.ts`: `resolvePaths` gains `fleetConfig`, `nodeConfig`, `legacyConfig`, `owner`, `journal`, `replicas`. The old `config` key is gone (no caller left, per ruling 8's preference).
- `src/atomic.ts` (new): `writeJsonAtomic` — same-directory temp, `mode 0600`, rename.
- `src/config.ts`: `Config` is now the merge of `FleetConfig` and `NodeConfig` (same flat shape as before, plus `id` = the fleet id and `handover`), and is also the schema the legacy `config.json` is read with. `loadConfig(paths: Paths)` splits/creates then merges the two files. `initConfig(paths, seed?)` writes whichever file is missing and returns the paths written.
- `src/machine.ts` (new): `configDir()` (honours `ARCHI_CONFIG_DIR`) and `machineId(dir?)`, reading or creating `~/.config/archipelago/machine.json` (`{ "id": uuid }`, dir 0700, file 0600, atomic). Exported as `@archipelago/archid/machine`. No registry — that is Task 6.
- `src/setup.ts`: fresh setup calls `initConfig(paths, { port })`; `tmuxConfText`/`installHomeTemplate` take `loadConfig(paths)`.
- `src/uninstall.ts`: a fleet home is one holding `fleet.json` **or** `config.json`.
- `src/main.ts`: `loadConfig(paths)`.

### cli / mac

- `cli/src/client.ts`, `cli/src/commands/mobile.ts`: `loadConfig(paths)`; the "set mobile.logins in config.json" hint now says `fleet.json`.
- `ArchiHome.swift`: `configPath()` returns `fleet.json` (still created as `{}` when absent); `connection()` reads `host` from `node.json`.

### Migration semantics

`initConfig` is idempotent at every interruption point:

| home holds | result |
| --- | --- |
| `config.json` only | both files written from it, then `config.json` → `config.json.bak` |
| `config.json` + `fleet.json` | `node.json` written from it, fleet id untouched, then moved aside |
| `config.json` + both files | moved aside only; nothing rewritten |
| `config.json.bak` + both files | nothing happens |
| `config.json.bak` only | treated as split already; fresh defaults written |
| nothing | fresh fleet: both files with defaults and a new fleet id |

A `config.json` that is not JSON, or that the schema rejects, throws `invalid config <file>: …` **before** any write, so a home is never half split. Unknown keys are dropped from the two new files (zod strips them, as today) and survive byte-exact in the backup. A home directory that does not exist yields defaults and writes nothing.

## Tests and results

New: `packages/protocol/test/handover.test.ts` (11), `packages/archid/test/config-migration.test.ts` (14), `packages/archid/test/machine.test.ts` (4).

Updated for the split: `archid/test/config.test.ts` (new paths asserted, `loadConfig` takes `Paths`), `archid/test/setup.test.ts` (port lands in `node.json`; an existing `config.json` is split, not left alone), `archid/test/uninstall.test.ts` (the fleet is recognised by `fleet.json`).

Coverage against the brief: defaults, malformed legacy config (both unparseable and schema-rejected), partial migration at each interruption point, file permissions (0600 for both configs, 0700/0600 for `machine.json`), private and named fleets, unknown keys, id stability across two loads.

### TDD evidence

RED — protocol:

```
$ pnpm vitest run --project protocol
 FAIL |protocol|  test/handover.test.ts > split configuration > ignores keys it does not know
TypeError: Cannot read properties of undefined (reading 'parse')
 Test Files  1 failed | 7 passed (8)
      Tests  10 failed | 66 passed (76)
```

GREEN — protocol:

```
$ pnpm vitest run --project protocol
 Test Files  8 passed (8)
      Tests  76 passed (76)
```

RED — archid:

```
$ pnpm vitest run --project archid test/config-migration.test.ts test/machine.test.ts
TypeError: initConfig is not a function
 Test Files  2 failed (2)
      Tests  12 failed | 2 passed (14)
```

GREEN — archid:

```
$ pnpm vitest run --project archid test/config-migration.test.ts test/machine.test.ts
 ✓ |archid| test/machine.test.ts (4 tests) 7ms
 ✓ |archid| test/config-migration.test.ts (14 tests) 43ms
 Test Files  2 passed (2)
      Tests  18 passed (18)
```

Full suites before committing:

```
$ pnpm vitest run --project protocol   → Test Files 8 passed (8);   Tests 76 passed (76)
$ pnpm vitest run --project archid     → Test Files 49 passed (49); Tests 562 passed (562)
$ pnpm vitest run --project cli        → Test Files 12 passed (12); Tests 64 passed (64)
$ pnpm typecheck                       → clean (both tsconfigs)
```

Swift did not build in this worktree:

```
$ swift build --package-path apps/desktop/mac
error: local binary target 'GhosttyKit' at '…/apps/desktop/mac/GhosttyKit.xcframework' does not contain a binary artifact.
```

`apps/desktop/mac/GhosttyKit.xcframework` does not exist in this worktree (it is a build artifact of the main checkout), so the Mac app cannot be compiled here. The Swift change is two string literals plus a doc comment.

## Files changed

New: `packages/protocol/src/handover.ts`, `packages/protocol/test/handover.test.ts`, `packages/archid/src/atomic.ts`, `packages/archid/src/machine.ts`, `packages/archid/test/config-migration.test.ts`, `packages/archid/test/machine.test.ts`.

Modified: `packages/protocol/src/index.ts`, `packages/archid/src/config.ts`, `paths.ts`, `main.ts`, `setup.ts`, `uninstall.ts`, `packages/archid/package.json`, `packages/archid/test/config.test.ts`, `setup.test.ts`, `uninstall.test.ts`, `packages/cli/src/client.ts`, `packages/cli/src/commands/mobile.ts`, `apps/desktop/mac/Sources/Archipelago/ArchiHome.swift`.

## Self-review findings

- First cut kept a separate `LegacyConfig` schema and a hand-rolled composite TS type. That broke ~30 existing tests that build a config with `Config.parse({})`. Folding the composite back into an exported `Config` zod schema (built from the two halves) removed the churn and is the same object either way.
- First cut had `setupHome` call `initConfig` unconditionally, which would have written a default `fleet.json` over an unsplit `config.json`'s settings. `initConfig` now owns the split itself, so there is one code path that cannot get this wrong.
- A first draft passed setup's `port` seed into the split path; that would have let `archi setup --port` silently rewrite an existing fleet's port. The seed now applies only when `node.json` is created from nothing, matching what setup did before.
- `read()` was typed `z.ZodType<T>`, which unified on the schema's *input* type and failed `pnpm typecheck`; it is now `<T extends z.ZodTypeAny> … z.infer<T>`.
- Left a stray `undefined.bak` in the worktree root during the RED run (the test wrote `${p.legacyConfig}.bak` before `paths.ts` had the key). Deleted; not committed.

## Concerns

1. **No diagnostics surface exists.** Ruling 7 said to expose `node.json` through diagnostics only if such a surface already exists in the web or Swift code. It does not — there is no diagnostics view, panel or bridge message anywhere in `apps/desktop`. Nothing was invented. `node.json` is currently reachable only from the filesystem.
2. **`config.json.bak` is overwritten** if a home ends up with both `config.json` and an older `config.json.bak`. That can only happen if someone restores a `config.json` by hand after a split. Today there is no backup at all, so this is not a regression, but it is a silent one.
3. **An `id` key in an old `config.json` is now meaningful.** It is read as the fleet id and must be a UUID, where before it was an ignored unknown key. No released config has ever had one.
4. **`loadConfig` writes.** A read-only caller (the CLI's `Client.connect`) will create `fleet.json`/`node.json` in a home that has neither. That follows from ruling 5 ("a home with neither is a fresh fleet and gets both files"), and the daemon has normally created them first.
5. **Web e2e fixture still writes `config.json`** (`apps/desktop/web/e2e/daemon.ts`). It works unchanged — the daemon splits it on startup — and doubles as a live migration check, so it was left alone.

## Rulings bent

- **Ruling 6, "plus `fleet.id`".** The composite exposes the fleet id as `config.id` (the same key `fleet.json` uses), not as a nested `config.fleet.id`. The composite is the plain merge of `FleetConfig` and `NodeConfig`, so a nested wrapper would have meant a hand-written type over the two schemas for one field.
- **Ruling 6, "callers change only as much as the new signature needs".** One extra line: the `archi mobile on` hint told the user to "set mobile.logins in config.json", which would now be wrong; it says `fleet.json`.
- **Brief step "Modify `packages/protocol/src/state.ts`".** Not modified, per ruling 1.
- Everything else followed as written.

---

# Fix report — review findings 1 and 2

Commit subject: `A config.json beside the split files is refused, never moved aside`

## Finding 1 — `scripts/desktop-install.sh` install guard

The "already installed" test only looked for `config.json`, which no longer exists on a split or a
fresh machine, so every `pnpm desktop:install` set `SETUP=1` and `setupUser` overwrote the user's
edited `~/.archipelago/home/.claude/settings.json`. The guard now matches `uninstall.ts`: a fleet
home is one holding `fleet.json`, or the `config.json` it is split out of.

```sh
if { [ ! -f "$HOME_DIR/fleet.json" ] && [ ! -f "$HOME_DIR/config.json" ]; } \
  || [ ! -f "$HOME/Library/LaunchAgents/com.archipelago.archid.plist" ] || [ ! -f "$HOME/.local/bin/archi" ]; then
```

Verified two ways, since a shell test was not required:

```
$ sh -n scripts/desktop-install.sh
syntax ok
$ sh <scratchpad>/guard.sh        # the guard's exact condition, against four throwaway homes
fleet.json: SETUP=
config.json: SETUP=
config.json.bak: SETUP=1
nothing: SETUP=1
```

The plist and shim tests are untouched, so a home kept by `archi uninstall` still sets `SETUP=1`.

## Finding 2 — a `config.json` written after the split

`initConfig` renamed `config.json` unconditionally, so one written after the split was moved aside
unread and the rename destroyed the real original's backup. Per the controller's ruling:

- `config.json` beside an existing `fleet.json` now throws, naming `fleet.json` and `node.json` as
  the files to edit and telling the user to delete `config.json`. It is never read, renamed or
  merged.
- `config.json` beside an existing `config.json.bak` throws rather than clobber the backup.
- The two files are written **node.json first, fleet.json second**, so a run that stops between them
  comes back to a `config.json` it may still read and finishes the split. `fleet.json` existing is
  what makes a later `config.json` an error, so the two rules cannot contradict each other.

## Covering tests

`packages/archid/test/config-migration.test.ts` — two new cases, plus the interrupted-split case
rewritten for the new write order and `initConfig`'s return order:

- *refuses a config.json written after the split rather than move it aside unread*
- *refuses to split over a backup that is already there*
- *writes fleet.json and keeps the node.json already there*

`packages/archid/test/config.test.ts` unchanged and still passing.

RED (the fix reverted to the committed `config.ts`, the tests kept):

```
$ pnpm vitest run --project archid test/config-migration.test.ts -t 'refuses'
   × finishing an interrupted split > refuses a config.json written after the split rather than move it aside unread 4ms
     → expected [Function] to throw an error
   × finishing an interrupted split > refuses to split over a backup that is already there 2ms
     → expected [Function] to throw an error
      Tests  2 failed | 2 passed | 11 skipped (15)
```

GREEN:

```
$ pnpm vitest run --project archid test/config-migration.test.ts test/config.test.ts
 ✓ |archid| test/config.test.ts (5 tests) 16ms
 ✓ |archid| test/config-migration.test.ts (15 tests) 56ms
 Test Files  2 passed (2)
      Tests  20 passed (20)
```

Full suites after the fix:

```
$ pnpm typecheck                     → clean (both tsconfigs)
$ pnpm vitest run --project protocol → Test Files 8 passed (8);   Tests 76 passed (76)
$ pnpm vitest run --project archid   → Test Files 49 passed (49); Tests 563 passed (563)
$ pnpm vitest run --project cli      → Test Files 12 passed (12); Tests 64 passed (64)
```

## README

`README.md` now names the file each setting lives in: `fleet.json` for `linear`, `defaultCwd`,
`home`, `scribe`, `mobile.logins` and `mobile.pushContact`; `node.json` for `port`, `host` and
`mobile.httpsPort`. The uninstall paragraph says a `~/.archipelago-*` folder without a `fleet.json`
is not a fleet. Final state only — no mention of a split or of `config.json`.

## Files changed in this fix

`scripts/desktop-install.sh`, `packages/archid/src/config.ts`,
`packages/archid/test/config-migration.test.ts`, `README.md`.

## Concerns after the fix

- Concern 2 of the original report (a clobbered `config.json.bak`) is resolved: it now refuses.
- One narrow window remains: a crash between writing `fleet.json` and renaming `config.json` leaves
  a home that refuses to start. Nothing is lost — the settings are already in the two new files —
  and the error names the exact remedy (delete `config.json`). Moving the rename earlier would risk
  losing settings instead, which is worse.

---

# Fix report — round 2: the split reads only the backup

Commit subject: `The split is driven by the backup, so every interrupted state is unambiguous`

## What changed

The residual concern from round 1 (a crash between writing `fleet.json` and renaming `config.json`
left a home that refused to start) is gone, because the rename now comes *first*. `initConfig`
migrates in this order:

1. `config.json` present and `fleet.json` absent — refuse if `config.json.bak` is already there;
   otherwise parse `config.json` (malformed throws `invalid config <file>` and nothing is touched),
   then rename it to `config.json.bak`.
2. `config.json.bak` present and `fleet.json` absent — split the backup and write `node.json`, then
   `fleet.json`. Both writes are atomic, so a partial `fleet.json` cannot exist.
3. `config.json` beside an existing `fleet.json` — an error, unchanged from round 1.
4. Nothing at all — a fresh fleet: both files with defaults.

`fleet.json` is written last, so its presence means the split behind it is whole and nothing is read
again. The only file the split ever reads is `config.json.bak`, which nothing edits, so a
`config.json` written after the split can never be mistaken for the original.

Every interruption state is now unambiguous:

| home holds | result |
| --- | --- |
| `config.json` | parsed, renamed to `.bak`, then split |
| `.bak` | split; both files written |
| `.bak` + `node.json` | `node.json` rewritten from the backup, `fleet.json` written |
| `.bak` + both files | nothing; the fleet id is stable |
| `fleet.json` + `config.json` | error |
| `config.json` + `.bak` | error |
| nothing | fresh defaults |

## Covering tests

`packages/archid/test/config-migration.test.ts` — the round-1 "crash after fleet.json" expectations
are replaced by one case per interruption state:

- *splits a backup that a crash left without either new file*
- *rewrites a node.json a crash left behind out of the backup*
- *reads nothing more once both files are there* — overwrites the backup with different settings
  after a completed split and asserts the fleet id, the port and `fleet.json`'s bytes are unchanged
- *refuses a config.json written after the split rather than move it aside unread* (kept)
- *refuses to split over a backup that is already there* (kept)

The "a home holding only the backup is split already" case from round 1 is gone: a backup without a
`fleet.json` is now the split's input, not a finished migration.

RED (round-2 tests against the round-1 `config.ts`):

```
$ pnpm vitest run --project archid test/config-migration.test.ts -t 'backup'
   × finishing an interrupted split > splits a backup that a crash left without either new file 6ms
     → expected 47800 to be 47900 // Object.is equality
   × finishing an interrupted split > rewrites a node.json a crash left behind out of the backup 2ms
     → expected 100 to be 47900 // Object.is equality
      Tests  2 failed | 2 passed | 11 skipped (15)
```

GREEN:

```
$ pnpm vitest run --project archid test/config-migration.test.ts test/config.test.ts
 ✓ |archid| test/config.test.ts (5 tests) 10ms
 ✓ |archid| test/config-migration.test.ts (15 tests) 38ms
 Test Files  2 passed (2)
      Tests  20 passed (20)

$ pnpm vitest run --project archid    → Test Files 49 passed (49); Tests 563 passed (563)
$ pnpm vitest run --project protocol  → Test Files 8 passed (8);   Tests 76 passed (76)
$ pnpm vitest run --project cli       → Test Files 12 passed (12); Tests 64 passed (64)
$ pnpm typecheck                      → clean (both tsconfigs)
```

`fleet.test.ts` and `e2e.test.ts` each reported one failure on the first full run, while the Swift
build was competing for the machine; both pass on their own and in a repeat full run.

## Swift

`GhosttyKit.xcframework` is now symlinked into the worktree, so the Mac app builds:

```
$ swift build --package-path apps/desktop/mac
Building for debugging...
[2 / 6] Archipelago-product
[4 / 8] Archipelago-product
Build complete! (1,15 secs)
```

(run after touching `Sources/Archipelago/ArchiHome.swift`, so the changed file was recompiled rather
than served from the build cache).

## Files changed in this fix

`packages/archid/src/config.ts`, `packages/archid/test/config-migration.test.ts`.

## Concerns

None outstanding. Round 1's residual concern is resolved; the README, the install guard and the
refusal messages from round 1 are unchanged and still correct.
