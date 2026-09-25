# Task 18 report: host setup and remote-state UI

Commit: `22295e3 A published app can add and inspect its Linux machine` (branch `fleet-handover-impl`,
on top of dbf0062). Tree clean.

## What was implemented

**Bridge messages (web + Swift).** `ToShell` gains `host.start { op, args }` and `host.cancel`;
`FromShell` gains `host.step { op, event }` and `host.done { op, code }`, and the web side of Task
17b's `connection.state` and `notice`. The Swift `ToShell` decodes `host.start` into a typed
`HostOp` + `HostArgs`, so an unknown op or a missing name is a decode failure, not argv.

**Host operations are the shell's own argv.** `HostCommand.arguments(op:args:)` builds
`["host", <op>, <name>, …flags, "--json"]` and returns nil unless the name matches the registry's
`^[a-z][a-z0-9-]{0,31}$`, the ssh destination matches `MachineRecord.ssh`'s pattern, the fleet
profile matches `^[a-z][a-z0-9-]*$`, and every flag belongs to that operation (`--ssh` only on add,
`--fleet` only on enable, `--forget` only on remove). `HostProcess` spawns the located helper
(`ARCHI_HELPER`, else the bundled `release/bin/archi`) with executable + argv, streams each NDJSON
line it can decode as a `StepEvent` to the page, drains what is still in the pipe when the child
exits, and ends with `host.done`. `host.cancel` terminates the child; so does quitting the app. One
run at a time. `--json` sits last in the argv; commander 12 accepts the program-level flag there
(checked against the repo's own commander before relying on it).

**Actionable stderr without tokens.** A run that exits non-zero with no failing step reports the last
line the command wrote to stderr as a synthetic `archi` step, so a failure that never reached the
NDJSON still says something. On the page, `withoutTokens()` masks any `token=`/`"token":`/`--token`
value before a step, an action, or a connection message is put in the store, so no token is held or
rendered even if one reached the page.

**The attended checklist (`HostSetup.tsx`, `host.ts`).** The CLI's steps are grouped into the
phases the brief names — Connect, Prerequisites, Companion, Service, Agent logins, Final probe — in
arrival order, so a phase heading opens again if a later step returns to it, and an unknown step is
shown under "Setup" rather than dropped. Each row carries its status mark, the detail, and, when the
step left something to do, the action. The panel ends with "ready for handover" or the list of
what is still to do. Add / Check / Upgrade / Hand this fleet over / Remove / Forget are the controls;
Stop cancels a run in flight.

**Forgetting is asked about.** `Forget` opens a confirmation naming the machine and saying what it
does and does not do; only the confirm button sends `host.start remove --forget`.

**Owner and remote state.** The corner shows a badge with the owner machine's name whenever the
owner is not local, coloured by the connection state; the Mac window title becomes
`<fleet> — <machine>` through `RemoteConnection.windowTitle`. A banner in `App.tsx` renders
connecting / reconnect / unreachable / version-mismatch from `connection.state` alone; the store's
`setConnectionState` touches nothing else, so the loaded fleet, its characters and its terminals
stay on the screen. `notice` becomes a toast.

**The gate.** Every control above waits on fleet.json's `handover.enabled`.

### Deviation from the ruling on how `handover.enabled` reaches the page

The ruling said to add the field to `FleetConfig.handover` and read it "through the fleet config the
page already receives". Two things differ from that premise, and I settled it rather than stopping:

1. `handover.enabled` already exists in `packages/protocol/src/handover.ts` (since f32264c), so no
   schema field was needed — `handover.ts` is untouched.
2. The page receives no fleet config today. `state.get` returns `FleetState`, which carries only the
   config fields archid copies into it (`home`, `defaultCwd`); `mobile.get` returns a derived
   `MobileStatus`; the page never calls `system.info` or `ownership.get`. Carrying the flag over the
   daemon API would mean editing `packages/archid` (out of scope) and the CLI is off limits.

So the flag rides the channel the page already has for facts only the shell can see: `shell.info`
gains `handoverEnabled`, which `ArchiHome.handoverEnabled()` reads out of the fleet home's
fleet.json — the same file the shell already opens for "Fleet config". No new channel, no archid or
cli change, and the controls are absent in a plain browser, which is right: host operations need the
bundled helper the shell owns.

## TDD evidence

**RED — web unit (`test/host.test.ts`, `test/store.test.ts`)**

    $ pnpm vitest run --project @archipelago/desktop-web
     ❯ |@archipelago/desktop-web| test/host.test.ts (0 test)
     ❯ |@archipelago/desktop-web| test/store.test.ts (45 tests | 3 failed)
       × the machine that owns the fleet > keeps the loaded fleet while the shell reports the connection going and coming back
         → store.getState(...).setConnectionState is not a function
       × the machine that owns the fleet > follows one host operation from its first step to its exit code
         → store.getState(...).hostStarted is not a function
       × the machine that owns the fleet > asks before it forgets a machine it cannot reach, and only then
         → store.getState(...).askForget is not a function

Expected: `src/host.ts` did not exist (so the suite collected no tests from it) and the store had no
connection or host slice.

**GREEN**

    $ pnpm vitest run --project @archipelago/desktop-web
     Test Files  30 passed (30)
          Tests  335 passed (335)

**RED — Swift (`Tests/ArchipelagoTests/HostProcessTests.swift`)**

    $ swift test --package-path apps/desktop/mac
    HostProcessTests.swift:9:29: error: cannot find type 'HostOp' in scope
    HostProcessTests.swift:9:45: error: cannot find type 'HostArgs' in scope
    error: Build failed

Expected: the argv validation, the host child and the window title did not exist yet.

**GREEN**

    $ swift test --package-path apps/desktop/mac
    Test Suite 'All tests' passed … Executed 35 tests, with 0 failures (0 unexpected)

**e2e (`e2e/host.spec.ts`) — mutation instead of RED.** The spec was written after the page, so its
first run passed; to show it is load-bearing I mutated the implementation (dropped the
`handoverEnabled` gate in `SettingsCard`, and made Forget start the run without asking) and re-ran:

    ✘ 1 the machines panel waits for the fleet to ask for handover, then reports every step
        Error: expect(locator).toHaveCount(expected) failed  Expected: 0  Received: 1
    ✘ 2 a machine is only forgotten once the page has asked
        Error: expect(locator).toBeVisible() failed  element(s) not found
    ✓ 3 the corner names the machine the fleet runs on …
    2 failed, 1 passed

Both mutations were reverted; the spec then passed again.

## Verification (each once, before the commit)

- `pnpm vitest run --project @archipelago/desktop-web` — 30 files, 335 tests, all passed.
- `pnpm --filter @archipelago/desktop-web exec playwright test e2e/host.spec.ts` — 3 passed.
- `swift test --package-path apps/desktop/mac` — 35 tests, 0 failures.
- `pnpm typecheck` — clean.

Nothing was run against `~/.archipelago`, and no host command was run for real: the Swift tests use
the existing fake-helper script pattern, and the e2e uses the test daemon fixture with a stand-in
shell that plays canned `archi host add --json` output back to the page.

## Files changed

New: `apps/desktop/web/src/host.ts`, `apps/desktop/web/src/HostSetup.tsx`,
`apps/desktop/web/test/host.test.ts`, `apps/desktop/web/e2e/host.spec.ts`,
`apps/desktop/mac/Tests/ArchipelagoTests/HostProcessTests.swift`.

Modified: `apps/desktop/web/src/{bridge,store,boot}.ts`,
`apps/desktop/web/src/{App,Corner,SettingsCard}.tsx`, `apps/desktop/web/src/styles.css`,
`apps/desktop/web/test/{bridge,store}.test.ts`,
`apps/desktop/mac/Sources/Archipelago/{Bridge,ControllerProcess,RemoteConnection,AppDelegate,ArchiHome}.swift`.

`packages/protocol` and `packages/cli` are untouched.

## Self-review findings (fixed before the commit)

- `HostProcess` read `stderrTail`, the line buffer and the "a step failed" flag from three threads
  (each pipe's queue and main). One `NSLock` now holds all three.
- A step could be read from stdout after the child's termination handler had already fired, so the
  last lines of a run could arrive after `host.done`. `finish` now drains the remaining stdout on
  main and emits those steps before the done message.
- The checklist's React keys were the step name alone, which would collide if one operation emitted
  the same step twice; the key now carries the row's index.
- `setConnectionState` stored the shell's message as it came; it now masks tokens on the way in, as
  the host steps already did.
- `startHost` called `ControllerProcess.locate()` twice (a second filesystem probe only to word the
  failure); it now locates once.

## Concerns

- **The `handover.enabled` channel** is the deviation above. If the controller wants the flag to come
  from the daemon instead (a field on `SystemInfo` in handover.ts plus a `system.info` call from the
  page), that needs an archid change, which was out of my scope.
- **No machine list.** The page has no listing of registered machines, because `host list` is not one
  of the five allowed ops and it prints a result rather than step events: every action works on the
  name typed into the panel. A later task could add the listing once a streamed or API-side source
  exists.
- **`ArchiHome.handoverEnabled()` is read once**, when the page asks for its connection. Editing
  fleet.json while the app is open does not move the gate until the page reloads.
- **The Mac window title** follows `connection.state`; with no bundled helper (a dev build) the
  helper never reports, so the title stays the fleet's name, as before.
- **Unverified by hand.** Nothing here has been seen in the real app, and no real `archi host add`
  has been run against a Linux machine from the page — the M2 gate still owes that.

## Fix round 1

Commit: `e99a513 A host check lists what the machine answered, and a removal asks first` (on 22295e3).
Only `apps/desktop/web` and `apps/desktop/mac` changed; `packages/cli` untouched.

### 1. Check (doctor) showed nothing

`HostOp.printsReport` is true for `doctor` only; `AppDelegate.startHost` passes it to
`HostProcess(executable:arguments:report:)`. In report mode the child's stdout is collected rather than
line-decoded, and at exit it is decoded as `{machine, checks:[{name,status,detail}]}`; each check goes to
the page as a step (`step: name, status, detail`). A failing check counts as the run's failure, so no stderr
step is added after it. The page needed no change: the steps arrive as ordinary `host.step`s.

- RED: `testACheckReportsEachOfTheMachinesChecksAsAStep` (fake helper prints the report exactly as
  `JSON.stringify(report, null, 2)` does, one line at a time, then `exit 1`):
  `XCTAssertEqual failed: ("[]") is not equal to ("[…Step(step: "tmux", status: "ok", …), …"linger", "warn"…, …"release", "fail"…]")`
- GREEN: `swift test --package-path apps/desktop/mac` passes. Also covered in e2e by
  `a check says ready for handover only when every check is ok; an upgrade never does`.

### 2. The Machines modal sat under native surfaces

`isVeiled` (selectors.ts) takes `hostOpen` and veils while it is true.

- RED: `selectors > anything the page spreads over a surface hides it first` → `expected false to be true`;
  `store > hides the terminals while the machines panel is open over them` → `expected false to be true`.
- GREEN: both pass (`pnpm vitest run --project @archipelago/desktop-web`).

### 3. The connection banner reached local-only users, stacked on the offline banner

`connectionBanner(connection, handoverEnabled)` (host.ts) returns text only when `owner !== 'local'` or
`handoverEnabled`. `App.tsx` renders that banner, and the "archid connection lost" / outdated banner
only when there is no connection banner, so one banner shows at a time.

- RED (unit): `reaches a fleet on this Mac only once it asks for handover` → `connectionBanner is not a function`.
- RED (e2e, new spec run against 22295e3's `src`): `a fleet on this Mac keeps its one offline banner until
  it asks for handover` → `getByTestId('connection-banner') Expected: 0 Received: 1`.
- GREEN: both pass. The e2e stops the daemon with handover off and checks only `offline-banner` shows,
  then sends a remote `error` and checks only `connection-banner` shows, then turns handover on and checks
  a local `daemon_down` gets its banner. `reconnect.spec.ts` and `settings.spec.ts` also still pass.

### 4. Enable relabelled; the shell names the fleet

The button and run title are now "Make it this fleet's gateway". Its tooltip says it makes the machine
the gateway that keeps the fleet's ownership record and that the fleet stays on this Mac. The page sends
`host.start enable { name }` only: `HostArgs.fleet` is gone from both `bridge.ts` and Swift's `HostArgs`, and
`fleetProfile` is gone from host.ts. `HostCommand.arguments(op:args:fleet:)` takes the fleet from the
shell: `ArchiHome.fleetProfile(of:in:)` returns `private` for `~/.archipelago`, the profile for
`~/.archipelago-<name>`, and nil for an ad-hoc `$ARCHI_HOME`. For an ad-hoc home, enable fails with a step
that says the home is not a profile's.

- RED: compile failure first (`extra argument 'fleet' in call`, `type 'ArchiHome' has no member 'fleetProfile'`).
  Once the signatures existed, `testTheGatewayIsForTheFleetTheShellRunsNotOneThePageNames` and
  `testAFleetIsNamedByTheProfileArchiKnowsItBy` covered them. The first decodes a page message that
  carries `fleet: "other"` and checks that the argv names the shell's fleet.
- GREEN: pass; e2e asserts the button text and that the page sends `{ type: 'host.start', op: 'enable', args: { name: 'studio' } }`.

### 5. Remove asks first

`hostForget` became `hostConfirm: { name, forget }` (`confirmHost`). Remove and Forget both open one
confirmation (`host-confirm`, `data-op` remove|forget) that says what each does. Remove uninstalls
Archipelago there, drops the route, and leaves the fleets and their files on that machine (it never
passes `--purge`). Only the confirm button sends `host.start remove`.

- RED (unit): `asks before it removes or forgets a machine, and only then` → `confirmHost is not a function`.
- RED (e2e against 22295e3's `src`): `a machine is only removed or forgotten once the page has asked` →
  `getByTestId('host-confirm') … element(s) not found`.
- GREEN: both pass.

### 6. The cancel test was not load-bearing

`testCancellingStopsAChildThatWouldOtherwiseKeepRunning` now uses `then: "exec sleep 30"` and also
asserts that `cancel()` returns in under 5 s. Measured with a mutated `cancel()`:

| mutation of `cancel()` | test at 22295e3 (`exec cat`) | test now (`exec sleep 30`) |
|---|---|---|
| does nothing | fails 10/10 (the check wins the race with `cat`'s exit) | fails 10/10 |
| waits without `terminate()` | **passes** (0.12 s; `cat` exits by itself) | **fails**: `XCTAssertLessThan failed: ("30.08") is not less than ("5.0")` |

Both mutations were reverted; the test passes (0.1 s).

### 7. Tokens and stderr

- `withoutTokens`: `TOKEN` is now `/(token["']?\s*[:=]\s*["']?)[^\s"'&,;}]+/gi`, with no leading-character
  guard, and the value stops at `&`. `?token=`, `&token=` (the app's own `?port=…&token=…`), `ARCHI_TOKEN=`,
  `"token":"…"` and `--token` are all masked.
  RED: `masks a token in a query string and in an environment variable` →
  `expected 'GET /?token=abc123 failed' to be 'GET /?token=… failed'`. GREEN: passes.
- stderr: `StderrTail` (ControllerProcess.swift) keeps the last 5 whole, non-empty lines across chunks.
  `LineBuffer.end()` turns bytes after the last newline into a line. `HostProcess.finish` drains stderr with
  `readToEnd()` before it reads the tail. The synthetic `archi` fail step carries those lines, joined with
  `\n`.
  RED: `testStderrIsKeptInWholeLinesAcrossChunksAndUpToTheLastByte` (the stderr line is written in two
  chunks 0.3 s apart with no final newline, after a whole earlier line) →
  `("…detail: Optional("Permission denied (publickey).")…") is not equal to ("…"Warning: Permanently added studio to the list of known hosts.\narchi: could not open a master to linus@studio: Permission denied (publickey)."…")`.
  `testTheStderrTailIsBounded` covers the limit and `end()`. GREEN: both pass.

### 8. "ready for handover" after any clean run

`readyForHandover(run)` (host.ts) is true only for an `add` that exited 0 with no actions, or a
`doctor` that exited 0 with at least one step and every step `ok`. Otherwise the panel shows "still to
do" with the actions, or `<Op>: done` / `<Op>: ended with exit N`.

- RED (unit): three tests in `the end of a run` → `readyForHandover is not a function`.
- RED (e2e against 22295e3's `src`): the new check/upgrade spec failed, since an upgrade that exited 0 showed
  "ready for handover".
- GREEN: all pass.

### Verification (once, before the commit)

- `pnpm vitest run --project @archipelago/desktop-web`: 30 files, 340 tests passed.
- `pnpm --filter @archipelago/desktop-web exec playwright test e2e/host.spec.ts`: 5 passed. RED against
  22295e3's `src`: 3 failed, 2 passed.
- `swift test --package-path apps/desktop/mac`: 40 tests, 0 failures.
- `pnpm typecheck`: clean.

### Concerns

- "Every check ok" is literal, so a doctor with a `skip` (codex not installed) or any `warn` (gh not
  logged in, linger off) never says "ready for handover". It ends with "Check: done" and the marked rows.
  That follows the ruling; say so if `skip` should count as ok.
- The stderr step joins up to five lines, so a warning ssh printed just before the error rides along. The
  page renders the `\n` as a space.
- Not seen in the real app. No real `archi host doctor` was run: the report shape comes from `printResult`
  (`JSON.stringify(value, null, 2)`) and `HostReport`.

### Follow-up ruling: a skipped check counts as ok

Commit: `152afea A check with only skipped checks beside the passing ones is ready for handover`. The controller ruled that `skip` means the check does not apply
and `warn` carries an action. `readyForHandover` now says a `doctor` run is ready when it exited 0, has
at least one step, and no step is `fail` or `warn`. The first concern above no longer applies to `skip`;
a `warn` still keeps the ready line away.

- RED: `the end of a run > is ready for handover when a check finds nothing failing and nothing left to do`
  → `expected false to be true` (the `[ok, codex skip]` case). e2e: `a check says ready for handover when
  nothing failed or is left to do; an upgrade never does` (the doctor run now includes
  `codex: skip, not installed`) → `Expected: "ready for handover" Received: "Check: done"`.
- GREEN: `pnpm vitest run --project @archipelago/desktop-web`: 30 files, 340 tests passed.
  `pnpm --filter @archipelago/desktop-web exec playwright test e2e/host.spec.ts`: 5 passed.
