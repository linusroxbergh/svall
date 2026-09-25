# Task 17 contract: the `archi connect --json` helper and the Mac app

Task 17 is split in two dispatches on disjoint files. Both build against this contract; neither
may change it without the controller. 17a is `packages/cli` (branch fleet-handover-task17a);
17b is `apps/desktop/mac` (branch fleet-handover-task17). Neither touches the other's tree.

## The helper (17a builds it, 17b spawns it)

Command: `archi connect --json [-p <profile>]` (new `packages/cli/src/commands/connect.ts`,
registered in `main.ts`). Same profile/home resolution as every other `archi` command.
Stdout is NDJSON, one object per line, `type` discriminated:

- `{"type":"connecting","owner":"local"}` or `{"type":"connecting","owner":"<machine name>"}`
- `{"type":"online","host":"127.0.0.1","port":<n>,"token":"<t>"}` for a local owner;
  for a remote owner the same plus `"remote":{"name":"<machine name>","destination":"<ssh dest>",
  "controlSocket":"<path of the SshMaster control socket>"}`. `port` is the local forward port.
- `{"type":"error","kind":"unreachable"|"auth"|"daemon_down"|"mismatch"|"other","message":"<text>"}`
  `kind` values are the existing `SshErrorKind`s plus `daemon_down` (local daemon not up).
  After an `error` for a remote owner the helper keeps retrying with the existing `withReconnect`
  backoff and emits `connecting` again before each attempt. For a local owner an `error` is
  followed by exit code 1.
- `{"type":"owner-changed","owner":"<name or local>"}` when a re-resolution finds a different
  owner than the one currently online: the helper closes the old master/forward, emits this, then
  `connecting` → `online` for the new owner.

Lifecycle: the helper holds its master and forward until its stdin reaches EOF, then closes both
and exits 0. It re-resolves the owner on every reconnect attempt and every 30 s while online.
The token appears only on stdout; never in logs, never on disk, never in argv.

Owner resolution (`resolveOwner(fleetHome)` in `controller/connection.ts`, replacing the stub):
1. fleet.json without `gatewayMachineId` → local.
2. Otherwise the gateway is the registry machine with that id; over its SSH master run
   `archi gateway owner get --fleet <fleetId>` (Task 16b). The record's `ownerMachineId`:
   equal to this Mac's machine id → local; otherwise the registry machine with that id → that
   machine (a gateway record naming an unregistered machine is `error` kind `other`).
   `not_found` → local. `authority_corrupt` → `error` kind `other` with the message.
3. Gateway unreachable → the cached route (below) may be used only when that route's daemon
   reports the same generation; otherwise `error` kind `unreachable`.

Cached route: `<fleetHome>/controller/route.json` (0600, atomic write) =
`{ "ownerMachineId": "<id>", "generation": <n>, "at": "<iso>" }`, written whenever the gateway
answered. To check it, `archi connection-info --json` gains an optional `generation` field (the
daemon's cached owner record generation; absent when the daemon runs standalone) — for the local
route the controller reads the same cache file the daemon writes.

## The Mac app (17b)

- `ControllerProcess.swift` spawns the helper with executable + argv (`Process`, no shell), reads
  stdout line by line, decodes the events above, and owns the child for the window's lifetime:
  closing the window or quitting closes the child's stdin and waits briefly; a child exit while
  the window is open is an `error` kind `other` to the page.
- Helper location: `ARCHI_HELPER` env var if set (dev), else
  `Bundle.main.resourcePath + "/release/bin/archi"`. If neither exists, keep today's behavior
  (`ArchiHome.connection()` reading the port/token files) so a dev build without a bundled release
  still works — the local-only experience must keep working throughout.
- `Bridge.swift`: `FromShell.connection` carries the same fields as today; add
  `FromShell.connectionState(state: "connecting"|"online"|"error"|"owner-changed", owner: String,
  kind: String?, message: String?)` and `FromShell.notice(text: String)`. The web side of
  `connectionState`/`notice` is Task 18's; 17b only sends them.
- `SurfaceManager`: when the current connection is remote, the attach command is
  `ssh -S <controlSocket> -tt -- <destination> tmux -S <socket> attach -t <session>` with every
  word passed through the existing `sh()` quoting; local attach is unchanged. After the helper
  emits a new `online` for the same owner (reconnect), visible surfaces are rebuilt; on
  `owner-changed`, old surfaces are closed first.
- Finder reveal / open-folder for a path while the connection is remote sends
  `FromShell.notice(text: "…is on <machine name>; open it there")` and does nothing else.
- `Package.swift` gains `.testTarget(name: "ArchipelagoTests", dependencies: ["Archipelago"],
  path: "Tests/ArchipelagoTests")`; tests cover NDJSON event decoding (every type above, unknown
  type ignored, malformed line ignored), the attach command for local vs remote, and the helper
  lifecycle (a fake helper script that prints events and exits on stdin EOF).
  `swift test --package-path apps/desktop/mac` is the verify command.

## Wire names (fixed after 17b landed)
The bridge JSON `type` for `FromShell.connectionState` is `connection.state` and for `FromShell.notice` is `notice`; Task 18 matches these.

## error.kind (fixed after 17a landed)
`kind` is the SshErrorKind emitted verbatim (`unreachable`, `auth`, `host_key`, `version`, `other`, …) plus `daemon_down`; there is no `mismatch` kind. Consumers treat `kind` as an open string.

## Retry policy (fixed after the 17a review)
Only `unreachable` and `daemon_down` are retried with backoff. Any other kind (`auth`, `host_key`, `version`, `other`, a missing registry destination, an unparseable fleet.json) is emitted once as `error` and the helper then idles — no retries, no re-resolution tick — until stdin EOF (exit 0). The Mac shows the error; the user fixes the cause and reopens the window. A dead master while online is detected by `SshMaster.check()` on each 30 s tick and handled as a reconnect (close, `connecting`, retry).
