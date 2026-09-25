### Task 33: Finish mobile migration UI and end-to-end coverage

**Depends on:** Tasks 30–32

**Files:**

- Modify: desktop/mobile settings panels, `Mobile.tsx`, mobile boot/routing/service worker
- Modify: CLI mobile command
- Create/modify: `apps/desktop/web/e2e/phone-handover.spec.ts`, archid mobile tests
- Modify: README/SMOKE draft sections

**Steps:**

- [ ] Make `mobile on` provision the stable gateway route and show its URL/QR; explain that the
  gateway is required and report owner relay status separately from serving status.
- [ ] Offer a one-time migration notice for users with the old owner-specific PWA.
- [ ] Preserve fleet label/icons and subscription UI under the path-scoped scope.
- [ ] Test owner local, owner gateway, handover both ways, owner offline, gateway restart and relay
  reconnect without changing the URL.
- [ ] Test login allowlist enforcement and concurrent phones through the proxy.

**Verify:** all mobile unit/e2e tests and manual PWA/push acceptance.

**Commit:** `The fleet phone app keeps its URL through handover`

**M4 gate:** Install the PWA once, subscribe to blocked/done, hand the fleet Mac→gateway→Mac, and
prove the same URL, service-worker scope and push subscription still work. Turn off the owner and
verify the same URL shows offline; restart it and verify automatic recovery.

---

# Phase F — remote port discovery and forwarding

