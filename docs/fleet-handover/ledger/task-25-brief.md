### Task 25: Implement source freeze, abort and export service

**Depends on:** Tasks 19, 22, 24

**Files:**

- Modify: `packages/archid/src/handover/service.ts`
- Create: `packages/archid/src/handover/source.ts`
- Create: `packages/archid/test/handover/source.test.ts`

**Steps:**

- [ ] Preflight without mutation: source ownership/version/path/agent/process/Git checks and stable
  blocker codes used by CLI/UI. Task 27 composes these with destination replica/space checks.
- [ ] Freeze only for an authority Begin record naming this source/destination/generation.
- [ ] Persist surrendered ownership and source journal before returning the immutable manifest.
- [ ] Stop background writers, rest chosen terminals and emit per-character progress.
- [ ] On pre-commit abort, prove authority still names source at generation, clear surrender, revive
  only terminals handover stopped, restart background work and close the journal.
- [ ] Refuse abort when authority is committed or unreachable with a local ready/committed journal.
- [ ] Make repeated Freeze/Abort calls idempotent by transaction id.

**Verify:** `pnpm vitest run --project archid test/handover/source.test.ts test/ownership.test.ts`

**Commit:** `A source fleet freezes and aborts without losing its crew`

