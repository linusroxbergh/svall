### Task 21: Implement Git graph inventory, rewrite and validation

**Depends on:** Tasks 3, 19, 20

**Files:**

- Create: `packages/archid/src/handover/git-graph.ts`, `git-repair.ts`
- Create: `packages/archid/test/handover/git-graph.test.ts`, `git-repair.test.ts`
- Reuse/refactor: `packages/archid/src/links/git.ts`

**Steps:**

- [ ] Convert Task 3's probe helper into typed production discovery using absolute
  `--show-toplevel/--git-common-dir/--git-dir` and porcelain worktree listing.
- [ ] Associate characters with used worktrees and include main/common roots even when no character
  stands in the main checkout.
- [ ] Detect nested worktrees and submodules without copying a filesystem subtree twice.
- [ ] Rewrite copied worktree gitfiles and common-dir registrations through named path mappings;
  prune destination-copy registrations outside the transfer manifest while retaining branch refs.
- [ ] Run worktree repair and compare HEAD, branch, porcelain-v2 status, staged blob ids and stash
  refs to the source manifest.
- [ ] Surface detached heads, locked worktrees and missing registered roots as explicit supported
  states or blockers—never silently normalize them.

**Verify:** Task 3 fixture plus `pnpm vitest run --project archid test/handover/git-graph.test.ts test/handover/git-repair.test.ts`

**Commit:** `Git repository graphs arrive with every used worktree intact`

