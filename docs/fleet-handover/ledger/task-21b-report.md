# Task 21b report: path roots through symlinks, and the handover.json read

Status: DONE_WITH_CONCERNS (the concerns are about scope, see the end)

Commits on fleet-handover-impl (parent 1d6a6b6):
- 07b73a4 A repository under a path root declared through a link is placed by its real path and named through the declared root
- e369bb3 A repository's handover file is read only as a regular file of at most 64 KiB, and a file named .archipelago holds none

## 1. Path roots declared through a symlink

### What changed
- `portable-path.ts`: new `realHoldingRoot(absolute, roots, realpath?)` places a path under the declared root whose real path is the longest one that holds the path's own real path. It shares the longest-match logic with `holdingRoot` through a private `longestHolding`, so `holdingRoot` behaves exactly as before. `realpath` can be injected. A root whose real path cannot be read is skipped.
- `inventory.ts`: `buildInventory` now respells every discovered graph through a new `declaredGraph` before placing its roots. The fields respelled are `commonDir`, `main.path`/`gitDir`, `worktrees[].path`/`gitDir` and `unused[].path`. Each path is written as `mapPortablePath(realHoldingRoot(p), source.pathRoots)`, so it reads as the declared root plus the relative path. A path that no root holds by real path keeps git's spelling, and the existing `locate` still blocks it with `no path root holds <path>` (`path_root_missing`). The inventory's `git` field returns the respelled graphs, and so does the manifest built from it. Graph ids are unchanged: they are still hashed from git's real common directory.

### Why the graph is respelled, not just the root's destinationPath
The fix needed more than a correct `destinationPath`. Two consumers only work when the manifest names graph paths in the declared spelling:
- `git-repair.ts` runs on the destination. There, `mapThroughRoots` maps graph paths lexically through `manifest.sourceRoots`, and `repairGraphs` checks that every Git root's `sourcePath` is described by a graph path. The destination cannot resolve the source's real paths.
- Folding compares root `sourcePath`s lexically. A character whose cwd is `~/code/app` (the declared spelling) must fold into the repo root, or the tree is sent twice.

With everything in the declared spelling, the manifest stays consistent and `git-repair.ts` needed no change. I checked `replicas.ts`, which already canonicalises by real path, and `divergence.ts`, which works on root-relative paths only. Neither has the mismatch, so neither changed.

### Tests (both new)
- `inventory.test.ts`, "places a repository under the root whose real path holds it, and names it through that root (needs git)". The fixture is real git. `work` is declared as a link (`<tmp>/code -> <tmp>/disk/code`), and on macOS `/tmp` adds a second link. The repository comes out as a single `repo` root at `<declared>/app`, mapped to `/srv/work/app`, and the character's cwd root folds into it. The graph's `commonDir`, `main.path` and `main.gitDir` are in the declared spelling. A repository outside every root by real path still blocks, once for the character and once for the graph.
- `git-repair.test.ts`, "rebuilds a graph whose path root is declared through a link, from the paths the manifest names through that root". This runs the full SEED fixture with the home root declared through a link. Every root `sourcePath` and every graph `commonDir`/`path`/`gitDir` in the manifest sits under the declared link. After transfer and unplug, `repairGraphs` passes with no blockers and relinks `[nested, detached, locked, sibling]` and `[sub]`.

RED, on the code before the fix:
```
$ pnpm vitest run --project archid test/handover/inventory.test.ts test/handover/git-repair.test.ts -t "declared through a link|places a repository under the root"
 FAIL  git-repair.test.ts > ... declared through a link ...
   expected [ …(7) ] to deeply equal []     (at manifestOf: built.blockers)
+     "code": "path_root_missing", "message": "no path root holds /private/tmp/archi-git-nILeZA/Users/source/work/demo" (and 6 more graph roots)
 FAIL  inventory.test.ts > ... places a repository under the root whose real path holds it ...
-     "repo",
+     "cwd",
      "/tmp/archi-t-k80df5/code/app",
 Tests  2 failed | 38 skipped (40)
```
GREEN, on the fix:
```
 ✓ ... places a repository under the root whose real path holds it, and names it through that root (needs git) 419ms
 ✓ ... rebuilds a graph whose path root is declared through a link, from the paths the manifest names through that root 1086ms
 Tests  2 passed | 38 skipped (40)
```
The existing inventory tests use hand-built graphs with `/tmp` spellings. They still pass unchanged, because respelling a path that is already declared gives back the same string.

## 2. The `.archipelago/handover.json` read (source.ts)

### What changed
- A new `readHandoverFile(file, sfs)` goes through the injected `ScanFs` (`this.d.scanFs ?? realScanFs`) instead of `fs.promises.readFile`:
  - It lstats the file first and never follows it.
  - `ENOENT` or `ENOTDIR` means there is no handover file, so a regular file named `.archipelago` no longer raises a false blocker.
  - A symbolic link gives `<file> is a symbolic link, and a handover file must be a regular file`.
  - A FIFO, directory or other non-regular file gives `<file> is not a regular file, and a handover file must be one`. It is never opened, so the pre-rest check cannot hang on it.
  - A file whose lstat size is over 64 KiB gives `<file> is over 64 KiB, more than a handover file may hold`. The streamed read also stops once it passes 64 KiB, which covers a file that grows after the lstat.
  - Any other error still reads `<file> cannot be read: <code>`.
- Every problem is a `platform_unsupported` blocker naming the file, on the root's entity, as before.

### Test (new)
- `source.test.ts`, "reads a handover file only as a regular file of at most 64 KiB, and a file named .archipelago as none". It uses real git and real files, and runs five cases:
  - notFolder: `.archipelago` is a regular file.
  - link: a link to a valid file outside the repo.
  - large: valid JSON padded past 64 KiB.
  - pipe: a real `mkfifo`.
  - grown: the injected `lstat` reports 26 bytes while the file holds more than 64 KiB, which exercises the cap on the read itself.

  The test opens the pipe for writing without blocking after 1 s. If a regression opens the pipe, the test then fails on its assertion instead of hanging a worker thread. With the fix nothing opens the pipe, so that write open fails quietly with ENXIO.

RED, on the pre-fix source.ts (`git show HEAD:…/source.ts`) with the same test:
```
-   "grown": [[ "platform_unsupported", ".../handover.json is over 64 KiB, ..." ]]
+   "grown": [],
+   "large": [],
+   "link": [],
+   "notFolder": [[ "platform_unsupported", ".../handover.json cannot be read: ENOTDIR" ]]
    "pipe": [[ "platform_unsupported",
-      ".../handover.json is not a regular file, and a handover file must be one"
+      ".../handover.json is not a handover file, which names the platforms ..." ]]   (it hung in open until the test released it)
 Tests  1 failed | 28 skipped (29)
```
Mutation check: the fix with only the in-read cap removed fails on `grown` alone (`"grown": []`), so the read cap is load-bearing and the lstat size check does not cover for it.

GREEN:
```
 ✓ source preflight > reads a handover file only as a regular file of at most 64 KiB, and a file named .archipelago as none 344ms
```
It finishes well inside the 1 s release timer, so the pipe was never opened.

## Verification
- Covering tests: `pnpm vitest run --project archid test/handover/inventory.test.ts test/handover/git-graph.test.ts test/handover/manifest.test.ts test/handover/source.test.ts test/handover/git-repair.test.ts`: 5 files, 108 passed, 1 skipped (the ARCHI_TEST_SSH remote test).
- `pnpm typecheck`: exit 0.
- `pnpm vitest run --project archid`: 68 files passed and 1 skipped; 1037 tests passed and 3 skipped. No flakes this run.

## Files changed
- packages/archid/src/handover/portable-path.ts
- packages/archid/src/handover/inventory.ts
- packages/archid/src/handover/source.ts
- packages/archid/test/handover/inventory.test.ts
- packages/archid/test/handover/git-repair.test.ts
- packages/archid/test/handover/source.test.ts

## Concerns
1. State paths have the same lexical-vs-real mismatch, and it is out of scope here. `fleet.ts:313` and `reconcile.ts:96` record a character's cwd from the tmux pane path, which is the real path. A cwd reached through `~/code -> /Volumes/work/code` is therefore stored as `/Volumes/work/code/app` and still blocks as `no path root holds …`. Fixing that means respelling the state snapshot too, because the destination rewrites snapshot fields lexically through `sourceRoots`. That work touches the snapshot rewrite that Task 26 owns, so I left it.
2. There is a gap between the lstat and the open of `handover.json`. A regular file swapped for a FIFO in that gap would still be opened. `manifest.ts`'s walk has the same pattern. Closing it needs an `O_NOFOLLOW | O_NONBLOCK` open with an fstat, which would widen the `ScanFs.read` signature. I did not add it.
3. The check still reads through an `.archipelago` directory that is itself a link. Only the file's own last component is lstat'd, as the brief asked, so a linked `.archipelago/` pointing out of the repo is followed.

## Fix round 1: a linked `.archipelago/` folder

Commit: 06bf5d9 A handover file is not read through an .archipelago folder that is a link, which blocks instead (on top of e369bb3)

### Change (source.ts `readHandoverFile`)
- `path.dirname(file)`, the `.archipelago` folder, is now lstat'd before the file:
  - `ENOENT` or `ENOTDIR` means there is no handover file.
  - A symbolic link is a `platform_unsupported` blocker naming the folder: `<root>/.archipelago is a symbolic link, and a handover file must lie in the repository itself`.
  - Anything that is not a directory, such as a regular file, means there is no handover file.
- Only then is the file itself lstat'd and read, with the same checks as before.
- The repository root is never lstat'd, so a root declared through a link is still followed.
- Each problem message now carries its own path (folder or file), and `platformBlockers` passes it through unchanged. The file-level messages are the same as before.
- Concern 3 of the original report is resolved by this round.

### Test
There is one new case, `linkedFolder`, in source.test.ts, "reads a handover file only as a regular file of at most 64 KiB, and a file named .archipelago as none". In it, `bo/.archipelago` links to an outside folder that holds a valid `{ "platforms": ["linux"] }`.

RED, on e369bb3:
```
$ pnpm vitest run --project archid test/handover/source.test.ts -t "reads a handover file only"
-   "linkedFolder": Array [
-     Array [
-       "platform_unsupported",
-       "/private/tmp/archi-t-8681f5/bo/.archipelago is a symbolic link, and a handover file must lie in the repository itself",
-     ],
-   ],
+   "linkedFolder": Array [],
      Tests  1 failed | 28 skipped (29)
```
The outside file was read through the link and passed the check.

GREEN, with the covering tests:
```
$ pnpm vitest run --project archid test/handover/source.test.ts
   ✓ source preflight > reads a handover file only as a regular file of at most 64 KiB, and a file named .archipelago as none 429ms
 Test Files  1 passed (1)
      Tests  29 passed (29)
$ pnpm typecheck
exit 0
```
