### Task 10: Implement local ownership state and the complete mutation fence

**Depends on:** Tasks 8, 9

**Files:**

- Create: `packages/archid/src/ownership/state.ts`, `guard.ts`
- Modify: `packages/archid/src/api/methods.ts`, `server.ts`, `main.ts`, `fleet.ts`, `terminals.ts`
- Modify: workspace and scribe/background entry points
- Create: `packages/archid/test/ownership.test.ts`

**Interfaces:** `OwnershipState.assertOwner(kind)`, `freeze`, `surrender`, `unfreeze`,
`installCommitted`; error codes `not_owner`, `frozen`, `handover_committed`.

**Steps:**

- [ ] Classify every RPC method as read-only, mutation, terminal creation or transaction-internal in
  one exhaustive table; CI fails when a new method lacks a classification.
- [ ] Guard all fleet, browser, filesystem, terminal and configuration mutations before side effects.
- [ ] Stop scribe, link refresh, reconciliation writes and other background writers while frozen;
  queue only derived refresh work that is safe to recompute after unfreeze.
- [ ] Refuse `term.attach`, `term.open`, revive and second-terminal creation on non-owners.
- [ ] Persist surrendered/frozen state before acknowledging Freeze so a stale source starts
  read-only without the gateway.
- [ ] Let read-only diagnosis work on inactive replicas without causing reconciliation to mutate the
  imported snapshot.
- [ ] Add a test that enumerates the methods table and invokes every classified mutation against
  inactive and frozen contexts.

**Verify:** `pnpm vitest run --project archid test/ownership.test.ts test/api.test.ts && pnpm typecheck`

**Commit:** `Only the current unfrozen owner can change a fleet`

