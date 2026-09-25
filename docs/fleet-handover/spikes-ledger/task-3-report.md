# Task 3 report: prove linked-worktree reconstruction

Commit: `9e00063 A fixture proves linked worktrees can move safely`
Git measured: **2.55.0** (macOS, darwin 25.6.0)

## What was implemented

`scripts/probe-worktree-handover.mjs` — the reusable spike helper. Exports:

- `discoverGraph(cwd)` — one `git rev-parse --path-format=absolute --show-toplevel
  --git-common-dir --git-dir`, returning `{ root, commonDir, gitDir, isWorktree }`. Same rule as
  `packages/archid/src/links/git.ts`: `gitDir !== commonDir` means a linked worktree.
- `listWorktrees(cwd)` — parses `git worktree list --porcelain` into
  `{ path, head, branch, prunable }`.
- `snapshotCheckout(cwd)` — the portability invariant per checkout: `rev-parse HEAD`,
  `status --porcelain=v2 --branch`, `ls-files -s`, `diff --cached --name-status`, `stash list`,
  `rev-parse refs/stash`.
- `reconstruct({ mainRoot, worktrees })` — the importer steps on the destination copy: rewrite each
  worktree's `.git` gitfile, rewrite the matching `.git/worktrees/<id>/gitdir`, remove every
  registration the manifest omits, then `git worktree repair <mapped paths>`. Returns
  `{ commonDir, rewritten, pruned, repaired, repairReport }`, where `repairReport` is repair's
  stderr — empty means the rewrite left git nothing to do.

A CLI wrapper runs the same thing standalone and prints JSON
(`node scripts/probe-worktree-handover.mjs <destination-main-checkout> [<worktree>...]`);
smoke-tested by hand.

`scripts/probe-worktree-handover.d.mts` — 13-line type surface so the TS test can import the `.mjs`
without a `@ts-ignore` (the repo's tsconfig has no `allowJs`). The sibling probes are spawned as
subprocesses instead; the brief asked for these to be imported.

`packages/archid/test/handover/worktree-portability.test.ts` — hermetic fixture in
`fs.mkdtempSync` (realpath'd, because `/tmp` is a symlink to `/private/tmp` on macOS and the
comparison is byte-exact against git's own output), with `GIT_CONFIG_GLOBAL`, `GIT_CONFIG_NOSYSTEM`,
fixed `user.name`/`user.email` and `-c commit.gpgsign=false`. Every git call is
`execFileSync('git', [...])`. The suite is `describe.skip`ped with the reason in its title when git
is not on PATH.

The fixture: `<tmp>/Users/source/work/demo` (main checkout) with a nested worktree at
`demo/.claude/worktrees/nested`, a sibling worktree at `work/sibling`, a registered-but-unused
worktree at `work/unused`, a `file://` submodule at `demo/sub`, a stash, and staged + unstaged +
untracked changes in all three used checkouts. Transfer copies `demo` and `sibling` to
`<tmp>/home/dest/work/…`, keeping the nested and sibling layout; `unused` is not copied. Most tests
then delete `<tmp>/Users` outright, so the destination has to stand on its own.

## Observations about real git

1. **`git worktree repair <mapped paths>` fixes both sides of the link on its own.** It rewrites
   `<common>/worktrees/<id>/gitdir` *and* the moved worktree's `.git` gitfile. Spec steps 1 and 2
   (the manual rewrites) are therefore **redundant** on git 2.55.0 — they are belt and braces, not a
   requirement. Asserted by the test "fixes both sides of the link from the mapped paths alone,
   without the rewrite". Keeping them is still cheap and makes the destination self-consistent
   before repair runs, which is why `reconstruct` does them; `repairReport === ''` afterwards is the
   proof they subsume what repair would have done.
2. **Repair maps by registration id, not by directory name.** Two worktrees whose directories are
   both called `feature` get ids `feature` and `feature1`; the id survives the copy inside the
   worktree's own `.git` gitfile, and repair resolves both correctly. (Measured in a scratch probe,
   not committed — it does not change the importer.)
3. **`git worktree repair` with no path arguments fixes nothing.** Every registration still names
   the source machine, so git has nothing to anchor on and all of them stay `prunable`. Passing the
   mapped destination paths is the load-bearing part of step 4.
4. **A registration left in the copy makes repair write to the source machine.** With
   `<source>/work/unused` still reachable (same machine, shared mount, or a rehearsal),
   `git worktree repair` run in the destination copy rewrote `<source>/work/unused/.git` to point at
   the *destination's* common dir — i.e. it corrupted the machine being migrated from. So **spec
   step 3 must happen before step 4**, not just "as well as". Both directions are asserted: the
   clobber when repair runs first, and an untouched source (gitfiles, gitdir files, snapshot and
   worktree list all byte-identical) when `reconstruct` prunes first.
5. **`git worktree prune` is the wrong tool for step 3.** At import time no registration resolves
   yet, so prune removes *all* of them — in the fixture it deleted `.git/worktrees` entirely. Step 3
   must remove exactly the registration directories the manifest omits.
6. **Branch refs survive a dropped registration.** `refs/heads/unused-branch` resolves to the same
   sha after `.git/worktrees/unused` is removed, because branch refs live in the common dir and only
   `HEAD`/`index`/`refs/bisect` are per-worktree.
7. **The stash travels with the common dir.** `refs/stash`, its reflog and `git stash list` come
   across untouched and read identically from the main checkout and from every linked worktree.
   (`git stash push -u` in the main checkout prints `Ignoring path .claude/worktrees/nested/` — the
   nested worktree is untracked there; harmless, and stderr is captured.)
8. **Submodules need no rewrite.** Git writes a submodule's `.git` gitfile relative
   (`gitdir: ../.git/modules/sub`) and its `core.worktree` relative (`../../../sub`), so both stay
   correct after the move. From inside, `--git-dir == --git-common-dir == <super>/.git/modules/sub`
   and `--show-toplevel` is the submodule directory: a character working there is **its own
   repository graph**, which is exactly the shape `packages/archid/src/links/git.ts` already reads.
   Otherwise the submodule's working directory and the superproject's gitlink (`160000` entry in
   `ls-files -s`) travel with the containing graph, unchanged.
9. Not proved and out of scope: a submodule's `origin` remote still points at the source machine's
   URL after the move. `git status`, `rev-parse` and `submodule status` all work offline, but a
   `file://`-style submodule origin will not fetch on the destination. Worth a line in the spec.

## Tests

`pnpm vitest run --project archid test/handover/worktree-portability.test.ts` — 7 tests.

**RED** (captured by short-circuiting `reconstruct` before the rewrite/prune/repair, then restoring
the file):

```
× rebuilds every used checkout under a new home prefix with its HEAD, index, status and stash
× drops a registration the manifest leaves out and keeps its branch
× needs the mapped paths: neither a bare repair nor a prune reconstructs the copy
✓ follows a left-over registration back to the source machine and rewrites it
✓ touches nothing on a still-reachable source when the registrations are pruned first
✓ inventories a submodule as its own graph and moves it without a rewrite
Error: Command failed: git stash list
```

The three that stayed green under that mutation are the ones that assert git's own behaviour rather
than the importer's: the clobber, the "do not touch the source" guarantee (with nothing happening,
nothing is touched) and the submodule, which by finding 8 needs no rewrite at all. The first
iteration also failed for real on `git worktree prune` removing `.git/worktrees` itself rather than
emptying it, which is what finding 5 now records.

**GREEN**:

```
✓ |archid| test/handover/worktree-portability.test.ts (7 tests) 3753ms
   ✓ rebuilds every used checkout under a new home prefix with its HEAD, index, status and stash
   ✓ fixes both sides of the link from the mapped paths alone, without the rewrite
   ✓ drops a registration the manifest leaves out and keeps its branch
   ✓ needs the mapped paths: neither a bare repair nor a prune reconstructs the copy
   ✓ follows a left-over registration back to the source machine and rewrites it
   ✓ touches nothing on a still-reachable source when the registrations are pruned first
   ✓ inventories a submodule as its own graph and moves it without a rewrite
```

- `pnpm vitest run --project archid` — 46 files, 528 tests, all passing.
- `pnpm typecheck` — clean.
- Output is pristine: no stray git chatter, no skipped tests, no warnings.

## Files changed

- `packages/archid/test/handover/worktree-portability.test.ts` (new, 250 lines)
- `scripts/probe-worktree-handover.mjs` (new, 111 lines)
- `scripts/probe-worktree-handover.d.mts` (new, 13 lines)

Nothing else in the worktree was touched; `packages/archid/src/links/git.ts` was read only. Another
agent's uncommitted changes (`package.json`, `pnpm-lock.yaml`, `scripts/spikes/`) were left alone and
are not in the commit.

## Self-review

- Every brief step is covered: fixture with all six ingredients, copy under a different home prefix,
  rewrite + selective prune + repair, same HEAD/index/porcelain status/staged blob ids/stash proved
  by an exact snapshot comparison, submodule inventoried as its own graph, and the invariants
  exported for Task 21.
- The link assertions compare against paths built independently of what the probe wrote
  (`expectLinkedTo`), so they are not circular.
- The tests exercise real git throughout — no mocks, no fixture files checked in.
- YAGNI: `reconstruct` has no options, no dry-run, no logging levels. `listWorktrees` returns only
  the four fields the assertions use.
- Fixture cost is ~500ms per test (three `git init`s, three `worktree add`s, a submodule). Seven
  seeds is ~4s, which seemed a fair price for keeping each test independent.

## Concerns (DONE_WITH_CONCERNS)

1. **Spec step ordering is wrong as written.** Step 3 (remove unlisted registrations) must run
   *before* step 4 (`git worktree repair`), otherwise repair writes into the source machine's
   checkouts whenever they are still reachable. Finding 4.
2. **Spec steps 1 and 2 are redundant.** `git worktree repair` with the mapped paths already fixes
   both the gitfile and the gitdir entry. The spec can either drop them or keep them explicitly as
   belt and braces; it should not describe them as what makes the move work. Finding 1.
3. **The spec should warn against `git worktree prune`.** It is the obvious tool for step 3 and it
   destroys the import. Finding 5.
4. Measured on git 2.55.0 / macOS only. Steps 1 and 2 may stop being redundant on older git, so
   keeping them is the safer read of finding 1. The destination is Linux; nothing here is
   macOS-specific except the `/tmp` realpath detail the test already handles.
5. A submodule's `origin` remote is not remapped by any of this (finding 9); the spec does not
   mention it.
