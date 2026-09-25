### Task 16: Add gateway authority compare-and-swap service

**Depends on:** Tasks 9, 13, 15

**Files:**

- Create: `packages/archid/src/gateway/authority.ts`, `server.ts`, `client.ts`, `bin.ts`
- Create: `packages/archid/test/gateway/authority.test.ts`, `server.test.ts`
- Modify: companion package exports/bin wiring

**Interfaces:** `owner.create/get/begin/ready/commit/abort/complete`; Unix-socket JSON protocol;
atomic per-fleet record and serialized compare-and-swap.

**Steps:**

- [ ] Implement pure transition functions first and table-test every valid/invalid phase/generation.
- [ ] Serialize mutations per fleet and persist the result before acknowledging.
- [ ] Permit create only when fleet id is absent; begin only from current owner/generation; ready only
  with source-freeze proof plus destination prepared digest; commit only from ready.
- [ ] Make abort pre-commit only and complete committed only; idempotently return the same record for
  a repeated identical request.
- [ ] Expose the authority through a mode-0600 local Unix socket and an `archi gateway owner` SSH
  command. Do not bind it to the tailnet.
- [ ] Finish `host enable` by creating the absent generation-zero authority record with the invoking
  Mac as owner; treat an existing record as idempotent only when fleet and owner ids match.
- [ ] Quarantine malformed records and refuse ownership changes until repaired.

**Verify:** `pnpm vitest run --project archid test/gateway/authority.test.ts test/gateway/server.test.ts`

**Commit:** `The gateway is the durable authority for fleet ownership`

