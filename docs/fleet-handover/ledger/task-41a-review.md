# Task 41a — review

Commits ce7b6f1c..f02d50bd (one commit, f02d50bd). Brief: `task-41a-review-brief.md`.

**Verdict: Needs fixes** — 0 Critical, 1 Important, 5 Minor.

## Important

### I1. Preflight blocks a root that already holds its replica when the folder above it cannot be written

`packages/cli/src/controller/handover.ts:854-856` demands a writable landing folder for every carried root, whatever
the root's inspect check says. The landing folder of a root outside the home is its parent
(`packages/archid/src/handover/manifest.ts:249`), so a root directly under a root-owned folder (`/Volumes/work`,
`/opt/tool`, `/srv/x`) is blocked with `/Volumes on mac cannot be written` even when it exists there with a matching
replica record. rsync with `--delete` then writes only inside the root, so it does not need the parent to be writable.
That root can go out but can never come back: the source seals it at Complete, and the return preflight blocks on
`/Volumes`, which is `root:wheel 755` on this Mac. The spec asks only that the parent exists ("Same paths"). The
path-root probe this replaced checked the declared root itself, so a mount-point root used to pass.

Evidence: in a scratch copy, a controller preflight with root `/Volumes/work` answered `{ ok: true, kind: 'replica' }`
and `folders['/Volumes'] = { exists: true, writable: false }` returns
`[{ code: 'path_unsupported', message: '/Volumes on trift cannot be written' }]`, where it should return no blockers.

Fix: require a writable landing folder only for roots that will be created, meaning an `absent` check or a root in
`archived`. Add a test for a `replica` root under a folder that cannot be written.

## Minor

### M1. The home check compares registry records, and neither daemon checks its own home (implementer concern 2)

`source.ts:487-495` takes both homes from the controller's registry (`reach.ts:192-194`), and the destination never
reads `manifest.home`. If an account's home changes after `host add`, the handover still passes. Roots then land at the
recorded paths, outside that account's home, and `~` in the state resolves to a different place.
`parent_missing` catches this only when the old home folder is gone. **Judgement:** yes, compare against live homes.
Two ways, from least to most protocol change:
- the destination refuses a claim whose `manifest.home` is not its own home (injectable homedir);
- `SystemInfo` reports `home`. The source compares `destination.info.home` with its own homedir, which also expands
  `~`, and `HandoverMachines.source.home` and `destination.home` go.

`host doctor` already runs `homeProbe` (`host.ts:424`) and could flag a mismatch there as well.

### M2. `parent_missing` is checked at preflight only, and a claim still creates the missing folders (implementer concern 3)

`destinationChecks` runs only from preflight (`handover.ts:223`). Freeze builds a new manifest that is never inspected,
and `ReplicaStore.create` runs `mkdir -p` on the parent (`replicas.ts:368`). A root outside the home that first appears
in the freeze manifest, or a parent removed after preflight, gets its parent created at claim. That breaks the spec's
"its parent must exist". **Judgement:** worth closing at the destination, cheaply. In `runClaim` (`destination.ts:260`),
or in `manifestProblems`, block `parent_missing` for any root outside `m.home` whose parent does not exist. Keep
`mkdir -p` for roots under the home.

### M3. Preflight's `home_mismatch` text leaves out the step after the new account

`inventory.ts:169` names the account commands but not what comes next. `host add`'s action ends with "then add the
machine again at that account". The machine this blocker usually fires for was registered by an earlier build with
another home. Its registry entry names the old account, so the user also needs `archi host remove <name>` and then
`archi host add`. Add that tail to the message.

### M4. Part of the round-trip test only checks its own fixture

`packages/cli/test/controller/handover.test.ts:711` asserts `destinationPath === sourcePath` for the sessions of
`manifestFor`. That fixture sets both paths itself (`:65-79`), so no controller change can make it fail. The rest of
the test does carry weight: rewriting a transfer entry's path, or sending another home, fails it (checked by reverting
in a scratch copy). "Both ways" means two one-way worlds. The there-and-back trip is covered by the git-repair and
destination `comingBack` tests. Drop line 711, or replace it with an assertion on what the controller stages for
sessions.

### M5. Nits

- `packages/archid/test/gateway/server.test.ts:203`: "the named path roots this one no longer reads" narrates history.
  Suggested wording: "as an earlier build wrote it, with named path roots".
- `packages/cli/test/host.test.ts:23,204`: `HOME = os.homedir()`, with `/home/linus` as the "other" home. On a runner
  whose home is `/home/linus`, the mismatch test fails. Use a home that cannot be the runner's, such as
  `${HOME}-elsewhere`.

## The implementer's concerns

1. **No shim for a previous build's `pathRoots` params:** acceptable. PROTOCOL 17 is this branch's own unreleased bump
   (main is at 16), and a handover requires an exact release match. A stale dev daemon refuses with an explicit
   invalid-params error rather than going wrong silently. The brief allows only the registry/wire-record read, and
   that is done.
2. **Home check trusts the registry:** see M1.
3. **`parent_missing` at preflight only:** see M2.
4. **The source symlink check skips `defaultCwd` and a cwd equal to the home:** the second half is inaccurate.
   `real()` runs before `offer` skips the home (`inventory.ts:203` against `:192`), so a cwd at a symlinked home is
   blocked. `defaultCwd` is no root and the spec does not ask for a check on it, so it is fine unchecked.

## 41b areas touched mechanically (item 6)

All three are correct as a bridge:
- **`git-repair.ts`:** takes an identity map, and `graphsHere` keeps every graph. The destination real-graph test
  shows the sealed gitfile equals the source's, with repair reporting nothing (`repairReport: ''`).
- **Session path map:** now maps only one agent home to the other, and `Walk.stays` reads it directly.
- **Git fixture:** `park`/`unpark` put two machines with one home on one disk. The fixture and the tests that
  deleted the O5/O7 slug and declared-root cases leave nothing 41b still needs.

## Verified clean

- **Spec, item by item.**
  - A different home blocks at Add Machine (`host.ts:314-324`), before install and before any registry write, and at
    preflight and freeze (`home_mismatch`), with `mkdir -p`, `useradd -m -d` and `usermod -d … -m`. A home that needs
    quoting is quoted.
  - A root outside the home blocks with `parent_missing`, naming the folder.
  - `PathRootMap`, `pathRoots`, portable `{root, relative}`, the classifier, `rewrite` and the `importState` rewrite
    are all gone. The state travels as recorded (inventory test asserts the snapshot is unchanged; destination
    prepare keeps every path).
  - The source requires every root candidate (cwd, second cwd, `home.cwd`, context refs, `file:` tabs, repo fields,
    graph paths) to be its own real path, and the message names both paths.
  - The destination refuses a root a link leads elsewhere (`linkProblem`) at inspect, claim and prepare. This also
    catches a destination whose home is a symlink.
  - Replica keys, transcript placement (`destinationHome + transcript`, with `installSession` refusing any other
    place), `spaceNeed`, names and manifest `home` all use the recorded path.
- **Safety.**
  - rsync still writes only at the claim's `check.path`, and after `linkProblem` that path equals `root.path`.
  - Replica records and seals on both sides use `root.path`. `--delete` still needs absent/reserved or a matching
    replica, and `ReplicaStore.clash` still keeps the fleet home out.
  - No new subprocess: `homeCommands` is display text only. No new persistent write. Activation and Commit are
    untouched.
- **Dead code.**
  - Nothing in `packages/` or `apps/` references path roots except old-record fixtures, and `tsc --noUnusedLocals
    --noUnusedParameters` is clean.
  - `controller/paths.ts` and its test are deleted, and the probe tests moved to archid.
  - The web UI (`HostSetup.tsx`, `HandoverSheet.tsx`, `handover.ts`, `host.ts`) and the Swift app hold no path-root
    text or fields. Only `plan.md` (history) mentions them under docs.
  - `PROTOCOL_VERSION` stays 17.
- **Tests fail without their change** (each source piece reverted in a scratch copy):
  - `MachineRecord` made strict: the protocol old-record test and the cli old-`machines.json` test fail.
  - The host-add home check removed: its test fails.
  - `home_mismatch` disabled: the inventory and source preflight/freeze tests fail.
  - The source real-path check disabled: 5 inventory/source tests fail.
  - `linkProblem` disabled: 3 destination claim/inspect/prepare tests fail.
  - `parent_missing` disabled: 2 controller tests fail.
  - The controller rewriting a transfer entry's path: the round-trip test fails.

## Verification

- `pnpm vitest run --project protocol --project archid --project cli`: 125 files passed, 1 skipped; 2233 passed,
  6 skipped.
- `pnpm vitest run --project @archipelago/desktop-web`: 708 passed.
- `pnpm typecheck`: clean.

## Fix round 1

Commits a6b5f65f..af7b98d8, report `task-41a-fix1-report.md`.

**Verdict: Needs fixes** — 0 Critical, 1 Important, 3 Minor.

### Each item

Each check reverts one source change in a scratch copy and runs the item's tests.

| Item | Addressed | Fails without its change | Scope |
| --- | --- | --- | --- |
| I1 | yes, but see F1 | The item's test fails for each of three reverts: the old `folders` writability loop, the root's own writability, and the root's own case reading. | The case reading goes past I1, and it has to (see question 3). |
| M1 | yes, see F2 | Without `homeProblem`, the destination claim test fails. Without the doctor `home` check, the doctor test fails. | The doctor linger check now reuses the home probe and is skipped when that probe fails. That is fine: the `home` failure already reports the problem. |
| M2 | yes | Without the check in `manifestProblems`, the claim test fails, and the tree is left unchanged. | ok |
| M3 | yes | Reverting the message fails the inventory and source tests. | ok; `<name>` is a placeholder, like `<user>` |
| M4 | yes | Not test-first, since it is a test fix. The new assertion checks the files the controller stages. | ok |
| M5 | yes | — | ok |

### Important

**F1. Preflight now writes a file inside every existing carried folder on the destination.**
`handover.ts:820` adds each carried `dir` root to `folders`. `probeFolders` (`destination.ts:182`,
`probe.ts:36`) then creates and removes `.archi-probe-<pid>-a` inside each root that exists. The controller cannot
choose which roots get probed, because it learns each root's check in the same inspect call. So the probe also writes
into roots the handover has no claim on:
- a folder with no replica record (`destination_occupied`), which is any folder that already happens to sit at that
  path;
- a diverged root that holds work the user has not recovered.

This goes against two spec rules: "Preflight is read-only", and a handover "never mirrors over an arbitrary
pre-existing folder". On a return trip the destination is the Mac, so the probe writes into the user's working copies.
Editors, file watchers and sync clients see that.

Evidence, from the scratch copy, on a sealed replica root:
- `probeFolders([root])` produced an fs.watch event `rename:.archi-probe-<pid>-a` and changed the folder's mtime.
- A probe left behind (a daemon killed between the write and the removal) turns the next inspect into
  `destination_diverged: … 1 added (.archi-probe-<pid>-a)`.

On the coordinator's question: no, a write inside a root is not acceptable, and none is needed. Two read-only readings
replace it; both behaved as expected on this Mac:
- **Writable:** `fs.accessSync(p, fs.constants.W_OK)` covers permissions and read-only mounts (EROFS).
  `/Volumes` gives `EACCES`.
- **Case folding:** `lstat` the root's last component with its case swapped, and compare `dev` and `ino` with the
  root's own `lstat`. `/Volumes/Ollama` against `/Volumes/OLLAMA` reports that the folder folds case.
  - For a mount-point root, where the swapped lookup happens in the parent's filesystem, swap an entry inside the root
    instead.

Use these readings for folders that are roots. They also fix a problem older than this round: a folder that cannot be
written always reads `caseInsensitive: false` today. The same readings could replace the write probe in landing
folders too, but that code predates this round and is optional.

### Minor

**F2. Doctor reports `home: ok` for a machine whose home is not the Mac's.**
`host.ts:425` compares the far `$HOME` only with the registry record. A machine registered by an earlier build (for
example registry and far home both `/home/linus`, Mac `/Users/linus`) passes as `home ok`. Doctor can then say ready
while every preflight blocks with `home_mismatch`. Also fail `home` when `far.home` is not `registry.localMachine().home`,
with the same remove-then-add action.

**F3. The case with a file root is untested.**
`handover.ts:859` requires the landing folder to be writable for a file root even when a replica is there, because
rsync writes a file's temporary copy beside it. The rule is right, but deleting `c.entry === 'file' ||` leaves all 67
controller tests passing. Add a file root that holds its replica under a folder that cannot be written.

**F4. The divergence blocker still offers a remedy that only path roots made possible.**
`divergence.ts:109` ends with "Recover the changes by hand, map the root elsewhere, or archive it to continue". With
one path on both machines there is no mapping, so this is path-root user text the 41a brief removes (I missed it in the
first round). Suggested wording: "Recover the changes by hand, or archive it to continue".

### Questions 2 and 3

**(2) The destination compares homes as exact strings: acceptable.**
- It fails closed, and the message names both paths.
- It matches host add, preflight and doctor, which also compare exactly.
- In practice every value comes from the same passwd `pw_dir`: the Mac's `os.homedir()`, the far `$HOME` from sshd,
  and the unit's `HOME=` written at setup. A trailing slash on one side only would already stop `host add`.
- If normalization is wanted, do it once where a home enters (reject a trailing slash in `MachinePath`, or trim in
  `homeProbe` and `localRecord`), not at each comparison.

Note that under systemd, `os.homedir()` is the unit's `HOME=` baked in at setup. The claim check therefore compares
two values recorded at setup. It catches a registry that disagrees with the daemon. It does not catch a later
`usermod -d`: doctor's live `$HOME` probe catches that, and the install needs setting up again anyway.

**(3) The case-collision check reads the root's own probe: correct, and needed.**
- Without it, the I1 fix opens a gap. `/Volumes` cannot be written, so it reads `caseInsensitive: false`, and the
  return trip to an APFS `/Volumes/work` would skip the collision check. A revert confirms the I1 test fails.
- A root that is absent still reads its landing folder, which is right.
- It depends on the in-root write, so keep it with F1's read-only case reading.

### Verified clean

- **M1 on the destination:** runs before any reserve, fails closed when the home cannot be read, and the tree is left
  unchanged.
- **M2:** covers claim and prepare through `manifestProblems`. Roots under the home still get `mkdir -p`. A folder
  removed between the check and the create is the window the implementer names, and it is acceptable.
- **M3–M5:** as asked.

### Verification

- `pnpm vitest run --project protocol --project archid --project cli`: 125 files passed, 1 skipped; 2237 passed,
  6 skipped.
- `pnpm typecheck`: clean.

## Fix round 2

Commits 6da5d341..ad9fc063, report `task-41a-fix2-report.md`.

**Verdict: Approved** — 0 Critical, 0 Important, 2 Minor. Neither Minor blocks.

### Each item

Each check reverts one source change in a scratch copy and runs the item's tests.

| Item | Addressed | Fails without its change | Scope |
| --- | --- | --- | --- |
| F1 | yes | 4 tests fail with the round-1 write probe restored: the probe's snapshot, its unwritable-folder and mount-point tests, and the destination inspect snapshot. The mount-point test also fails when the device comparison is dropped or when the look-up inside the folder is removed. | `probe.ts` and its tests only. The controller is unchanged and still reads case from the root's own probe. |
| F2 | yes | The doctor test fails when the not-this-Mac's-home clause is removed. | `host.ts` doctor only |
| F3 | yes, test only | Deleting `c.entry === 'file' \|\|` fails the new test, and only that test. | ok |
| F4 | yes | Restoring the old wording fails the replica divergence assertion. | ok. Nothing else in `packages/` or `apps/` still says "map the root elsewhere". |

### Preflight writes nothing on the destination

- `probeFolders` now calls only `existsSync`, `accessSync`, `lstatSync`, `statSync`, `readdirSync` and `statfsSync`.
- The rest of `inspect` only reads:
  - `ReplicaStore.inspect`, which the inspect test asserts writes no record;
  - `keptWorktrees`, which runs `git rev-parse` and `reaches`;
  - the Codex trust read and the link `existsSync`.
- The new destination test compares the byte-and-`mtimeNs` snapshot of every carried root, including a diverged one.
- `probeFsRules` still writes on darwin, but it runs only at prepare (`git-repair.ts:171`), inside a root the transaction
  has claimed. The report explains why `precomposeUnicode` has no read-only form. Accepted; it stays the known
  deferred minor, and 41b reworks that file.

### Minor

**G1. A folder whose name has no letters reads as not folding case, even when it is not a volume of its own.**
- **Where:** `probe.ts:33` looks up the folder's own name only when that name has letters. Otherwise it reads the first
  entry inside that has letters, and with none it answers `false`.
- **Evidence:** on this Mac, `probeFolders` reads `…/aoc/2024`, with entries `01` and `02`, as
  `caseInsensitive: false`, while its parent `…/aoc` reads `true`. So the gap covers more than the report's "volume
  of its own": any root with a numeric name and numeric top-level entries, which is a common layout.
- **Coordinator's question:** a bounded search of entries is not worth it. Walking up is, because it costs a few
  `lstat` calls and no `readdir`: go up to the nearest ancestor on the same device whose name has letters, and look
  that name up with its case swapped. The only case left unread is then a volume of its own whose top-level entries
  all lack letters. That is rare, so leave it.
- **Why a miss is safe (read from the code, not run):** it costs no data. `compare` (`transfer.ts:339-345`) itemizes
  the clashing name on every pass, so after three passes the root blocks before Commit. The blocker it shows is the
  misleading `external_writer`.
- **When clashes can happen at all:** only on a trip from a case-sensitive machine to a case-folding one, which means
  back to the Mac.

**G2. The branch that reads a folder as unwritable has no test when the suite runs as root.**
- **Where:** `probe.test.ts:39` skips under uid 0, and so it should: root can write anywhere.
- **The gap:** the fake-filesystem tests have no `accessSync` that throws. Removing the `accessSync` check fails only
  the skipped test, so a root CI run would not notice.
- **Suggested fix:** give the mount-point fake, or a second fake, an `accessSync` that throws, and expect
  `writable: false`.

### The implementer's concerns

- **Case reading misses a letterless folder whose entries lack letters:** see G1. The gap is wider than the report
  says, but the fix is the cheap walk-up, not a deeper search.
- **The real unwritable-folder test skips under root:** the skip is right, and G2 covers the gap it leaves.

### Verification

- `pnpm vitest run --project protocol --project archid --project cli`: 125 files passed, 1 skipped; 2241 passed,
  6 skipped.
- `pnpm typecheck`: clean.
