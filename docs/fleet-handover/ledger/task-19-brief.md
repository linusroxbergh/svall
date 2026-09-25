### Task 19: Build the immutable transfer manifest and path classifier

**Depends on:** M2, Tasks 6–8

**Files:**

- Create: `packages/archid/src/handover/manifest.ts`, `portable-path.ts`, `inventory.ts`, `hash.ts`
- Create: `packages/archid/test/handover/manifest.test.ts`, `inventory.test.ts`
- Modify: protocol handover schemas if spike fixtures require versioned fields

**Interfaces:** `TransferManifestV1`, `TransferRoot`, `TransferFile`, `PathClassification`,
`buildInventory(state, configs, machineMaps)`; stable canonical JSON digest.

**Steps:**

- [ ] Centralize the registry of every absolute protocol/config path field and classify it portable,
  machine-local or forbidden. Add a schema-walk test that fails on an unclassified future path.
- [ ] Inventory state snapshot, fleet config, Git graphs, non-Git cwd roots, mission-control cwd,
  uncovered file/folder context refs and exact session artifacts.
- [ ] Fold nested roots without losing a separate Git-worktree transformation step.
- [ ] Expand excludes deterministically; make custom excludes additive unless defaults are explicitly
  disabled. Flag repository `.env` and optional fleet `.env` in warnings.
- [ ] Stream SHA-256 content manifests with mode, size and mtime; exclude host-local cache paths from
  both copy and divergence comparison.
- [ ] Produce canonical JSON/digest independent of object insertion order and source traversal order.
- [ ] Estimate transfer bytes/free-space need and reject control-character paths unsupported in v1.

**Verify:** `pnpm vitest run --project archid test/handover/manifest.test.ts test/handover/inventory.test.ts`

**Commit:** `A handover begins with one immutable transfer manifest`

