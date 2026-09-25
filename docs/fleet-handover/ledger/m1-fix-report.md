# M1 fix wave — deep-review findings

One commit on `fleet-handover-impl`. Every behaviour change was driven by a failing test first; the
RED run below covers all of them, and the GREEN run is the full three-project suite.

## RED (before the fixes)

`pnpm vitest run --project archid --project cli test/machine.test.ts test/ownership.test.ts test/handover/service.test.ts test/doctor.test.ts test/target.test.ts`

```
Test Files  4 failed | 1 passed (5)
     Tests  9 failed | 54 passed (63)
```

- `machine.test.ts > returns the id that reached disk first when two calls race` — `TypeError: mintMachineId is not a function`
- `machine.test.ts > never invents a second id over a file it cannot read` — message lacked the remedy
- `ownership.test.ts > takes a standalone fleet back from a machine no gateway can name …` — `expected false to be true`
- `ownership.test.ts > drops the marks of a handover it takes a standalone fleet back from` — `expected false to be true`
- `ownership.test.ts > names no command that does not exist when the record cannot be read` — message still named `archi fleet recover`
- `ownership.test.ts > an inactive replica > answers reads and refuses every write …` — the tmux socket existed
- `service.test.ts > holds a standalone fleet read-only for this start only …` — the daemon surrendered durably
- `service.test.ts > refuses an abort from a machine the record does not name …` — `expected 'not_ready' to be 'not_owner'`
- `doctor.test.ts > reports a healthy fleet …` — `expected undefined to deeply equal { …(2) }` (no `config` in the report)

## GREEN

- `pnpm vitest run --project archid --project cli --project @archipelago/desktop-web` → `Test Files 96 passed (96) · Tests 1063 passed (1063)`
- `pnpm typecheck` → clean
- `swift build --package-path apps/desktop/mac` → `Build complete! (2,47 secs)`

## Per item

1. **machine id race** — `packages/archid/src/machine.ts`. `mintMachineId(dir)` creates `machine.json`
   with `flag: 'wx'`, mode 0600, under a 0700 directory, and on `EEXIST` re-reads the file and returns
   the id that persisted; nothing is ever renamed over an existing file. `machineId()` is now
   read-if-present, else mint. Covered by `machine.test.ts > returns the id that reached disk first
   when two calls race`, which pre-writes the file and calls `mintMachineId` — the seam that stands
   for the window between the existence check and the write. Mode and format are unchanged
   (`test/machine.test.ts > keeps the file and its directory to the owner`).

2. **Swift seeds a rejected fleet.json** — `ArchiHome.configPath()` returns the path only when
   `fleet.json` exists, and never creates it. `AppDelegate.swift:122` now logs which config it could
   not open; there is no toast or alert path for bridge errors in the app (the only user-facing error
   channel is `ghosttyConfigErrors`, which is specific to Ghostty's parser), so it logs only.
   `swift build --package-path apps/desktop/mac` → `Build complete!`.

3. **standalone fleet with a foreign owner record** — `ownership/state.ts` `load()`. A well-formed
   record naming another machine is rewritten as `{ fleetId, generation: 0, ownerMachineId: machineId }`
   when `standalone`, dropping frozen/surrendered/transaction, and the old id is logged. A gatewayed
   fleet is untouched. Covered by `ownership.test.ts > takes a standalone fleet back from a machine
   no gateway can name, and leaves a gatewayed one alone` and `> drops the marks of a handover it
   takes a standalone fleet back from`.

4. **message names a nonexistent command** — the gatewayed branch now reads "This fleet is read-only
   until its ownership record is repaired." Covered by `ownership.test.ts > names no command that
   does not exist when the record cannot be read`, which also asserts `archi fleet recover` is gone.

5. **quarantined journal surrenders forever** — `handover/startup.ts`. `StartupDeps` carries
   `standalone`, threaded from `main.ts` as `!config.gatewayMachineId`. Standalone: `ownership.hold(
   'handover journal unreadable; moved to …')`, so this process is read-only and nothing durable is
   written. Gatewayed: the durable `surrender()` stands. Covered by `service.test.ts > holds a
   standalone fleet read-only for this start only when its journal is unreadable` (restart is
   `owner`/writable, the broken file still aside) and `> keeps a gatewayed fleet read-only across
   restarts when its journal is unreadable`.

6. **abort authorisation with no journal** — `handover/service.ts` `authorize`: `source-abort` now
   requires `ownership.record().ownerMachineId === ownership.machineId` whether or not a journal is
   open; no `isFrozen` gate was added. Covered by `service.test.ts > refuses an abort from a machine
   the record does not name, with or without a journal`.

7. **machineId() throw has no remedy** — the message ends "…; delete the file to mint a new machine
   id, or restore it from backup". Asserted in `machine.test.ts > never invents a second id over a
   file it cannot read`.

8. **HandoverService dead deps** — `HandoverDeps` is `{ ownership, journal }`; `Planner`, `Sessions`,
   `Authority` and `clock` are deleted. Verified by grep that `this.deps.` reads only those two.
   Callers updated: `main.ts`, `test/api.test.ts`, `test/mobile.test.ts`, `test/handover/service.test.ts`.

9. **CLI dead surface** — `localMachineId()` and `Target.machineId` deleted from `packages/cli/src/target.ts`,
   with the test that only asserted an object spread. Grep confirms no other importer.

10. **node.json diagnostics** — `doctor()` returns `config: { fleet, node }` from the fleet home, and
    the human output (now `reportLines()`, shared with `--json`'s sibling path) prints
    `config <fleet.json> and <node.json>` under `fleet <home>`. The Settings button title is now
    "Mission control, the fleet's defaults, its scribe, phone logins and handover" — no port.
    Covered by `doctor.test.ts > reports a healthy fleet and the last 20 log lines` (report and
    `reportLines`) and, for the button, an added title assertion in `apps/desktop/web/e2e/settings.spec.ts`.

11. **replica starts a tmux server** — `fleet.ts` `start()` no longer calls `ensureServer()`; it moved
    into `begin()`, so only an activating fleet starts a server. `main.ts` runs `tmux.sourceConf()`
    only when the fleet is writable. `tmux.version()` in `startDaemon` runs `tmux -V` and needs no
    server; `TerminalHub`/`terminals.ts` touches tmux only from terminal methods, which the fence
    refuses on a replica. Tests now assert the socket file is absent and `tmux … list-windows`
    rejects: `ownership.test.ts > an inactive replica …` and both cases in `daemon.test.ts > a daemon
    that may not write its fleet`.

## Notes

- `daemon.test.ts`'s two "may not write its fleet" cases and the `ownership.test.ts` replica case
  were updated for item 11 as well — they asserted an empty window list, which now means a socket
  that does not exist.
- `ownership.test.ts`'s replica daemon case now writes `gatewayMachineId` into its config: without a
  gateway, item 3 makes that daemon the owner, which is the intended new behaviour.
- `machine.json` is no longer written through `writeJsonAtomic`. An exclusive create is what rules
  out replacing another process's file, and the file's whole content is the id, so there is no
  partial-write window to protect; the on-disk format is unchanged.
