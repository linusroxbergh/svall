### Task 5: Add fleet and machine identity plus configuration schemas

**Depends on:** M0

**Files:**

- Create: `packages/protocol/src/handover.ts`
- Modify: `packages/protocol/src/state.ts`, `index.ts`
- Create: `packages/protocol/test/handover.test.ts`
- Modify: `packages/archid/src/config.ts`, `paths.ts`
- Create: `packages/archid/test/config-migration.test.ts`

**Interfaces:** `MachineId`, `FleetId`, `FleetConfig`, `NodeConfig`, `MachineRecord`, `PathRootMap`,
`OwnerRecord`, `TransactionRecord`; `resolvePaths` gains fleet/node/owner/journal/replica paths.

**Steps:**

- [ ] Add UUID-shaped branded zod schemas and ownership/transaction schemas from the spec.
- [ ] Split existing config fields: portable home/default/scribe/linear/mobile/handover policy into
  `fleet.json`; host/port/shell into `node.json`.
- [ ] Write a one-time migration from `config.json` that backs up the exact original, writes both new
  files atomically, preserves unknown-key failure behavior, and is idempotent after interruption.
- [ ] Generate a fleet id for every existing profile without changing its profile name/home.
- [ ] Keep a composite runtime config API temporarily so existing Fleet/Mobile callers can migrate
  task-by-task rather than in one unsafe edit.
- [ ] Change Settings “Fleet config” to target `fleet.json`; expose `node.json` through diagnostics,
  not the ordinary portable settings button.

**Tests:** defaults, malformed legacy config, partial migration, permissions, private/named fleets,
unknown keys, id stability across restart.

**Verify:** `pnpm vitest run --project protocol && pnpm vitest run --project archid test/config-migration.test.ts && pnpm typecheck`

**Commit:** `Every fleet and machine setting has a portable home`

