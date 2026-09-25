# Task 21 fix round 1 — findings (from the review at 0ef500d) and controller rulings

## Important 1 — Git-dir detection in divergence.ts:29–46 breaks the semantic comparison (carried obligation 4)
- The rule: `roles` treats any folder holding a file named `HEAD` with a `.git` segment as a Git dir (:34).
- (a) Every cloned repo: a clone always holds a loose `.git/refs/remotes/origin/HEAD` (checked with a real clone and fetch on 2.55). That makes `.git/refs/remotes/origin` a "Git dir", so a fetch's new loose `refs/remotes/origin/main` and its reflog get the role `bytes` and read as `added`.
- (b) Bare repos: under a `gitdir` root, `worktrees/<id>/` is never a Git dir because it has no `.git` segment. A `git status` in a bare repo's worktree therefore makes `worktrees/<id>/index` read as `changed`.
- Reproduced both with a scratch script against `compareReplica`: `diverged: true` in each. Tests use no `origin/HEAD` and no bare worktree index (divergence.test.ts:69, :95; replicas.test.ts:309).
- Fix: count a folder as a Git dir only when it holds `HEAD` plus `objects/` (a common dir) or `commondir` (a registration); for a `gitdir` root, count the root itself as well. Add `origin/HEAD` + a fetch, and a bare-worktree index after `git status`, to the tests — both must stay non-divergent, while a real change (new commit, moved branch, changed staged content, stash) still diverges.

## Important 2 — a worktree inside a bare repo is carried with no excludes (inventory.ts:46, :257)
`rootExcludes('gitdir')` returns `[]`, and fold uses that list to test paths under a `gitdir` outer root, so `proj.git/main` (bare repo with worktrees inside) folds into the `gitdir` root. A scratch probe of buildInventory + buildManifest carried `main/node_modules/x/native.node`. Breaks "Excluded platform caches stay destination-local", and the unfiltered rsync `--delete` would replace the destination's own node_modules/.venv. Fix: exempt only Git's own layout inside a `gitdir` root (HEAD, config, refs/, objects/, logs/, worktrees/*/ metadata, modules/, info/, hooks/, packed-refs, …) and apply the fleet excludes to everything else — or never fold a checkout into a `gitdir` root (then the gitdir root must not carry the nested checkout itself). Outcome required either way: no fleet-excluded cache under a nested checkout is carried, nothing is copied twice, and the excludes the manifest records for each root are the ones rsync will run with. Test it.

## Important 3 — controller ruling 5 unmet (spec gap) — git-graph.ts:129, :173
An unused registration never blocks; nothing reads an unused worktree's status or checks whether its detached HEAD is reachable. After a round trip, `--delete` removes the original machine's registration: staged-only work is lost and detached commits become unreferenced.
Controller ruling (binding), per unused registration:
- its directory exists: block when `status --porcelain=v2` in it is non-empty, or when its detached HEAD is reachable from no ref (`git for-each-ref --contains <head> --count=1` is empty — not `rev-list --all`, which counts other worktrees' HEADs); otherwise the `worktree_unused` warning;
- its directory is gone and it is not locked (prunable — the user deleted its files): block only when its detached HEAD (readable from the registration) is reachable from no ref; otherwise the warning;
- its directory is gone and it is locked: block (its status cannot be read and the lock says keep it), naming the fix (mount it, or unlock/remove the worktree).
Blocker messages name the worktree path and what to do. Tests for each case.
