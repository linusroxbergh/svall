### Task 27: Implement the end-to-end controller transaction

**Depends on:** Tasks 16, 23, 25, 26

**Files:**

- Create: `packages/cli/src/controller/handover.ts`, `recovery.ts`, `events.ts`
- Create: `packages/cli/test/controller/handover.test.ts`, `recovery.test.ts`

**Steps:**

- [ ] Implement Begin→Freeze→Transfer→Verify→Prepare→Ready→Commit→Activate→Complete exactly in
  spec order, checking returned ids/generations/digests at every boundary.
- [ ] Persist a controller journal containing routes and progress but no API/relay tokens.
- [ ] Define cancellation semantics: before Freeze cancel cleanly; after Freeze call safe Abort;
  after Commit cancel only detaches the observer while activation continues/retries.
- [ ] Reconstruct status from controller/source/destination/gateway journals and choose the only safe
  resume action.
- [ ] Treat an unknown Commit response as “query authority,” never “abort source.”
- [ ] Complete only after destination state is active. Updating the source's cached owner is best
  effort rather than a prerequisite because its surrendered journal already fences it.
- [ ] Add table-driven fake-dependency tests for controller death/network failure after every await.

**Verify:** `pnpm vitest run --project cli test/controller/handover.test.ts test/controller/recovery.test.ts`

**Commit:** `The controller advances one recoverable handover transaction`

