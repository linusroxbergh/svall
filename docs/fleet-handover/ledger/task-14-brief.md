### Task 14: Implement SSH control-master transport

**Depends on:** Tasks 6, 12

**Files:**

- Create: `packages/cli/src/controller/process.ts`, `ssh.ts`, `connection.ts`
- Create: `packages/cli/test/controller/ssh.test.ts`, `connection.test.ts`
- Modify: `packages/cli/src/client.ts`

**Interfaces:** `SshMaster.open/close/run/forward/cancelForward`, `remoteConnectionInfo`,
`Client.connectEndpoint`; hashed short control sockets under a mode-0700 temp dir.

**Steps:**

- [ ] Build an argv-only process runner with bounded stdout/stderr, timeout, cancellation and redacted
  diagnostics.
- [ ] Open/check/exit a ControlMaster, handling concurrent open races and stale socket cleanup.
- [ ] Execute the companion's connection-info command over SSH and validate fleet/machine/release ids
  before reading its token response.
- [ ] Forward remote loopback API to a kernel-selected local port and connect the existing Client to
  that explicit endpoint without caching the token to disk.
- [ ] Route ordinary CLI commands through the gateway's current-owner record when a fleet has a
  gateway, retain `--host <name|local>` as an explicit diagnostic override, and keep ungated local
  fleets on the existing direct path.
- [ ] Reconnect master and forward after loss with bounded backoff; distinguish auth, host-key,
  version and daemon-down errors.
- [ ] Test malicious names/paths as data, never command text, using a fake ssh executable that logs
  argv.

**Verify:** `pnpm vitest run --project cli test/controller/ssh.test.ts test/controller/connection.test.ts`

**Commit:** `The controller reaches a remote daemon through one SSH master`

