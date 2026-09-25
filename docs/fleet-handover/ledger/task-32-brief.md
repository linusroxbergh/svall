### Task 32: Move push identity and notifications to the gateway

**Depends on:** Task 31

**Files:**

- Move/refactor: `packages/archid/src/push/` into gateway-owned services where appropriate
- Modify: gateway paths/main/relay event handling and mobile push client
- Create: `packages/archid/test/gateway/push.test.ts`

**Steps:**

- [ ] Store VAPID key and subscriptions under gateway fleet data, preserving endpoint/status/login
  fields and mode 0600.
- [ ] Keep the phone public key and subscribe/get/unsubscribe RPCs at the stable gateway origin.
- [ ] Forward owner state/status events with generation/session identity; gateway derives blocked/done
  pushes and deduplicates across relay reconnect/handover.
- [ ] Migrate a legacy subscription only by asking the phone to subscribe at the new stable origin;
  never copy a subscription tied to a different origin and claim it works.
- [ ] Ensure an inactive/old owner cannot emit pushes after gateway Commit.
- [ ] Keep push delivery independent of a currently open phone WebSocket.

**Verify:** gateway push tests with fake sender, handover/reconnect dedup test, manual lock-screen push.

**Commit:** `Push subscriptions stay with the fleet gateway`

