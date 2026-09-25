### Task 7: Make both terminal slots resumable in state schema v7

**Depends on:** Task 5

**Files:**

- Modify: `packages/protocol/src/state.ts`, `migrate.ts`
- Modify: `packages/archid/src/reconcile.ts`, `fleet.ts`
- Modify: CLI/web selectors that assume `second.tmux` is required
- Test: `packages/protocol/test/migrate.test.ts`, `packages/archid/test/reconcile.test.ts`,
  `fleet.test.ts`, affected web tests

**Steps:**

- [ ] Introduce one terminal-slot shape with cwd, optional tmux ids, optional agent, unread and
  optional revive metadata; adapt Character primary fields without forcing an all-at-once UI model
  rewrite.
- [ ] Make a second terminal dormant rather than deleting its record when its window disappears.
- [ ] Capture the second pane cwd during reconciliation and generate its agent resume command.
- [ ] Add migration v6→v7 that keeps existing characters and treats an absent second as absent.
- [ ] Update revive/close/read/run/seen paths for dormant secondary terminals.
- [ ] Ensure imported state can contain no tmux ids while preserving both sessions.

**Verify:** `pnpm vitest run --project protocol --project archid && pnpm vitest run --project @archipelago/desktop-web && pnpm typecheck`

**Commit:** `Both terminals survive as resumable character state`

