# Task 17b report: remote routing in the Mac app

Branch `fleet-handover-task17`, worktree
`/Users/linusroxbergh/linus_laboratory/archipelago/.claude/worktrees/fleet-handover-task17`.
One commit: `4f80d50 The Mac window follows a fleet to its remote owner`. Tree clean.

## What I implemented

`Sources/Archipelago/ControllerProcess.swift` (new)

- `RemoteRoute { name, destination, controlSocket }` and `ControllerEvent` with
  `.connecting(owner:)`, `.online(connection:remote:)`, `.error(kind:message:)`,
  `.ownerChanged(owner:)`. `ControllerEvent.decode(_ line:)` returns nil for an unknown `type`,
  unparsable JSON, and a line missing a field the event needs.
- `ControllerProcess` spawns the helper with `executableURL` + `arguments` (no shell), reads stdout
  through the pipe's `readabilityHandler`, splits on `\n`, decodes, and delivers each event on the
  main queue. An unreadable line is ignored; the first one logs a single line that does not include
  the line itself (it may carry the token).
- `locate(environment:resourcePath:)`: `ARCHI_HELPER` first, then
  `<resourcePath>/release/bin/archi`, each only if it is an executable file; nil if neither is.
- `connectArguments(profile:)` → `["connect","--json"]`, plus `["-p", name]` when the app runs a
  profile.
- `stop()` closes the child's stdin, waits up to 1 s for it to go (the helper closes its master and
  forward on EOF), then terminates. `onExit` reports a child that dies on its own; it is suppressed
  after `stop()`.

`Sources/Archipelago/RemoteConnection.swift` (new)

- `ConnectionRoute { local, remote(RemoteRoute) }` and the connection manager holding
  `connection`, `route` and the last `State { state, owner, kind, message }`.
- Events map to: `connecting` → state; `online` → route/connection updated, `onConnection`, state,
  then `onSurfaces(.rebuild)` if it had been online for this owner before; `error` → state with the
  helper's kind and message; `owner-changed` → route back to local, connection dropped,
  `onSurfaces(.closeAll)` **before** the state is published, so surfaces are gone before the new
  owner comes online.
- No helper on disk, or a helper that will not spawn → `fallBack()`, which reads
  `ArchiHome.connection()` and sends only `.connection`, exactly as the app behaved before.

`Bridge.swift`: `FromShell.connectionState(state:owner:kind:message:)` → `{"type":"connection.state",
"state","owner"[,"kind"][,"message"]}` and `FromShell.notice(text:)` → `{"type":"notice","text"}`.
`kind`/`message` are omitted when nil.

`SurfaceManager.swift`: `AttachCommand.build(route:attach:tmux:)` builds
`'<tmux>' -S '<socket>' attach -t '<session>'` locally and
`ssh -S '<controlSocket>' -tt -- '<destination>' tmux -S '<socket>' attach -t '<session>'` remotely,
every data word through the existing single-quote escaping (now `AttachCommand.quote`, moved out of
the file-private `sh`). `SurfaceManager.route` is a closure onto the connection manager, read when a
surface is built, and `rebuild()` re-attaches every tracked surface (hidden ones stay hidden) from
the rect/attach/opacity it now remembers per id.

`ArchiHome.swift`: `ArchiConnection` is `Equatable`; `profileName(of:in:)` mirrors the CLI's
`profileOf` (nil for `~/.archipelago` and for an ad-hoc `$ARCHI_HOME`, which the child inherits
through the environment instead), with `ArchiHome.profile` as the live reading.

`AppDelegate.swift`: builds the helper and the manager after `ArchiHome.claim()`, wires
connection/state/surfaces, hands `SurfaceManager` the route, starts it; the page's `connection`
request answers with the manager's connection plus the last state; `openFolder`/`reveal` while the
route is remote send `"<path> is on <machine>; open it there"` and do nothing else;
`applicationWillTerminate` stops the helper before releasing the home. Sends are held until the page
has asked for its connection (`pageReady`), so no token is evaluated into a webview with no page,
and the flag resets on navigation.

`Package.swift`: `.testTarget(name: "ArchipelagoTests", dependencies: ["Archipelago"], path:
"Tests/ArchipelagoTests")`. The executable target with top-level code in `main.swift` is
`@testable import`-able as is — **no change to `main.swift` was needed**.

### Left out on purpose

`SSHManager.swift` and `MachineRegistry.swift` were not created. Under this contract the helper owns
the SSH master and the API forward for its own lifetime and reports `name`/`destination`/
`controlSocket`, so the app has no SSH to manage and no registry to read; the app owns the master
only in the sense that it owns the helper child for the window's lifetime (Task 17 step 3), which
`ControllerProcess` does. Empty files to match the file list would have been dead weight.

## Tests and results

`Tests/ArchipelagoTests` — 22 tests, all passing.

- `ControllerEventTests` (6): every event type, the local and remote shapes of `online`, and the
  ignored cases (unknown type, non-JSON, empty line, `online` without a port, `connecting` without
  an owner, `error` without a message).
- `AttachCommandTests` (3): the local command text, the remote command text, and quoting of a
  session name containing a single quote.
- `ControllerProcessTests` (6): events arrive in order on the main thread from a fake helper script
  and the child stays up until `stop()` closes its stdin; a child that exits on its own is reported;
  malformed lines do not stop the stream; a missing executable throws rather than crashes; helper
  location prefers `ARCHI_HELPER` over the bundle and returns nil when neither exists; the profile
  argument and `ArchiHome.profileName`.
- `RemoteConnectionTests` (7): fallback with no helper, fallback when the helper cannot start, a
  remote owner becoming the route, the owner-change ordering (surfaces closed before the new owner's
  state), a rebuild on coming back online for the same owner, a dying helper surfacing as
  `error`/`other`, and `stop()` ending the child.

The fake helper (`FakeHelper.swift`) is a `/bin/sh` script that prints the given NDJSON lines and
then `exec cat > /dev/null`, so it exits 0 on stdin EOF like the real one.

## TDD evidence

RED — tests written first, `swift test --package-path apps/desktop/mac`:

```
Tests/ArchipelagoTests/ControllerEventTests.swift:6:24: error: cannot find 'ControllerEvent' in scope
Tests/ArchipelagoTests/ControllerEventTests.swift:20:40: error: cannot find 'RemoteRoute' in scope
Tests/ArchipelagoTests/ControllerEventTests.swift:25:55: error: type 'Equatable' has no member 'error'
...
error: Build failed
```

Expected: the event type, the route type, the process, the manager and `AttachCommand` did not exist
yet, so the suite could not compile.

GREEN — `swift build --package-path apps/desktop/mac` → `Build complete!` with no warnings, and
`swift test --package-path apps/desktop/mac`:

```
Executed 22 tests, with 0 failures (0 unexpected) in 1.575 (1.581) seconds
```

Mutation check (the tests are load-bearing), after changing `-tt` to `-t` and deleting
`if wasOnline { onSurfaces(.rebuild) }`:

```
AttachCommandTests.swift:15: error: XCTAssertEqual failed: ("ssh -S '…' -t -- …") is not equal to ("ssh -S '…' -tt -- …")
RemoteConnectionTests.swift:94: error: XCTAssertEqual failed: (… "state online studio - -") is not equal to (… "surfaces rebuild")
Executed 22 tests, with 3 failures
```

Both mutations were reverted before the commit.

## Files changed

- Added `apps/desktop/mac/Sources/Archipelago/ControllerProcess.swift`
- Added `apps/desktop/mac/Sources/Archipelago/RemoteConnection.swift`
- Added `apps/desktop/mac/Tests/ArchipelagoTests/{ControllerEventTests,AttachCommandTests,ControllerProcessTests,RemoteConnectionTests,FakeHelper}.swift`
- Modified `apps/desktop/mac/Sources/Archipelago/{AppDelegate,ArchiHome,Bridge,SurfaceManager}.swift`
- Modified `apps/desktop/mac/Package.swift`

Nothing outside `apps/desktop/mac/**` was touched.

## Self-review findings

- `rebuild()` iterates a snapshot of `attached` while `close`/`show` mutate it — safe with a value
  type, and checked by hand.
- `close(id:)` clears the remembered attach before removing the view, so the `exited` closure's
  identity guard still suppresses the page notification for a surface we destroy ourselves.
- Early sends: the first draft pushed `connection`/`connection.state` at a webview with no page
  loaded, which both logged an `evaluateJavaScript` error and put the token into a nascent page. The
  `pageReady` gate closed that; the page gets the current connection and the last state when it asks.
- Token handling: the token exists in `ArchiConnection` in memory and in the bridge message only. No
  log statement prints an event, a line, or a connection, and nothing is written to disk or
  `UserDefaults`.
- `stop()` busy-waits up to 1 s on the main thread at quit. That is the "waits briefly" the contract
  asks for, but it is a main-thread wait; it only runs on termination.

## Concerns

- The wire names `connection.state` and `notice` are my choice — the contract names the Swift cases
  but no JSON `type`. They follow the existing dotted convention. Task 18 must match them, or say
  otherwise and I will rename.
- Between a start and the first `online`, `remote.connection` is nil, so a page asking for its
  connection gets the same empty payload the app already sends when no daemon is up. Task 18's
  `connection.state` is what tells the page to wait.
- Surfaces rebuilt after a reconnect lose keyboard focus; the page refocuses on its next
  `term.focus`. Not covered by a test (it needs a live Ghostty surface).
- Not exercised against the real helper — 17a's binary does not exist on this branch. Everything
  here is built against the contract and a fake helper; the by-hand SSH-drop pass is still owed.

## Fix round 1

Review finding: `owner-changed` set the route to `.local`, so a `term.show` in the gap before the
next `online` built a local `tmux attach` for a session on another machine, that surface was never
repaired (the reset of `wasOnline` skipped the rebuild), and a Finder reveal in the same gap opened
a remote path on this Mac. Commit `e98c9cb A fleet with no known owner attaches nothing until the
helper says where it is`.

### What changed

- `ConnectionRoute` gains `.pending`: the route while the helper is opening one. `start()` enters it
  as soon as a helper exists, and `owner-changed` returns to it. Only `fallBack()` (no helper) and
  an `online` without a `remote` block give `.local`.
- `AttachCommand.build` returns `String?` and is nil for `.pending`, so nothing can be attached
  before the helper reports `online`.
- `SurfaceManager.show` remembers a `term.show` that arrives while the route is pending — rect,
  attach, opacity — and builds no surface. The remembered entry is what `rebuild()` attaches once
  the route is known, so a terminal asked for in the gap comes up on the right machine rather than
  being lost.
- The rebuild is no longer skipped after an owner change: `wasOnline` became `rebuildWhenOnline`,
  which `owner-changed` leaves set, so the first `online` for the new owner rebuilds.
- `SurfaceManager` now tracks the hidden state per remembered surface (`hide` marks it even with no
  view yet), `move` updates the remembered rect with no view, and `closeAll` clears remembered
  entries as well as live views, so a page reload cannot leave a pending surface to be built later.
- `RemoteConnection.notice(forOpening:)` owns the Finder decision: nil when local,
  `"<path> is on <machine>; open it there"` when remote, and
  `"<path> cannot be opened while the fleet is connecting"` while pending.
  `AppDelegate.isHere` just relays it.

### Tests

Four new tests (26 total, all passing):

- `AttachCommandTests.testNoCommandIsBuiltWhileTheRouteIsUnknown` — no attach command exists for
  `.pending`, which is what makes `show` refuse to build.
- `RemoteConnectionTests.testTheRouteStaysUnknownUntilTheHelperReportsOnline` — `.pending` from
  `start()` through the first `connecting`.
- `RemoteConnectionTests.testAnOwnerChangeLeavesTheRouteUnknownUntilTheNewOwnerIsOnline` —
  `.pending` and no connection in the gap.
- `RemoteConnectionTests.testOnlyALocalFleetsPathsAreFindersToOpen` — the pending notice, the remote
  notice, and nil for a local-only fleet.
- `RemoteConnectionTests.testAnOwnerChangeClosesTheSurfacesBeforeTheNewOwnerComesOnline` now also
  requires `surfaces rebuild` after the new owner comes online.

RED first: `swift test --package-path apps/desktop/mac` →
`Tests/ArchipelagoTests/AttachCommandTests.swift:19:50: error: type 'ConnectionRoute' has no member
'pending'` … `error: Build failed`, as expected — the case and `notice(forOpening:)` did not exist.

GREEN: `swift build --package-path apps/desktop/mac` → `Build complete!` (no warnings) and
`swift test --package-path apps/desktop/mac` → `Executed 26 tests, with 0 failures (0 unexpected)`.

Mutation check: putting `route = .local` and `rebuildWhenOnline = false` back into `owner-changed`
fails `testAnOwnerChangeLeavesTheRouteUnknownUntilTheNewOwnerIsOnline` and
`testAnOwnerChangeClosesTheSurfacesBeforeTheNewOwnerComesOnline` (3 failures); reverted, 26 green.

### Concern

`SurfaceManager` still cannot be instantiated in tests — it needs a live `GhosttyRuntime`, which
needs `ghostty_init` from `main.swift`. The gap behaviour is therefore covered at its decision point
(`AttachCommand.build` returning nil, the rebuild transcript) rather than by driving `show` itself.
