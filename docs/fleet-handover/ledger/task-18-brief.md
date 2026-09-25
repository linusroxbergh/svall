### Task 18: Add host setup and remote-state UI

**Depends on:** Tasks 15, 17

**Files:**

- Create: `apps/desktop/web/src/HostSetup.tsx`, `host.ts`
- Modify: `bridge.ts`, `store.ts`, `SettingsCard.tsx`, `Corner.tsx`, `styles.css`
- Modify: Swift bridge/controller process handling
- Test: web unit tests and `apps/desktop/web/e2e/host.spec.ts`

**Steps:**

- [ ] Add typed bridge messages to start/cancel host operations and stream NDJSON step events.
- [ ] Build Add Machine as an attended checklist: connect, prerequisites, companion, service, agent
  logins and final probe. Preserve actionable stderr without leaking tokens.
- [ ] Show owner machine in the corner and window title; no badge for local owner.
- [ ] Render reconnect/offline/version-mismatch states without losing loaded fleet state.
- [ ] Add doctor/upgrade/remove actions and confirmation before forgetting an unreachable host.
- [ ] Keep all controls behind `handover.enabled`; direct CLI remains available to developers.

**Verify:** `pnpm vitest run --project @archipelago/desktop-web && pnpm --filter @archipelago/desktop-web exec playwright test e2e/host.spec.ts`

**Commit:** `A published app can add and inspect its Linux machine`

**M2 gate:** Provision a clean supported Ubuntu x86-64 account from the built app, with no checkout,
Node or pnpm. Create a remote-only test fleet, open twelve terminal surfaces, drop/reconnect SSH, and
verify the daemon survives logout and Mac app exit. Repeat artifact installation on arm64 CI/manual
hardware before release, even if daily development uses one architecture.

---

# Phase D — transfer inventory and transactional handover

