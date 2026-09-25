### Task 4: Prove release packaging and stable relay assumptions

**Depends on:** none

**Files:**

- Create: `scripts/spikes/build-companion.mjs`
- Create: `packages/archid/test/gateway/relay-contract.test.ts`
- Create: `docs/superpowers/plans/fleet-handover-spike-results.md`
- Modify if required: fleet handover spec and this plan

**Steps:**

- [ ] Bundle the current CLI/daemon to production JavaScript and run it with a pinned Node runtime in
  a clean Ubuntu container without pnpm or the repository.
- [ ] Verify native architecture naming, executable permissions, hook template lookup and mobile
  asset lookup from an installed release directory.
- [ ] Put a test WebSocket behind a path-based `tailscale serve` mapping on an available tailnet
  machine, verify identity headers and a `/f/<fleetId>/` PWA scope, and record the manual evidence.
- [ ] Prove an owner can establish an outbound authenticated WSS connection to the gateway and that
  bidirectional RPC/terminal-sized frames survive it.
- [ ] Record decisions on bundler, Node source/license inclusion, archive layout, release signature,
  Tailscale Serve invocation and relay framing. Update Tasks 12 and 30 with any changed paths.

**Verify:** run the spike script in a clean container and
`pnpm vitest run --project archid test/gateway/relay-contract.test.ts`

**Commit:** `The release and relay assumptions have executable probes`

**M0 gate:** Review `fleet-handover-spike-results.md`. All four product promises have a proven path,
or the spec and remaining tasks have been narrowed. Delete no fixture merely because a later agent
version changes; add a versioned adapter fixture instead.

---

# Phase B — identity, schemas and ownership fencing

