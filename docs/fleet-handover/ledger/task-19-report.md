# Task 19 report: immutable transfer manifest and path classifier

Status: DONE_WITH_CONCERNS
Commit: 58a3c46 A handover begins with one immutable transfer manifest (BASE 1168d22, no attribution)

## What was implemented

- **Protocol (`packages/protocol/src/handover.ts`, `messages.ts`)**: replaced the Task 8 placeholder
  `ManifestRoot`/`ManifestSession`/`TransferManifest` (counts only) with `TransferFile`, `TransferRoot`,
  `TransferSession`, `TransferManifestV1`. The freeze result now carries `TransferManifestV1`. The
  manifest no longer embeds its own digest (a digest cannot sit inside what it hashes);
  `ManifestSummary` keeps `digest` for preflight. `transactionId` is optional (a preflight manifest names
  none). Excludes are manifest-level. Two issue codes were added: `path_unsupported` and `env_file`.
  `TRANSFER_SCHEMA_VERSION` stays 1 because nothing has shipped.
- **`handover/portable-path.ts`**: `resolvePortablePath`/`mapPortablePath`/`PortablePath`/`PathRootError`
  moved here from `packages/cli/src/controller/paths.ts`, since archid cannot import cli. The cli file
  re-exports them, so there is one implementation, its tests are unchanged and green, and the package has
  a new export `@archipelago/archid/handover/portable-path`. The lexical half was split out as
  `holdingRoot` with no change in behaviour. The file also holds the classifier: `PATH_FIELDS` (portable,
  machine-local or forbidden, plus a `PortableForm` for each portable field), `NOT_PATHS`, the generic
  `fieldValues` accessor, `portablePathValues`, and `exportSnapshot`, which strips every forbidden field.
- **`handover/inventory.ts`**: `buildInventory(state, configs, machineMaps)` builds the following:
  - Git roots from each character's recorded `repo`. The main checkout becomes `repo`, a linked worktree
    becomes `worktree`.
  - Non-Git cwd roots, for both terminal slots.
  - The mission-control cwd (`FleetConfig.home.cwd`, since fleet.json is authoritative) as `home`.
  - File and folder context refs of characters and islands, plus `file:` browser tabs, as `context` roots
    when nothing else covers them.
  - The fleet `.env` as an `env` root, only when `transferFleetEnv` is set.
  - One session entry per slot from its recorded `agent.transcriptPath`.

  It also folds nested roots. A root is folded only when the outer root's copy puts its files exactly
  where the inner root maps and no component between them is excluded. A folded `repo` or `worktree`
  stays listed with `foldedInto`, and any other folded root is dropped.

  Every portable path in state and fleet.json is checked. A path no declared source root holds, or one
  whose real path escapes its root, blocks with `path_root_missing`. So does a path whose root the
  destination lacks, once per character and root. A control character or a path that is not absolute
  blocks with `path_unsupported`. `expandExcludes` puts the defaults first unless `excludeDefaults` is
  false, then the fleet's own patterns, each once. It blocks patterns rsync would read as rules or
  comments (`+ `, `- `, `!`, `#`, `;`), empty patterns, and patterns with control characters.
  `excludeMatcher` implements rsync's pattern rules (anchoring, trailing `/`, basename versus whole path,
  `*`, `**`, `?`, `[..]`).
- **`handover/manifest.ts`**: `buildManifest(inventory, header, scanFs?)` walks each carried root through
  an injectable `ScanFs`:
  - Files are streamed through SHA-256 and recorded with mode (`& 0o7777`), size and truncated `mtimeMs`.
  - Symlinks are recorded as their text and never followed. Special files are skipped. Excluded paths are
    absent, so they are out of both copy and divergence.
  - Names with control characters or invalid UTF-8, and unreadable entries, become one
    `path_unsupported` blocker per root. The file is left out. A file that vanishes mid-scan (ENOENT) is
    skipped.
  - A repository `.env`/`.env.*` gets an `env_file` warning for its root, and so does a transferred fleet
    `.env`.
  - A missing transcript blocks with `transcript_missing`. A missing repo or worktree root blocks with
    `worktree_unresolved`. Other missing roots are dropped.
  - Everything is sorted by code unit, parsed through `TransferManifestV1` and digested.

  Also in this file:
  - `manifestDigest` (parse, then canonical digest), `summarize` (a `ManifestSummary`) and `spaceNeed`
    (bytes per destination path root, each file rounded up to 4 KiB, with unplaced or unrooted files
    counted against `home`).
  - `writeManifest`/`readManifest` write durably at 0600 as canonical JSON, so `sha256(file) == digest`.
    Writing the same manifest again is a no-op, and a different manifest (or an unreadable file) at that
    path is refused.
- **`handover/hash.ts`**: `canonicalJson` (keys in code-unit order, no whitespace, JCS-compatible for
  manifest values; undefined object keys dropped; NaN, Dates and undefined array items refused),
  `canonicalDigest`, `sha256Hex`, streaming `hashStream`, and `byCodeUnit`.

## Tests

- `pnpm vitest run --project archid test/handover/manifest.test.ts test/handover/inventory.test.ts`:
  31 passed.
- `pnpm vitest run --project protocol`: 106 passed.
- `pnpm vitest run --project archid`: 808 passed on the first full run. The final full run had 807 passed
  and 1 failed: `fleet.test.ts > recovers from a tmux server death`, the known fleet.test flake under
  load. It passed 3/3 when run alone.
- `pnpm vitest run --project cli`: 270 passed, 2 skipped (the paths tests go through the re-export).
- `pnpm typecheck`: clean.

The schema-walk test lives in `inventory.test.ts > path classification`. It walks every string leaf of
FleetState, FleetConfig, NodeConfig, MachineRecord and TransferManifestV1 through their zod
definitions, and throws on a zod type it does not know. It asserts three things:
1. Every leaf is in `PATH_FIELDS` or `NOT_PATHS`.
2. A `FleetState` extended with `characters.*.scratchDir: z.string()` is reported unclassified.
3. No registry entry names a field that no longer exists.

The canonical-digest tests are:
- Key-insertion order: `canonical json > gives one digest...`.
- State insertion order plus reversed `readdir` order, with two sessions across characters, giving the
  same manifest digest; a JSON round trip also gives the same digest.
- Content change and transaction id both change the digest.

## TDD evidence

RED for the protocol, after the fixtures were updated to the V1 shape and before the schema existed.
Command: `pnpm vitest run --project protocol`.

```
× transfer manifest > carries every root and session with the content of each file
× transfer manifest > names no transaction when a preflight built it
× ownership and handover methods > freezes against a transaction and a generation and returns the manifest
TypeError: Cannot read properties of undefined (reading 'parse')   / ZodError: roots.0.bytes Required
Test Files  2 failed | 6 passed (8)   Tests  3 failed | 103 passed (106)
```

GREEN for the protocol after the schema: `Tests 106 passed (106)`.

RED for archid, with both test files written before any module existed:

```
FAIL test/handover/inventory.test.ts  Error: Failed to load url ../../src/handover/inventory.js ... Does the file exist?
FAIL test/handover/manifest.test.ts   Error: Failed to load url ../../src/handover/hash.js ... Does the file exist?
Test Files  2 failed (2)   Tests  no tests
```

GREEN for archid: `Tests 31 passed (31)`. The one failure on the way was the order of problems inside a
blocker message, which followed traversal order. They are now sorted.

Mutation checks were run by removing a line, running the focused tests, then restoring. Every mutation
turned a test red:

| Mutation | Test that failed |
| --- | --- |
| File sort | the order-independence digest test |
| Key sort in canonicalJson | 4 tests |
| Session sort | the order-independence digest test |
| Fold's exclude check | the fold test |
| Fold's mapping check | the fold test |
| Forbidden strip | the tmux snapshot test |
| Root sort | the inventory order test |

Exclude parity: a 22-entry tree run through `rsync -a --dry-run --exclude-from` (openrsync, the only
rsync on this Mac) gives the same file list as `buildManifest` with the same patterns.

## Files changed

- Created in `packages/archid/src/handover/`: `hash.ts`, `portable-path.ts`, `inventory.ts`,
  `manifest.ts`
- Created in `packages/archid/test/handover/`: `inventory.test.ts`, `manifest.test.ts`
- Modified in `packages/protocol/`: `src/handover.ts`, `src/messages.ts`, `test/handover.test.ts`,
  `test/messages.test.ts`
- Modified: `packages/cli/src/controller/paths.ts` (re-exports the moved helpers),
  `packages/archid/package.json` (new export)

## Interfaces later tasks consume

- **Protocol**:
  - `TransferManifestV1` holds `{ version: 1, transactionId?, generation, fromMachineId, toMachineId,
    sourceRoots, destinationRoots, fleet, snapshot, excludes, roots, sessions }`.
  - `TransferRoot` holds `{ id, kind: 'repo'|'worktree'|'cwd'|'home'|'context'|'env', entry: 'dir'|'file',
    sourcePath, destinationPath, foldedInto?, files }`.
  - `TransferFile` is `{ type: 'file', path, mode, size, mtimeMs, sha256 }` or
    `{ type: 'symlink', path, target }`. Paths are relative to the root, and `''` means a file root itself.
  - `TransferSession` holds `{ characterId, term?, agent, sessionId, sourcePath, destinationPath?, files }`.
    Its files are relative to the transcript's directory.
  - Also added: `HandoverIssueCode` values `path_unsupported` and `env_file`.
- **`handover/inventory.ts`**:
  - `buildInventory(state: FleetState, configs: InventoryConfigs, machineMaps: MachineMaps): Inventory`
  - `InventoryConfigs = { fleet }`
  - `MachineMaps = { source, destination }`, where each side is a
    `MachineMap = { machineId, pathRoots, fleetHome }`
  - `Inventory`, `InventoryRoot`, `InventorySession`
  - `DEFAULT_EXCLUDES`, `expandExcludes`, `excludeMatcher(patterns)(relative, dir)` (Task 20 uses the same
    matcher to ignore caches in divergence), `CONTROL`, `settle`
- **`handover/manifest.ts`**:
  - `buildManifest(inventory, { transactionId?, generation }, scanFs?)` returns
    `{ manifest, digest, blockers, warnings }`
  - `ScanFs`, `realScanFs`
  - `manifestDigest`, `summarize`, `spaceNeed`, `writeManifest(file, manifest)`, `readManifest(file)`
- **`handover/portable-path.ts`**:
  - `PathClassification`, `PortableForm`, `PathField`, `PATH_FIELDS`, `NOT_PATHS`
  - `fieldValues(doc, field)`, `portablePathValues(docs, home)` (Task 26's rewrite walks these),
    `exportSnapshot`
  - `holdingRoot`, `holds`, `resolvePortablePath`, `mapPortablePath`, `PortablePath`, `PathRootError`
- **`handover/hash.ts`**: `canonicalJson`, `canonicalDigest`, `sha256Hex`, `hashStream`, `byCodeUnit`

## Self-review findings, fixed before commit

- `Inventory.warnings` was always empty, because every warning comes from the scan. It was removed.
- `NOT_PATHS` first used subtree prefixes (`FleetConfig.mobile`, `lastPrompt`), which would let a future
  path under them go unclassified. Every leaf is now listed. Only the forbidden `tmux` entries cover a
  whole subtree, deliberately.
- Blocker messages listed problems in traversal order. They are now sorted.

## Decisions and concerns for the controller

1. **Standing in a declared root copies nothing.** A non-Git cwd, home cwd or context folder whose portable
   path is a root itself (relative `''`) is mapped but not carried. Otherwise a shell at `~`, which is
   `DEFAULT_CWD`, would copy the whole home directory. The spec says only "non-repository character cwd
   roots". Please confirm. Git roots are carried even when they are a declared root.
2. **`file:` browser tabs are treated as file context refs.** Following the spec's rewrite list, they are
   carried when uncovered and blocked when outside every root.
3. **Git roots come from the recorded state, not from rev-parse**, as the ruling said. `repo.mainRoot` is
   `dirname(git-common-dir)` from `links/git.ts`, so a bare repository with worktrees would make the
   bare dir's parent a root. The second terminal has no `repo` record, so a second terminal in a different
   repository is carried as a plain cwd. A submodule character's git dir (`super/.git/modules/…`) is
   carried only when its superproject is a root. Task 21's discovery must replace or extend these.
4. **The default excludes (`build/`, `dist/`, `target/`) also drop tracked files under those names.**
   Task 21's `git status` validation will see them as deleted. That is spec behaviour, but it is worth
   knowing.
5. **Folding is lexical.** A cwd reached through a symlink to another root is carried twice. A carried root
   that contains a declared path root mapped elsewhere also copies that subtree under the outer mapping. It
   is not blocked, and it is rare.
6. **The manifest carries the per-file list inline**, as the spec says ("modes, sizes"). A 100k-file repo
   is roughly 15 MB of JSON in the freeze result, and the `ws` client's default maxPayload is 100 MiB.
   Hashing is sequential, which keeps memory bounded but not fast. Both are for Task 38.
7. **Transcript placement is left to Task 22.** `TransferSession.destinationPath` is optional until an
   adapter places it. `spaceNeed` counts unplaced sessions against `home`. The adapter extends `files`
   with sidecars under the transcript's directory.
8. **The controller must supply `fleetHome` for both machines in `MachineMap`.** It is used for the fleet
   `.env` destination.
9. **`mapPortablePath`'s missing realpath containment was left alone.** The classifier resolves source
   paths through `resolvePortablePath`, and the destination side is lexical by nature. The carried
   obligation stands.
10. **The classifier covers only the persisted and carried schemas** (FleetState, FleetConfig,
    NodeConfig, MachineRecord, TransferManifestV1). RPC params, OwnerRecord and the journals are not
    covered. `tmux` ids are classified `forbidden`: they are machine handles, not paths, and are stripped
    at export as the spec requires.
11. **Where `writeManifest` writes is not decided here.** No path was added to `paths.ts`. Task 25 picks
    one, for example beside the journal.

## Fix round 1

Commit: 91f9941 A handover keeps every Git record whatever the excludes say, and never carries a fleet home

1. **Excludes stop at `.git` (Important).** `excludeMatcher` now returns false for any relative path with a
   `.git` component, so neither the walk nor the fold check excludes Git's own records. The same rule is
   exported for Task 20's filter file as `GIT_KEEP_RULES = ['+ .git', '+ .git/**']`, to go ahead of the
   excludes. It was checked against real rsync:
   - Without the rules, `rsync --exclude-from` on a repo with branch `build/x` and a worktree named `build`
     drops `.git/refs/heads/build/x` and `.git/worktrees/build/*`.
   - With them, rsync keeps both, and the working tree's own `build/` stays excluded.

   New tests:
   - A matcher case: `.git/refs/heads/build`, a submodule's `.git/modules/dist` and a worktree gitfile are
     never excluded, even with `.*` and `*` patterns. `x.git/build` still is.
   - A real `git init` fixture with branch `build/x` and a sibling worktree named `build`. The manifest
     holds `.git/refs/heads/build/x` and `.git/worktrees/build/{HEAD,index,gitdir}`, and `build/out.js`
     stays out.
   - A parity test: the repo root's file list equals `rsync -a --dry-run --exclude-from=<GIT_KEEP_RULES +
     DEFAULT_EXCLUDES>`. It skips with a named reason when git or rsync is absent, and ran here against
     openrsync.
2. **Fleet homes are never carried (ruling).** Before folding, a candidate root is dropped and blocked
   (`path_unsupported`, root entity) when:
   - its source path holds or lies inside the source fleet home, or
   - its destination path holds or lies inside the destination fleet home.

   Two roots are exempt: mission control's `home` root, which is exempt only when it lies inside the
   fleet home and still blocks if it holds it, and the `env` root, which is added only under
   `transferFleetEnv`. The check runs before folding so that a blocked root cannot absorb mission
   control's cwd. I read the ruling as covering overlap in either direction, because "other than home.cwd
   itself" only has force if roots inside the fleet home count. So a cwd at `~/.archipelago/hooks` blocks
   too, since it would overwrite the destination's hooks, journal or replicas. The test covers a cwd at the
   fleet home, one inside it, one that lands on a differently placed destination fleet home, and that
   `home` and `env` survive.
3. **Symlink text is held to the same v1 rule (ruling).** A link whose text holds a control character is
   left out and reported in the root's `path_unsupported` blocker. Tested.
4. **A file root folds as a file (ruling).** `PathValue` now carries `entry` (`file` for a file context
   item, a `file:` URL or a transcript, otherwise `dir`), and so does `InventoryRoot`. The fold check reads
   only the last component by that entry, so a context file named `build` inside a carried folder is
   folded instead of carried twice. Tested. The scanned `entry` still overrides at manifest time.

Verification:
- RED: 6 new tests failed for their reasons. Two examples: `expected true to be false` for the `.git`
  path, and `GIT_KEEP_RULES is not iterable`.
- GREEN: focused 37/37; `--project archid` 814/814; `--project protocol` 106/106; cli paths 9/9;
  `pnpm typecheck` clean.

## Fix round 2

Commit: e5a0efb A root is judged by its real path against the fleet home, and folds by what is on disk

1. **The fleet-home check reads real paths.** `resolvePortablePath` is now a thin wrapper over the newly
   exported `locatePath(absolute, roots)`, which returns `{ portable, real }`: the real path it already
   checked. `realish` is exported as `realPath`. `fleetHomeClash` compares three things:
   - the lexical source path against the source fleet home;
   - the real source path against the real source fleet home;
   - the lexical destination path against the destination fleet home.

   Test: a cwd `~/archi-link` symlinked to `~/.archipelago`, which holds a `token`, is now blocked with
   "overlaps the fleet home" and carried nowhere.
2. **Anything inside mission control is exempt.** Mission control is the `home` candidate, as long as it
   does not itself hold a fleet home. A root whose source path, real path and destination path all lie
   within mission control's is exempt from the "lies inside a fleet home" rule, so it folds into the
   `home` root. Test: a context file at `<fleetHome>/home/notes.md` gives no blockers and no separate
   root, and the `home` root is carried. The same test covers `home.cwd` set to the fleet home itself:
   both mission control and the notes file are blocked, so the exemption exempts nothing. Removing the
   mission-control guard turns that test red.
3. **`entry` comes from disk.** `PathValue.entry` from round 1 is gone. Each candidate's `entry` is now
   the stat of its real path: a directory is `dir`, anything else is `file`, and a path that isn't there
   folds as `dir`. buildInventory has no injected fs; it already reads the real fs through
   `resolvePortablePath`, and the manifest's scan (injected `ScanFs`) still overrides `entry` from its
   own stat. Test: a `file:` tab naming a directory `build` inside a carried worktree is now its own
   `context` root with `entry: 'dir'`, not folded away. A file named `build` still folds.

Verification:
- RED: 3 new tests failed for their reasons (`expected [] to deeply equal [ObjectContaining…]`,
  `expected [ {…} ] to deeply equal []`, `expected undefined to match object { kind: 'context', entry: 'dir' }`).
- GREEN: focused 39/39 (inventory 22); `--project archid` 816/816; cli paths 9/9 through the reworked
  `resolvePortablePath`; `pnpm typecheck` clean.
