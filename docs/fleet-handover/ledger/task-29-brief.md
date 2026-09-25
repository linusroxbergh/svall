### Task 29: Add the handover sheet and automatic owner reconnect

**Depends on:** Tasks 18, 28

**Files:**

- Create: `apps/desktop/web/src/HandoverSheet.tsx`, `handover.ts`
- Modify: `Corner.tsx`, `store.ts`, `bridge.ts`, `selectors.ts`, `styles.css`
- Modify: Swift `ControllerProcess.swift`, `AppDelegate.swift`, remote connection manager
- Test: web unit tests and `apps/desktop/web/e2e/handover.spec.ts`

**Steps:**

- [ ] Add bridge commands to start/observe/cancel a detached helper transaction and to reconstruct
  it from journaled NDJSON after app relaunch.
- [ ] Render the five sections—checks, resting, transfer, verify/commit, resume—with stable entity
  rows and byte progress.
- [ ] Before Commit show Abort; after Commit show destination Retry and never rollback language.
- [ ] Present explicit interrupt/terminate/archive decisions and explain their consequences.
- [ ] Close terminal surfaces at source freeze, retain selected character/card/panes locally, then
  resolve owner and reconnect after activation.
- [ ] Show per-character dormant resume errors without hiding a successful fleet move.
- [ ] Prevent accidental dismissal during an active decision; quitting the app detaches but does not
  signal abort.

**Verify:** web unit tests, Playwright handover fixture, manual real SSH handover in both directions.

**Commit:** `The handover sheet carries the fleet through every durable phase`

**M3 gate:** With real tmux/Git/SSH and mocked agents, hand twelve characters and at least three Git
graphs—including nested and sibling worktrees—in both directions. Inject a disconnect/process kill
at every phase. Before Commit only the source may revive; after Commit only the destination may
activate. Compare source/destination file manifests, Git indexes/status/stashes and state snapshots.
Then repeat with one supported real Claude session and one supported real Codex session.

---

# Phase E — stable phone gateway

