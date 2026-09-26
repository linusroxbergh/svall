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
