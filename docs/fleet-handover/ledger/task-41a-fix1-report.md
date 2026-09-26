# Task 41a fix round 1 — report

Branch `experimental-remote-sessions`, FIX_BASE a6b5f65f, commits a6b5f65f..af7b98d8 (six, not pushed). Uncommitted:
this report.

| Commit | Item |
| --- | --- |
| d374ef43 | I1 |
| c0c3088b | M1 |
| 21749b7c | M2 |
| d28a434a | M3 |
| 4110a304 | M4 |
| af7b98d8 | M5 |

## Per item

**I1** (`controller/handover.ts` `destinationChecks`)
- `folders` now also asks about each carried `dir` root's own path.
- A landing folder must be writable only when a root landing in it will be created (inspect `absent`, or archived), when
  the root is a file (rsync writes its temp file beside it), or when a session lands there.
- A `dir` root that is already there (`replica`, `resume`, or blocked) must be writable itself.
- The case-collision check reads a root's own probe when the root exists, otherwise its landing folder's. Without
  this, the fix would open a gap: a probe of an unwritable `/Volumes` reports `caseInsensitive: false`, so the return
  trip to an APFS `/Volumes/work` would skip the collision check.
- Test (`handover.test.ts`, pull world, root `/Volumes/work`, `/Volumes` unwritable):
  - holding its replica, it passes;
  - the root unwritable itself blocks `/Volumes/work on mac cannot be written`;
  - the root case-insensitive blocks `path_collision`;
  - a first copy blocks `/Volumes on mac cannot be written`.
- The fake destination gained `replicas`. The `parent_missing` test's exact folder list now includes the roots.

**M1**
- Destination (`destination.ts`): `DestinationDeps.homedir` (default `os.homedir`). `runClaim` refuses before any
  reserve when `manifest.home` differs, as `home_mismatch`: `this account's home is X and the fleet's Y; …`. A throwing
  homedir also refuses (fail closed). The test daemon's home defaults to its scene's manifest home.
- `host doctor` (`host.ts`): a new `home` check probes `$HOME`.
  - It is `ok` when `$HOME` equals the registry record.
  - Otherwise it fails with `X is U's home on trift, and the registry records Y; archi host remove trift, then archi
    host add again at an account whose home is <Mac home>`.
  - The linger fallback reuses that probe's user.
- The preflight check is unchanged.

**M2** (`validate.ts` `manifestProblems`, so claim and prepare): an unfolded root outside `m.home` whose parent does not
exist blocks `parent_missing` (`this machine has no P, which R lands in; … so make P first`). The claim therefore creates
nothing. `ReplicaStore.create` keeps `mkdir -p`, which roots under the home still use. Test: the claim is refused and
the tree is unchanged; once the folder exists, the root is claimed `absent`.

**M3** (`inventory.ts`): the preflight `home_mismatch` message ends `; then archi host remove <name>, and archi host add
at that account`. The inventory and source tests were updated.

**M4**: replaced `destinationPath === sourcePath` (fixture-only) with the assertion that the session entries the
controller hands the transfer carry the manifest's session files.

**M5**: the `server.test.ts` comment now reads "as an earlier build wrote it, with named path roots". `host.test.ts` uses
`ELSEWHERE = ${os.homedir()}-elsewhere` as the other home (add-host mismatch test and the new doctor test).

## Failing first (logs in the session scratchpad)

- I1: `expected [ { code: 'path_unsupported', … '/Volumes on mac cannot be written' } ] to deeply equal []`. With only
  the case-folding line reverted, the same test also fails.
- M1: destination claim `Error: the call succeeded`; doctor `expected undefined to deeply equal { name: 'home', status:
  'ok', … }`.
- M2: `Error: the call succeeded` (the claim made the missing folder).
- M3: inventory and source `home_mismatch` messages mismatched.
- M4 (not test-first, a test fix): with the controller changed in a scratch edit to drop a staged session file, the new
  assertion fails. The edit was reverted.

## Verification

| Command | Result |
| --- | --- |
| `pnpm typecheck` | clean |
| `pnpm vitest run --project protocol --project archid --project cli` | 125 files passed, 1 skipped; 2237 passed, 6 skipped |

The +4 against the 41a count (2233) are the I1, M1 (two) and M2 tests. The web UI did not change: a doctor `home` check
falls in its existing Prerequisites row, and a failing one keeps `readyForHandover` false.

## Concerns

- I1: preflight now writes the probe file (`.archi-probe-<pid>-a`, removed at once) inside each existing carried root on
  the destination, as it does in landing folders. If the removal ever failed, the next replica proof would read that
  file as divergence.
- I1: a file root under the home still counts against the home, not the folder it actually sits in. This predates
  this round.
- M1: the destination compares `os.homedir()` with `manifest.home` as exact strings, so a `$HOME` with a trailing slash
  would block. When `$HOME` cannot be read, doctor reports `home` failed and skips the linger fallback, which would
  fail on the same probe.
- M2: a folder removed between the check and `ReplicaStore.create` would still be recreated by `mkdir -p`.
- M3: `<name>` is a placeholder, as `<user>` is. The source daemon does not know the destination's registry name.
