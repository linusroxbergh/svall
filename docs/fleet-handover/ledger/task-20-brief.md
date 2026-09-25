### Task 20: Implement safe destination replica records and divergence checks

**Depends on:** Task 19

**Files:**

- Create: `packages/archid/src/handover/replicas.ts`, `divergence.ts`
- Create: `packages/archid/test/handover/replicas.test.ts`, `divergence.test.ts`
- Modify: `packages/archid/src/paths.ts`

**Steps:**

- [ ] Store replica records outside repositories, keyed by fleet id plus canonical-path hash, and
  include canonical path, generation, manifest digest and content baseline.
- [ ] Reserve absent destination roots for a transaction using an exclusive record before creating
  them. Refuse an existing unowned path even when it looks like the same Git repository.
- [ ] Compare an inactive replica to its sealed baseline and list added/removed/changed paths with a
  bounded preview.
- [ ] Ignore configured host-local caches but not arbitrary ignored Git files.
- [ ] Implement explicit archive-to-timestamped-sibling with collision checks and report the recovery
  path; never call it from non-interactive handover without the flag naming that root.
- [ ] Seal new replica records only at transaction Complete; partial ones retain transaction id.

**Verify:** `pnpm vitest run --project archid test/handover/replicas.test.ts test/handover/divergence.test.ts`

**Commit:** `Inactive replicas cannot be overwritten without proving their baseline`

