### Task 9: Add durable Store replacement and transaction journals

**Depends on:** Task 8

**Files:**

- Modify: `packages/archid/src/store.ts`
- Create: `packages/archid/src/handover/journal.ts`, `durable.ts`
- Test: `packages/archid/test/store.test.ts`, `handover/journal.test.ts`

**Interfaces:** `Store.replace(snapshot)`, `DurableJson<T>`, `HandoverJournal`, prepared-state path,
fault-injectable write stages.

**Steps:**

- [ ] Add validated whole-snapshot replacement that emits one correct JSON patch, persists before
  listeners run, and never merges stale destination entities.
- [ ] Implement durable JSON writes: exclusive temp, chmod, write, fsync file, rename and fsync
  parent directory where supported. Clean only temp files proven to belong to a completed write.
- [ ] Define source/destination journal schemas with transaction id, generation, role, phase,
  manifest digest, stopped terminal ids and error/progress details.
- [ ] Store prepared state separately from active `state.json`; promote only after committed
  authority is confirmed.
- [ ] On startup, load and surface a valid journal; quarantine a malformed journal without silently
  making the fleet writable.
- [ ] Add injected failures after every durability boundary and prove each restart state.

**Verify:** `pnpm vitest run --project archid test/store.test.ts test/handover/journal.test.ts`

**Commit:** `Fleet snapshots and handover journals survive process death`

