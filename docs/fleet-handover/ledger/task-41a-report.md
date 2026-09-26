# Task 41a — same home path, no path roots, real-path roots

Branch `experimental-remote-sessions`, one commit on ce7b6f1c: f02d50bd "A fleet moves only to an account with the same
home path, and every root it carries travels at its own real path with no path roots to map it through" (49 files,
+986 −1365). Not pushed. Uncommitted: this report.

## What changed, per step

**1. Same home at Add Machine and at preflight**
- `archi host add` (`controller/host.ts`, `home` step): the remote `$HOME` must equal the registry's local record's
  home. Otherwise the step fails before anything is installed, with detail `<remote> is <user>'s home there and <mac>
  is this Mac's; a fleet moves only between accounts with the same home path` and action `ssh <dest>, then make an
  account whose home is <mac>: sudo mkdir -p <parent>, then sudo useradd -m -d <mac> <user> for a new account, or sudo
  usermod -d <mac> -m <user> for an existing one you are not logged in as; then add the machine again at that account`.
- Preflight and freeze (source daemon, `buildInventory`): new blocker `home_mismatch` when the destination's home
  differs, naming both homes and the same commands (`homeCommands` in `inventory.ts`, shared with host add; a home that
  needs quoting is quoted).
- A root outside the home needs its folder on the destination: new blocker `parent_missing`, raised by the controller's
  `destinationChecks`. The controller asks `handover.inspect` to probe `folders` (each carried root's landing folder:
  the home for anything under it, else the root's parent; sessions count against their agent home's) and blocks each
  root whose folder is missing: `trift has no /Volumes/work, which /Volumes/work/tool lands in; a folder outside the
  home arrives at the same path there, so make /Volumes/work on trift first`. The same probes give space, writability
  and case folding per folder, as the path-root probes did.

**2. Named path roots removed**
- Protocol: `PathRootMap`, `MachineRecord.pathRoots`, `TransferManifestV1.sourceRoots/sourceRealRoots/destinationRoots`
  (replaced by `home`, the shared home), `HandoverMachines.*.pathRoots` (replaced by `source.home` and
  `destination.home`), `handover.inspect`'s `pathRoots` (now `folders`, answered as `folders`), `RootProbe.collisions`,
  and the `path_root_missing` code. `TransferRoot.sourcePath/destinationPath` became one `path`. `MachinePath` is
  exported for the new fields. `PROTOCOL_VERSION` stays 17 (the branch's bump; the brief's "15" predates rebase2).
- An old `machines.json` or `MachineRecord` with `pathRoots` loads: zod drops the key, and the next save leaves it out
  (registry test; the gateway client's test keeps an old-shape registry file as its fixture).
- archid `portable-path.ts` keeps only `holds`, `realPath` and the field classification; `PortablePath`, `PathRootError`,
  `realRoots`, `holdingRoot`, `realHoldingRoot`, `locatePath`, `resolvePortablePath`, `mapPortablePath` and `rewrite`
  are gone. `PATH_FIELDS` names `TransferManifestV1.home` and `roots[].path` instead of the root maps.
- `importState` no longer rewrites or blocks: the snapshot and fleet.json come through as the source recorded them.
- cli `controller/paths.ts` and its test are deleted (only the test imported it); its probe tests moved to
  `archid/test/handover/probe.test.ts`. `Side` carries the registry `home`; `reach.ts` fills it from the record.
  `probeRoots` became `probeFolders`.

**3. Roots at their real paths**
- Source (`buildInventory`): every path a root is made from (character and second cwd, `home.cwd`, context refs and
  file: tabs, recorded repo fields without Git discovery, and each Git graph path) must be its own real path, else
  `path_symlinked`: `<p> leads to <real> through a symbolic link; a handover carries each folder at its real path, the
  one Git and the agents record, so use <real> instead`, with the character or graph as entity. The home itself is still
  never copied. The declared-root respelling of state and graphs is gone.
- Destination: `inspect` and `manifestProblems` (claim, prepare) block a root a link on that machine leads elsewhere
  (`path_symlinked`, `linkProblem` in `validate.ts`), replacing the "inside its path root" checks.
- The fleet `.env` travels only when the destination's fleet home puts it at the same path; otherwise preflight blocks
  (`path_unsupported`). Before, the destination refused it at claim.

**4. What the rewrite fed**
- Replica roots: `replicaRoots(manifest)` uses `root.path`, one side for both machines.
- Transcripts: the manifest places a session at the same path under the destination's agent home
  (`destinationHome + transcript`); `placeSessions`, `adapter.destination`, `claudeProjectSlug` and `placeFile` (the
  O5/O7 slug logic) are gone. `installSession` refuses a `destinationPath` that is not the transcript's own place.
- Manifest: `home` field; `spaceNeed` keyed by landing folder (`landingFolder` in `manifest.ts`).
- Controller: preflight and freeze send `source: { home }`, `destination: { info, home, fleetHome }`; freeze refuses a
  manifest over another home; transfer entries carry `path` (the source side; rsync still writes at the claim's path);
  `namesOf` names roots by `path`; `resumeFolders` expands `~` with `m.home`.

## 41b areas touched (mechanical only)

- `git-repair.ts`: `graphsHere` reads `commonDir` as is; `repairGraphs` passes an identity map; `mapThroughRoots` and
  the `PathRootError` refusal are gone. `repairGraph`/`validateGraph` keep their `map` parameter, the gitfile rewrite
  and `git worktree repair` untouched.
- Sessions: `sessionPathMap` maps only agent home to agent home (no `declared`, no root pairs); `PathMap.declared` and
  the `Walk.stays` use of it are gone. Rewrite, validate, the type lists and the version ranges are untouched.
- Tests: the Git fixture has one `home` and `park`/`unpark`/`parkedAt`, and the git-repair, destination Git and
  sessions tests model the second machine by parking the source tree and copying back to the same paths. Deleted as
  dead: the "still-reachable source" and "declared through a link" repair tests, the O5/O7 slug and either-spelling
  session tests, the linked-work destination test, the declared-root inventory tests. `sessions-live` (gated) now needs
  a remote with this machine's home.

## Tests (failing first)

Written against the old code first; all eight failed there (run log kept in the session scratchpad):
- protocol: an old `MachineRecord` with `pathRoots` reads without it.
- cli registry: an old `machines.json` with `pathRoots` loads, and saves without it.
- cli host: a far home other than the Mac's stops host add at `home`, with the commands, and installs nothing.
- archid source: a destination home that differs blocks preflight and freeze with `home_mismatch`; a cwd reached
  through a link blocks freeze with `path_symlinked` before a terminal is touched.
- archid inventory: a cwd, `home.cwd` and a context ref reached through a link block, each naming both paths.
- cli controller: a root outside the home whose folder is missing blocks with `parent_missing`, and passes once the
  folder is there; a round trip both ways with identical homes carries every path unchanged (roots, session homes,
  transcript paths) and sends both homes.

Written with the implementation: inventory (home mismatch message, root outside the home carried at its path, `.env`
at another fleet home, fleet home followed to its real path), manifest (`landingFolder`/`spaceNeed`), freeze refusing a
manifest over another home, probe tests moved from cli.

## Verification

| Command | Result |
| --- | --- |
| `pnpm vitest run --project protocol --project archid --project cli` | 125 files passed, 1 skipped; 2233 passed, 6 skipped |
| `pnpm typecheck` | clean |

Baseline on ce7b6f1c: 125 files, 2241 passed, 6 skipped; the difference is dead tests deleted (cli `paths.test.ts`
alone had 9). No load flake fired. The web UI has no path-root text and did not change, so the web suite was not run.

## Concerns

- A controller of the previous build sends `pathRoots` without `home`, so a daemon of this build refuses its
  preflight/freeze params as invalid. No shim, since a handover already requires an exact release match.
- The source compares the homes the controller's registry records. A far account whose home changed after `host add`
  leaves the registry stale until host add runs again; the destination does not check its own home. `home` in
  `system.info` would close that.
- `parent_missing` is a preflight check only. A claim still creates missing parents (`ReplicaStore.create`), so a folder
  removed between preflight and claim is recreated where permissions allow.
- The source-side symlink check covers root candidates only, not `defaultCwd` or a cwd equal to the home.
