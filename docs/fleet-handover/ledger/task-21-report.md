# Task 21 report — Git graph inventory, rewrite and validation

Status: DONE_WITH_CONCERNS
Branch: fleet-handover-task21 (worktree .claude/worktrees/fleet-handover-task21), base af58572
Commit: 0ef500d Git repository graphs arrive with every used worktree intact

## What was implemented

### Source side: discovery (`packages/archid/src/handover/git-graph.ts`)

- `discoverGit(state, { excludes, git?, exists? })` → `{ graphs, blockers, warnings }`. Runs
  `rev-parse --path-format=absolute --show-toplevel --git-common-dir --git-dir` from every character slot's
  cwd (main and second terminal), groups slots by common dir, then per graph reads
  `worktree list --porcelain -z`.
- Each graph (`GitGraph` in protocol) holds: `commonDir`; `main` (the main checkout, even when no character
  stands in it; absent for a bare repository); `worktrees` (every linked worktree a character uses, with the
  ids of the characters in it); `unused` (registrations nobody uses, with head/branch/locked/prunable);
  `stash` (entry ids, newest first).
- Each carried checkout (`GitCheckout`) records `path`, `gitDir`, `head` (null when unborn), `branch` (null
  when detached), `locked` (reason, '' for none), `status` (porcelain v2 tracked entries) and `index`
  (sha256 of `ls-files --stage -z`, i.e. every staged blob id).
- Status is read as `status --porcelain=v2 -z --untracked-files=no --ignore-submodules=untracked
  --no-renames`, so it is independent of either machine's own git config; untracked files are left to the
  file manifest (rsync verification), which also avoids false mismatches on excluded untracked folders.
- Main checkout location: a slot standing in it, else `dirname` of a `.git` common dir, else
  `git rev-parse --show-toplevel` from the common dir (a submodule's `core.worktree`); otherwise a blocker.
  The source also checks git lists the main worktree where git's own rule puts it (common dir less `/.git`).
- Submodules a character works in are their own graph (common dir `<super>/.git/modules/<name>`).
- The shared runner `gitRunner()/runGit` (in `links/git.ts`) spawns `git` with argv, `LC_ALL=C`,
  `GIT_OPTIONAL_LOCKS=0` (never rewrites the user's index or takes its lock), strips `GIT_DIR`-style
  redirect variables, and has a 5-minute timeout. `resolveRepo` now reuses `DIRS_ARGS/parseDirs` and the
  runner; `originUrl` untouched.
- `gitIndexDigest(buf)`: parses the Git index file (v2/v3/v4, SHA-1 and SHA-256, zeroed trailer under
  `index.skipHash`) and digests only mode, object id, stage, assume-valid/skip-worktree/intent-to-add flags
  and path. Undefined for a split index or anything it cannot read exactly (falls back to bytes).

### Inventory and manifest

- `buildInventory(state, configs, maps, git?: GitDiscovery)`: with discovery, graph roots replace the
  recorded `repo.*` roots: `repo` for a main checkout, `gitdir` (new root kind) for a common dir outside any
  checkout (bare repo, a submodule's modules dir carried without its superproject, a separate git dir), and
  `worktree` per used worktree. Each is located through the source roots (blocker entity `{kind:'git'}`),
  then folded as before, so nested worktrees/submodules inside a carried checkout are copied once. The
  recorded fields still have to map. Discovery blockers and warnings flow into the inventory; `Inventory`
  gains `git` and `warnings`.
- A bare repository no longer makes its parent a root.
- `rootExcludes(kind, excludes)`: a `gitdir` root reads no exclude (else `refs/heads/build/*`,
  `worktrees/dist/…` would be dropped). Used by fold, `buildManifest`'s scan and the replica proof.
- `buildManifest` carries `git: inventory.git` into `TransferManifestV1`, merges inventory warnings, blocks a
  vanished `gitdir` root, and records `gitIndex` on every file named `index` that parses as a Git index.

### Destination side (`packages/archid/src/handover/git-repair.ts`)

- `repairGraphs(manifest, deps)` — Task 26 calls this during prepare. First blocks any `repo`/`worktree`/
  `gitdir` root no graph describes (fail-closed if Task 25 ever builds a manifest without discovery). Then
  per graph `repairGraph` followed by `validateGraph`.
- `repairGraph(graph, map, deps)`, paths mapped through the manifest's named roots (`mapThroughRoots`):
  0. realpaths every carried piece and checks `git rev-parse --git-common-dir` opens the copy where it is;
     any failure blocks before anything is changed (e.g. an extension the destination git does not know);
  1. removes every `<common>/worktrees/<id>` the manifest does not carry (never `git worktree prune`),
     keeping branch refs;
  2. rewrites each carried worktree's `.git` gitfile and its registration's `gitdir` (absolute, or relative
     when the destination's effective `worktree.useRelativePaths` is true), and a main checkout's gitfile in
     the form it had (submodule relative, separate git dir absolute);
  3. `git worktree repair <mapped paths>` from the main checkout (or the bare dir); a non-empty report is a
     `git_mismatch` blocker (spike finding 2's assertion).
- `validateGraph`: each checkout's `rev-parse` dirs equal the mapped realpaths; status entries and the
  `ls-files --stage` digest equal the source's; `worktree list` holds exactly the main entry plus the
  carried worktrees with the same HEAD, branch/detached and lock, none prunable; the stash entry list is
  equal. Each difference is a `git_mismatch` blocker naming the path.
- DI: `RepairDeps = { git?: GitRunner; fs?: Partial<RepairFs> }`; `DiscoverOptions.git/exists`.

### Replica divergence made semantic for Git (carried from Task 20, `divergence.ts`, `replicas.ts`)

- A Git directory is a folder holding `HEAD` inside a `.git` (or the root itself for a `gitdir` root);
  under the innermost one: `FETCH_HEAD`, `objects/**`, `refs/remotes/**`, `logs/refs/remotes/**`,
  `refs/prefetch/**`, `logs/refs/prefetch/**` are ignored; `index` compares by `gitIndex` when both sides
  have it (else bytes). Everything else, including local branch refs, `HEAD`, `logs/HEAD`, `refs/stash`,
  `packed-refs`, still compares by bytes, so new commits, moved refs, staged changes and stash changes block.
- `proveReplica(..., kind)`; `ReplicaStore.assess` passes `root.kind`.

### Protocol (additive, `packages/protocol/src/handover.ts`)

- `GitCheckout`, `GitRegistration`, `GitGraph`; `TransferManifestV1.git` (optional);
  `TransferRoot.kind` += `gitdir`; `TransferFile` (file) += optional `gitIndex`; issue codes
  `git_mismatch`, `worktree_unused`, `remote_local`. All new string fields registered in
  `PATH_FIELDS`/`NOT_PATHS` (the schema-walk guard flagged them first).

## State decisions (controller ruling 2)

| State | Decision | How it surfaces |
| --- | --- | --- |
| Detached HEAD, used checkout | Supported | `branch: null`, commit in `head`; validation requires it still detached at that commit (a switch to a branch is `git_mismatch`) |
| Unborn HEAD | Supported | `head: null`, branch kept |
| Locked used worktree | Supported | `locked` reason recorded; lock file travels; repair works on locked worktrees (2.43 and 2.55); validation requires the same lock |
| Unused registration (any state: branch, detached, locked, missing) | Supported, not registered on the destination | listed in `graph.unused` with head/branch/locked/prunable; one `worktree_unused` warning per graph naming each, e.g. `…/gone (on gone-branch, missing)`, `detached at <sha12>`, `locked: <reason>` |
| Missing root of a used checkout (character recorded in a Git checkout whose cwd is gone) | Blocker `worktree_unresolved` (character) | |
| Slot root not among the registered worktrees; main checkout unlocatable; git refuses to read (dubious ownership, unknown extension, …) | Blocker `worktree_unresolved` | git's message kept whole |
| Tracked files under excluded paths | Blocker `path_unsupported` (git entity) | they would arrive deleted |
| Host-local origin (graph or initialized submodule) | Warning `remote_local` | spec's submodule-origin warning, applied to any carried repo |

Locked unused registrations are still removed on the destination: keeping any unlisted registration lets
`git worktree repair` follow it back to a reachable source (spike finding 1).

## Git versions exercised

- Mac: git 2.55.0 (all local tests).
- linus-vault: git 2.43.0 (Ubuntu 24.04), via the env-gated test. Probed first by hand (in `mktemp -d`
  dirs under /tmp, removed): `worktree list --porcelain -z` fields (bare, detached, `locked <reason>` with a
  newline, `prunable …`, unborn zeros), submodule main entry listed at the modules dir,
  `status --porcelain=v2 -z`, `stash list --format=%H`, `worktree repair <paths>` including locked and
  bare, `rev-parse --path-format=absolute`. `worktree.useRelativePaths` is ignored on 2.43; on 2.55 repair
  converts link form to that setting and reports it, which is why the rewrite follows the destination's
  effective setting.
- Remote run: `ARCHI_TEST_SSH=100.117.42.24 pnpm vitest run --project archid test/handover/git-repair.test.ts -t "remote machine|100.117.42.24"`
  → `remote git: git version 2.43.0`, `✓ the same graph on 100.117.42.24's git > discovers it, and rebuilds
  it under a new home prefix after the source is gone 36305ms`, `Tests 1 passed | 12 skipped`. It seeds the
  full fixture there, runs production discovery and repair through an ssh git runner and ssh fs adapter,
  uses the fixture's own empty `GIT_CONFIG_GLOBAL`, `StrictHostKeyChecking=yes`, `UpdateHostKeys=no`, and
  removes its `/tmp/archi-git-*` dir in `afterAll`. Checked afterwards: 0 `archi-git-*`/`archi-exp-*` dirs
  left there or here.

## Tests and results

- `pnpm typecheck`: clean.
- Focused: `pnpm vitest run --project archid --project protocol test/handover test/links.test.ts test/handover.test.ts`
  → `Test Files 1 failed | 16 passed (17)`, `Tests 1 failed | 301 passed | 1 skipped (303)`; the one failure
  is the known `inventory.test.ts` "carries a path inside mission control…" order flake. Includes the Task 3
  fixture `worktree-portability.test.ts` (7 tests, green).
- Brief's verify: `pnpm vitest run --project archid test/handover/git-graph.test.ts test/handover/git-repair.test.ts`
  → git-graph 16/16, git-repair 12 passed + 1 skipped (remote gated).
- Full `pnpm vitest run --project archid --project protocol` at load average ~168: `Tests 13 failed | 1043
  passed | 2 skipped (1058)`. Failures: fleet.test.ts (7), hooks.test.ts (3, timing asserts like
  `expected 2693 to be less than 2500`), workspace.test.ts (1), processes.test.ts (1), all 5 s timeouts or
  timing asserts, plus the skipHash test caught mid-edit (green since). Rerun alone: workspace, processes and
  links green; fleet.test.ts fails the same 3–4 revive/prompt tests with my `links/git.ts` and with af58572's
  (`git show af58572:packages/archid/src/links/git.ts` swapped in, run twice, restored) — known load flakes,
  not this change.

New/changed tests: git-graph.test.ts (parser, fake-git refusal paths, real fixture discovery, warnings,
tracked-under-excludes, bare repo, index digest incl. v4/SHA-256/skipHash/split index); git-repair.test.ts
(fake-git step order and each refusal, uncovered-root guard, real fixture round trip, untouched reachable
source, idempotent second run, each real change named, bare repo, remote); inventory/manifest/divergence/
replicas/protocol additions. `git-fixture.ts` is a shared POSIX-sh fixture so the same tree seeds here and
on the remote.

## TDD evidence

- Protocol: RED `pnpm vitest run --project protocol test/handover.test.ts` → `× … describes each repository
  graph … ZodError`, `× holds a Git index …`, `× names the ways …`, `Tests 3 failed | 26 passed`. GREEN
  `Tests 29 passed`.
- Path registry: RED `inventory.test.ts` → `× classifies every string field…` listing
  `TransferManifestV1.git[].…` and `…files[].gitIndex`. GREEN `Tests 22 passed`.
- Inventory with graphs: RED `Tests 3 failed | 22 passed` (first shows the old bare-parent root
  `['repo','code',…]`). GREEN 25 (24 + the known flake on one run).
- Manifest: RED `× the discovered Git graphs > …` ×3. GREEN `Tests 20 passed`.
- Divergence: RED `× reads a status refresh and a fetch as no change…`, `× reads Git state only inside a Git
  directory…`. GREEN `Tests 14 passed`.
- Replicas: RED `× proves a Git directory carried on its own whole…` (`expected { ok: false … } to match
  { ok: true, kind: 'replica' }`). GREEN `Tests 30 passed`.
- skipHash index: RED `× reads an index git wrote without its trailing hash…` (`expected undefined to be
  '34594fc…'`). GREEN 5/5 gitIndexDigest.
- git-graph.ts and git-repair.ts: honest note — for these two new modules I wrote the test file and the
  implementation in one pass before running the tests. RED was then recorded by moving each module aside:
  `Error: Failed to load url ../../src/handover/git-graph.js … Does the file exist?` / same for
  git-repair.js, `Tests no tests`. To show the tests are load-bearing I ran mutation checks (each restored,
  verified with `cmp`):
  - M1 prune after repair → `× drops every registration … before repair runs`, `× leaves a still-reachable
    source exactly as it was`.
  - M2 no gitfile/gitdir rewrite → `× … links each carried worktree both ways`, `× arrives with every used
    worktree …` (`expected [ { code: 'git_mismatch' … } ] to deeply equal []`: repair had links to fix).
  - M3 index compared by bytes → `× reads a status refresh and a fetch as no change`, `× is claimed after a
    git status and a fetch ran in it…`.
  - M4 no stash check → `× names each real change the destination copy holds…`.

## Files changed

- New: `packages/archid/src/handover/git-graph.ts`, `packages/archid/src/handover/git-repair.ts`,
  `packages/archid/test/handover/git-graph.test.ts`, `packages/archid/test/handover/git-repair.test.ts`,
  `packages/archid/test/handover/git-fixture.ts`.
- Modified: `packages/archid/src/links/git.ts`, `packages/archid/src/handover/{inventory,manifest,
  divergence,replicas,portable-path}.ts`, `packages/protocol/src/handover.ts`, tests
  `packages/archid/test/handover/{inventory,manifest,divergence,replicas}.test.ts`,
  `packages/protocol/test/handover.test.ts`.
- Untouched: `scripts/probe-worktree-handover.mjs` and `worktree-portability.test.ts` (kept as the spike's
  evidence; production code replaces the probe, and git-repair.test.ts reruns the same fixture shape
  against it, adding the detached, locked and missing states the spike lacked).

## Self-review findings

- Fixed during review: the submodule `.git` existence check in discovery used node fs directly (bypassing
  the injected `exists`); git refusals were cut to their first line (lost e.g. the extension name); a
  zeroed `index.skipHash` trailer made the index fall back to bytes; the index parse now has to land exactly
  on the trailer.
- `git-graph.ts` (293 lines) holds discovery, the snapshot readers shared with the destination, and the
  index digest. The digest is used by the manifest scan and the divergence proof; it fits "what a graph is
  made of" but is the one piece outside the plan's literal intent.
- Shared-file edits for the Task 22 cherry-pick: both branches edit the `@archipelago/protocol` type import
  line and the `Inventory`/`MachineMap` area of inventory.ts, and manifest.ts imports; my PATH_FIELDS lines
  sit away from Task 22's. Expect small mechanical conflicts.

## Concerns

1. Round trip loses unused registrations on the original machine (spec gap). Step 1 drops unlisted
   registrations on the destination copy, as the spec says. On the return handover the original machine is
   the destination: rsync `--delete` of the common dir removes its `.git/worktrees/<id>`, and the importer's
   step 1 would drop them anyway since the returning manifest does not know them. Their per-worktree HEAD
   and index go; a detached HEAD or staged-only change in an unused worktree then has no reference and can
   be gc'd. I surface this as the `worktree_unused` warning, not a blocker. It needs a spec/controller
   ruling (e.g. protect `.git/worktrees/*` the manifest does not name on the receiving side, or block a
   detached/staged unused registration).
2. Carried obligations: Task 25 must call `discoverGit(state, { excludes })` and pass it as
   `buildInventory`'s 4th argument; without it the legacy recorded-field roots are used, `git` is `[]`, and
   `repairGraphs` blocks at prepare. Task 26 calls `repairGraphs(manifest)` in prepare; its blockers fail
   prepare. Task 23/27: rsync and the destination claim must use `rootExcludes(root.kind, excludes)`, so a
   `gitdir` root gets no excludes (the claim/proof side is already wired through `root.kind`).
3. A repository with an extension the destination git lacks (`extensions.relativeWorktrees` from git ≥ 2.48
   with `worktree.useRelativePaths`, or `refStorage=reftable`) cannot be opened by linus-vault's 2.43. Repair
   blocks before touching the copy, but only at prepare, after the transfer. Catching it at preflight needs
   the destination's git version (Task 27's composition).
4. Machine-global git config (e.g. `core.autocrlf`) that differs between machines can make destination
   status differ → `git_mismatch` at prepare (fails closed).
5. The tracked-under-excludes check reads anchored custom excludes relative to each checkout's top, an
   approximation for worktrees folded into another root; it can only over-block.
6. Divergence still fails closed on a `git gc`/`pack-refs` on an inactive replica (loose refs move into
   `packed-refs`), and on any change to local refs, HEAD, logs or the stash.
7. Real-git tests are slow on this loaded machine (load average 110–190 during this task); their describes
   carry 60–180 s timeouts.

## Fix round 1

Commit: cd98837 A fetch or status refresh on a replica reads as no change, a bare repository's checkout
leaves its caches behind, and an unused worktree holding the only copy of some work blocks (on top of
0ef500d). Each item got a behavioural RED first.

### Important 1: how divergence finds Git directories

- Change (`divergence.ts` `roles`): a folder counts as a Git directory because of where it sits, not
  because it holds some file named HEAD: a `.git` folder; the root itself when it is a `gitdir` root; or,
  inside an already-recognised Git directory, `worktrees/<id>` or `modules/<name…>` holding HEAD. Candidates
  are checked shortest first, so `refs/remotes/origin` (holding `origin/HEAD`) is never a Git directory,
  inside `.git` or inside a submodule's modules dir. Under a bare root, `worktrees/<id>/index` is now read by
  its staged entries.
- Why not the suggested rule of HEAD plus `objects/` or `commondir`: a remote branch named `objects/x` or
  `commondir` next to `origin/HEAD` would satisfy it (there's a test for that case), and a repo whose
  `objects/` holds no files yet would drop out.
- Tests: `divergence.test.ts` "reads a fetch into a clone as no change, though origin/HEAD puts a HEAD among
  the remote refs" (it also covers the odd remote branch names, and a moved local branch still diverging)
  and "reads a status refresh in a bare repository's worktree as no change, and a new commit there as one";
  `replicas.test.ts` "is claimed after a fetch into a clone and a status refresh in a bare repository's
  worktree", using real git: `git clone` (so origin/HEAD exists), an upstream commit then `git fetch`, a bare
  clone with a worktree and `update-index --really-refresh`. Both still inspect ok; a commit in the bare
  repo's worktree then blocks.
- RED: `× … reads a fetch into a clone …` / `× … bare repository's worktree …` → `AssertionError: expected
  true to be false`; replica test → `AssertionError: expected { ok: false, …(3) } to match object { ok:
  true, kind: 'replica' }`.

### Important 2: a checkout inside a bare repository

- Change (`inventory.ts`): `rootExcludes` is gone. In its place, `rootMatcher(kind, excludes)` plus
  `excludeMatcher(patterns, kept?)`. In a `gitdir` root, Git's own entries at the top (`HEAD`, `config`,
  `packed-refs`, `index`, `refs/`, `logs/`, `objects/`, `worktrees/`, `modules/`, `info/`, `hooks/`, the
  `*_HEAD` files, `rebase-*`, `sequencer`, `lfs`, …) are never excluded, and the fleet's excludes apply to
  everything else. So `proj.git/main` still folds into the `gitdir` root, it is copied once, and its caches
  are left out. New export `GIT_DIR_KEEP_RULES` (`+ /<entry>` and `+ /<entry>/**` for each of those
  entries): the rsync rules for a `gitdir` root, put ahead of the excludes together with `GIT_KEEP_RULES`.
  The manifest scan, fold and replica proof all use `rootMatcher`, so what the manifest records for a root
  is what rsync runs with.
- Tests: `manifest.test.ts` "carries a checkout inside a bare repository once, its caches left out and all
  of Git's own entries kept" (files: `HEAD, config, logs/refs/heads/build/x, main/.git, main/src.ts,
  refs/heads/build/x, worktrees/main/HEAD, worktrees/main/index`; the worktree root is folded with no
  files), and "lists exactly what rsync copies of a bare repository with its keep rules ahead of the
  excludes", a real `rsync --dry-run` parity check. `inventory.test.ts` rewrote the old gitdir test: a note
  under `refs/heads/build/` rides inside the root, while one under a top-level `build/` is carried on its
  own; matcher checks for both kinds.
- RED: `× carries a checkout inside a bare repository once …` → `AssertionError: expected [ 'HEAD',
  'config', …(9) ] to deeply equal [ 'HEAD', 'config', …(6) ]` (it carried `main/node_modules/x/native.node`,
  `main/dist/out.js`, `main/app.tsbuildinfo`). The rsync parity test first failed on the missing export
  (`GIT_DIR_KEEP_RULES is not iterable`).
- Carried to Task 23/27: for a `gitdir` root, rsync gets `GIT_KEEP_RULES`, then `GIT_DIR_KEEP_RULES`, then
  the fleet excludes. The claim/proof side is already wired through `root.kind`.

### Important 3: controller ruling on unused registrations (binding)

- Change (`git-graph.ts` `unusedWork`), for each unused registration:
  - its folder is gone and it is locked → block;
  - its folder is there and `git status --porcelain=v2 -z` in it prints anything → block;
  - otherwise (folder there, or gone and not locked), a detached HEAD for which
    `git for-each-ref --contains <head> --count=1 --format=%(refname)` prints nothing → block.
  - Blockers use code `worktree_unused` with the git entity. The message names the path and what to do:
    mount it or unlock/remove it; commit or stash there, or remove the worktree; name the commit with
    `git branch <name> <sha>`, or remove the worktree.
  - A registration that blocks is no longer listed in the `worktree_unused` warning. The manifest's `unused`
    list still records every one.
- Test: `git-graph.test.ts` "blocks an unused worktree that alone holds work, and only warns of one that
  holds none" (real fixture plus: a staged change in `unused`; `stray` detached with a commit only it holds;
  `lost`, the same with its folder deleted; `away`, locked with its folder deleted; `safe`, detached at a
  commit main reaches). Exactly four blockers (`away`, `lost`, `stray`, `unused`); the warning names `gone`
  (on a branch, missing) and `safe`, and none of the blocked ones.
- RED: `AssertionError: expected [] to deeply equal [ …(4) ]` (a setup error in my own test helper was fixed
  first, so this RED is the behavioural one).
- git 2.43: I checked `for-each-ref --contains <sha> --count=1 --format=%(refname)` by hand on linus-vault
  (empty for an unreferenced commit, `refs/heads/main` for a reachable one). The remote fixture test, whose
  discovery now also runs `status` in the unused worktree, passed again: `remote git: git version 2.43.0`,
  `✓ … discovers it, and rebuilds it under a new home prefix after the source is gone`, `Tests 1 passed |
  12 skipped`. It left 0 `/tmp/archi-*` dirs there.

### Covering tests

- `pnpm typecheck`: clean.
- `pnpm vitest run --project archid test/handover/divergence.test.ts test/handover/replicas.test.ts
  test/handover/inventory.test.ts test/handover/manifest.test.ts test/handover/git-graph.test.ts
  test/handover/git-repair.test.ts` → `Test Files 6 passed (6)`, `Tests 123 passed | 1 skipped (124)` (the
  skip is the ssh-gated remote test; the mission-control ordering flake passed this run).
- `ARCHI_TEST_SSH=100.117.42.24 pnpm vitest run --project archid test/handover/git-repair.test.ts -t
  "100.117.42.24"` → 1 passed.

### What remains

- The earlier concerns 2–7 stand. Concern 1 (unused registrations on a round trip) is closed by the ruling
  as far as work goes: unreferenced work now blocks. A clean unused registration still loses its
  registration on the original machine after a return trip, but its branch and files stay.

## Fix round 2

Commit: 3aca3b4 An unused worktree's changes are read the same whatever the repository configures git
status to show (on top of cd98837).

- Change (`git-graph.ts` `unusedWork`): the unused-worktree check now runs
  `status --porcelain=v2 -z --untracked-files=normal` and reads the output through `parseStatus`, the parser
  the checkout snapshot already uses, which drops `#` header lines. Before, any output at all counted as
  changes. Two effects: `status.showStash=true` (whose `# stash N` line shows in every worktree while any
  stash exists) no longer blocks a clean worktree, and `status.showUntrackedFiles=no` no longer hides
  untracked files from the check.
- Test: `git-graph.test.ts` "reads an unused worktree the same whatever the repository says status should
  show". It uses the real fixture, which already holds a stash, with `status.showStash=true` and
  `status.showUntrackedFiles=no` set in the repository. The clean `unused` worktree gives no blockers; after
  an untracked file is written there, it gives the `worktree_unused` blocker.
- RED (before the change): `AssertionError: expected [ { code: 'worktree_unused', …(2) } ] to deeply equal
  []`. The clean `unused` worktree blocked with "holds changes git status reports".
- Covering: `pnpm typecheck` clean. `pnpm vitest run --project archid test/handover/git-graph.test.ts` →
  `Test Files 1 passed (1)`, `Tests 18 passed (18)`.
