### Task 17: Add remote routing to the Mac app

**Depends on:** Tasks 14–16

**Files:**

- Create: Swift `ControllerProcess.swift`, `MachineRegistry.swift`, `SSHManager.swift`,
  `RemoteConnection.swift`
- Modify: `ArchiHome.swift`, `Bridge.swift`, `AppDelegate.swift`, `Package.swift`
- Add Swift tests for parsing/process lifecycle

**Steps:**

- [ ] Resolve current owner through the bundled helper/gateway on launch; fall back to a cached route
  only under the spec's generation rule.
- [ ] Replace synchronous `ArchiHome.connection()` with an asynchronous connection manager that can
  emit connecting/online/error/owner-changed states to the page.
- [ ] Own the viewer SSH master and API forward for the window lifetime; never expose remote tokens in
  logs or persistent preferences.
- [ ] Extend `WebAttach`/SurfaceManager route context so remote terminal commands use `ssh -S … -tt`
  while local ones remain unchanged.
- [ ] Rebuild visible surfaces after SSH reconnection and close old surfaces during owner change.
- [ ] Disable Finder reveal/open-folder for remote paths and return an explanatory bridge result.

**Verify:** `swift test --package-path apps/desktop/mac`, existing desktop smoke, manual SSH drop.

**Commit:** `The Mac window follows a fleet to its remote owner`

