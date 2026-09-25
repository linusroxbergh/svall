### Task 11: Wire the ownership and handover daemon surface

**Depends on:** Tasks 9, 10

**Files:**

- Create: `packages/archid/src/handover/service.ts`
- Modify: `packages/archid/src/api/methods.ts`, `server.ts`, `main.ts`
- Modify: `packages/archid/src/bin.ts`
- Test: `packages/archid/test/handover/service.test.ts`, `api.test.ts`, `daemon.test.ts`

**Steps:**

- [ ] Add `system.info` and `ownership.get` with real machine/fleet/release/schema capability data.
- [ ] Add handover handlers delegating to a service with injected planner/session/authority deps;
  phases not implemented until later return typed `not_ready`, never fake success.
- [ ] Broadcast ownership/handover entity events from journal changes.
- [ ] Start an existing owner normally; start an inactive replica without Fleet reconciliation or
  tmux window adoption.
- [ ] On a source journal, remain frozen until controller resume/abort. On a destination committed
  journal, allow only activation retry.
- [ ] Preserve local daemon startup and existing API tests when no fleet/gateway record exists by
  initializing existing fleets as local generation-zero owners during migration.

**Verify:** `pnpm vitest run --project archid && pnpm typecheck`

**Commit:** `archid exposes ownership without changing local fleets`

**M1 gate:** Run `pnpm test && pnpm typecheck`. Start an existing private and named fleet by hand,
confirm state migration/backup, then use a test owner file to prove inactive and frozen daemons reject
every mutation and start no tmux windows.

---

# Phase C — published companion and remote viewing

