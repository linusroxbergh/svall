### Task 26: Implement destination prepare and post-commit activation

**Depends on:** Tasks 20–22

**Files:**

- Create: `packages/archid/src/handover/destination.ts`, `validate.ts`
- Modify: `packages/archid/src/handover/service.ts`, `store.ts`, `fleet.ts`
- Create: `packages/archid/test/handover/destination.test.ts`

**Steps:**

- [ ] Accept Prepare only on the named inactive destination, matching transaction/generation and
  manifest digest.
- [ ] Rewrite every registered state path, remove tmux ids, install destination transcript paths and
  validate schema/Git/session/replica state without changing active `state.json` or starting tmux.
- [ ] Write prepared state/journal durably, provision the relay secret if present, then return the
  proof used by `owner.ready`.
- [ ] Accept Activate only after querying/validating committed authority at generation `g+1`.
- [ ] Promote prepared state atomically, replace the Store, then revive terminals with bounded
  concurrency. Record each success/error without rolling ownership back.
- [ ] Make activate retry skip already-live matching windows and retry only failed/dormant slots.
- [ ] Leave plain shells at mapped cwd with a clear restart notice; wait for matching agent
  SessionStart when resuming and report timeout as a character error.

**Verify:** `pnpm vitest run --project archid test/handover/destination.test.ts test/fleet.test.ts`

**Commit:** `A committed destination activates the prepared fleet exactly once`

