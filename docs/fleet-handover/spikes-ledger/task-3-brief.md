### Task 3: Prove linked-worktree reconstruction

**Depends on:** none

**Files:**

- Create: `packages/archid/test/handover/worktree-portability.test.ts`
- Create: `scripts/probe-worktree-handover.mjs`

**Steps:**

- [ ] Build a fixture repository with a main checkout, one nested worktree, one sibling worktree,
  staged/unstaged/untracked changes, a stash and an unused registered worktree.
- [ ] Copy the common Git directory and used worktrees to different home prefixes.
- [ ] Rewrite `.git` and `.git/worktrees/*/gitdir`, remove only unused registrations from the copied
  metadata, run `git worktree repair`, and prove every used checkout has the same HEAD, index and
  porcelain status.
- [ ] Add a submodule fixture and verify that a character inside it is inventoried as its own graph.
- [ ] Turn the successful commands and invariants into a test helper for Task 21.

**Verify:** `pnpm vitest run --project archid test/handover/worktree-portability.test.ts`

**Commit:** `A fixture proves linked worktrees can move safely`

