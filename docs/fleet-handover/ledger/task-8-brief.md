### Task 8: Add ownership and handover protocol types

**Depends on:** Tasks 5, 7

**Files:**

- Modify: `packages/protocol/src/handover.ts`, `messages.ts`
- Test: `packages/protocol/test/messages.test.ts`, `handover.test.ts`

**Interfaces:** `system.info`, `ownership.get`, `handover.preflight/freeze/prepare/activate/abort/status`,
handover events, blocker/warning/entity schemas, manifest summary; `PROTOCOL_VERSION` 9→10.

**Steps:**

- [ ] Encode every wire request/result from the spec with discriminated phase/error types.
- [ ] Keep full transfer manifests off ordinary events; events carry ids, phases and byte counts.
- [ ] Add server wait budgets for freeze/prepare/activate, while controller transfers remain outside
  daemon RPC timeouts.
- [ ] Add handshake capability fields without weakening rejection of incompatible protocol.
- [ ] Add compile-time exhaustive tests for the event unions and malformed generations/UUIDs.

**Verify:** `pnpm vitest run --project protocol && pnpm typecheck` (handlers intentionally land in
Task 11; if the methods table requires exhaustive handlers, add temporary explicit `not_ready`
handlers rather than weakening the type).

**Commit:** `The protocol names ownership and every handover phase`

