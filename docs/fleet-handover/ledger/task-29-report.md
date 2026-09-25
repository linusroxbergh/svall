# Task 29 report: the handover sheet and automatic owner reconnect

Branch `fleet-handover-task29` (worktree `.claude/worktrees/fleet-handover-task29`), from 177a359. Tree clean.
Only `apps/desktop/web` and `apps/desktop/mac` were touched.

- `53ae449` An upgrade that rolls back shows the rollback under the final probe it followed
- `a0d7abd` The handover sheet carries the fleet through every durable phase
- `ffb8e7d` The app follows a detached handover helper and asks where the fleet runs once it has moved

## What was built

### Bridge (web `bridge.ts`, Swift `Bridge.swift`)

Page to shell:
- `handover.start { to, choices? }`. `to` is `local` or the gateway's registry name.
- `handover.resume`, `handover.abort`, `handover.attach`.
- `handover.choose { choices }` and `handover.cancel`.

Shell to page:
- `handover.event { event }`: each helper line, passed through as its JSON object.
- `handover.exit { code, error? }`: the process the page follows has ended.
- `shell.info` gains `gateway`, the registry name of fleet.json's `gatewayMachineId`. It comes from `ArchiHome.gatewayName()`, which reads `$ARCHI_CONFIG_DIR` or `~/.config/archipelago/machines.json`.

`HandoverChoices` in Swift decodes only `interruptAfterMs: Int`, `terminateShells: Bool` and `archiveRoots: [String]`. Any other shape fails to decode.

### Swift (`Handover.swift`, new)

- **`HandoverCommand`** builds the contract's argv, with `-p P` first when the app runs a named profile:
  - `handover <to> --json --detach [--interrupt-after Ns] [--terminate-shells] [--archive X]...`
  - `handover --resume|--abort --json --detach`
  - `handover attach --json`

  `to` must be `local` or the configured gateway, and must match the registry name pattern. An archive entry must be a root id (`r_<hex>`) or an absolute path. A negative interrupt is refused.
- **`HandoverControl`** encodes the stdin lines: `{"choose":{…}}` from the typed struct, and `{"cancel":true}`.
- **`HandoverLine`** keeps any JSON object with a string `event`. It also reads a `handover.result`'s status for the shell's own use.
- **`HandoverSession`** runs one launcher at a time. When the launcher prints `handover.detached` and exits 0, the session spawns `attach` and forwards its lines. Otherwise it reports the exit, with the stderr tail if the launcher printed nothing. `send()` writes control lines to attach's stdin. The write end is `F_SETNOSIGPIPE`, so a dead attach cannot kill the app. `stop()` only closes attach's stdin and terminates it after 1 s if it is still running. It never writes `cancel` and never touches the launcher.
- **`LineChild`**, a private helper, delivers the lines of one process to main, in order. The exit comes after the last line, because it waits for the process exit plus EOF on stdout and stderr.
- **`onMoved`** fires when an attach stream contained a `complete` result and no `handover.status`. That combination means a live helper finished the move. A replay of the events file ends with a status and does not fire it.

AppDelegate wires `onMoved` to `RemoteConnection.reconnect(with:)`. That stops the connect helper and starts a fresh `archi connect --json`, so the owner is resolved at once instead of on the old helper's next 30 s tick. The route is pending until the new helper reports `online`, and the existing `rebuildWhenOnline` rebuilds the surfaces. On quit, `applicationWillTerminate` calls `handover.stop()`.

### Web

- **`handover.ts`** (new, pure) mirrors `HandoverEvent`, `Outcome` and `Verdict`, since the page cannot import `packages/cli`. It holds:
  - the reducer: `followRun`, `applyEvent`, `endFollow`;
  - the five sections and their states;
  - `actionsOf` (what the sheet offers), `holdsTerminals`, `badgeOf`;
  - the choice model: `choiceFor`, `withChoice`, `chosen`;
  - the texts: `blockerHint`, `entityLabel`, `headline`, `rowText`, `formatBytes`.

  Every message, error and reason goes through `withoutTokens`.
- **`HandoverSheet.tsx`** (new) is a modal in the style of HostSetup. It shows destination buttons, a headline, the five sections with stable rows, blocker and warning rows with their choices, and footer actions.
- **`store.ts`** adds `handover`, `handoverOpen`, `toggleHandover`, `handoverFollow`, `handoverEvent`, `handoverExit`, `setHandoverChoices`, `handoverChoose` and `handoverCancelled`. `setFleet` clears `awaitingOwner`.
- **`selectors.ts`**: `isVeiled` now includes `handoverOpen`.
- **`boot.ts`** sends one `handover.attach` per page once `shell.info` says handover is enabled, and routes `handover.event` and `handover.exit` to the store. It passes `again` to `setEndpoint` while a moved fleet awaits its owner.
- **`api.ts`**: `setEndpoint(endpoint, again)` closes the open socket when the endpoint changes, or when `again` is set.
- **`terminals.ts`**:
  - A `not_owner` refusal goes to the retry map, not `termFailed`.
  - Every surface is closed when the page starts holding terminals.
  - No attach happens while terminals are held.
- **`TerminalArea.tsx`** shows `Resting for the handover…` while terminals are held.
- **`Corner.tsx`** adds a `Handover` control beside the owner badge. Its `data-state` is live, waiting or stopped.
- **`SideCard.tsx`** adds a "keep on this machine" checkbox, shown only when handover is enabled.
- **`styles.css`** adds the new rules, with colours and text sizes from the existing variables.

## Brief steps

| Step | Where | Proof |
|---|---|---|
| Bridge commands to start, observe and cancel a detached transaction, and rebuild it from the journaled NDJSON after relaunch | `bridge.ts`, `boot.ts`, `Bridge.swift`, `Handover.swift`, `AppDelegate.swift`. On relaunch the page sends `handover.attach`; the helper replays a live run, or prints the events file plus `handover.status` | Swift `testAStartDetachesTheHelperThenFollowsItAndCarriesTheUsersAnswers`, `testAMoveReadBackFromTheEventsFileAsksNothing`, `testThePageAsksForAHandoverByTheFormsItMayUse`. e2e `a relaunch rebuilds a stopped handover…` |
| Five sections with stable entity rows and byte progress | `SECTIONS`, `withEntity` (rows keyed by section, kind and id; a session's files fold into one row with summed bytes), `sectionStates`, `HandoverSheet` | unit `keeps one row per character, root and session…`, `puts a character the destination brought up under Resuming…`, `says how far each of the five sections has come`, `shows progress in bytes`. e2e main flow |
| Abort before Commit; destination Retry after it, never rollback language | `actionsOf` offers `cancel` only while live and before phase `commit`. `resume` is labelled `Retry` once committed. Per-character Retry on resume rows | unit `offers Abort before the commit…`, `offers Resume and Abort… only Retry after it`, `never speaks of going back…`. e2e asserts `/abort\|roll ?back\|undo\|revert/i` is absent after the commit and on a committed status |
| Explicit interrupt, terminate and archive decisions with their consequences | `choiceFor`, `withChoice`, `blockerHint`, `BlockerRow` toggles, and the Footer's Carry on / Continue waiting / Try again | unit `the choices a blocker takes`, `what each blocker and warning is explained with`. e2e decision test and preflight test |
| Close terminal surfaces at the freeze, keep selection, card and panes, then resolve the owner and reconnect after activation | `holdsTerminals`; the subscription in `terminals.ts` closes surfaces; `TerminalArea` placeholder; `awaitingOwner` until `setFleet`; Swift `onMoved` then `reconnect(with:)`; `setEndpoint` | unit terminals `closes every surface when the source freezes…`, store `keeps the selected character, its card and its panes…`. Swift `testAMoveAsksAFreshHelperWhereTheFleetIsNowAndAttachesThere`, `testAMoveTheLiveHelperCompletedAsksWhereTheFleetIsNow`. e2e main flow checks `term.close`, the placeholder, the reconnect, the same active tab, `pane-right`, and a new `term.show`; e2e `a pull the page already reconnected for…` |
| Per-character dormant resume errors without hiding a successful move | The headline leads with `The fleet runs on X now.` and counts failures. Resume rows show the error and a Retry (`char.revive`, then `char.second`) once the fleet has loaded from its new owner and the character is still dormant | e2e main flow: headline, error row, kill-window, Retry, `resumed` |
| No accidental dismissal during a decision; quitting detaches without abort | `toggleHandover` refuses to close while `decisionPending`; the × is disabled; Escape and backdrop go through the same guard. Swift `stop()` only closes stdin | store `…cannot be closed while a decision waits`. e2e decision test (×, Escape, backdrop, the corner tab). Swift `testQuittingEndsTheAttachAndNeverAsksTheHelperToStop` |

## Obligations (task-29-carried.md)

1. **Spawn and steer as the contract says.** Everything above; quitting ends only attach.
   - Swift tests: argv forms, the launch-then-attach sequence, stdin lines, the quit test, the launcher failure and stderr cases, and the read-back case.
   - e2e: Resume and Abort send `handover.resume` and `handover.abort`, never `cancel`.
2. **The Handover control beside the owner badge, only while `handover.enabled`; destinations This Mac and the gateway.** `Corner.tsx` and `Destinations`. The button for the machine that owns the fleet now is disabled.
   - e2e `the Handover control waits for the fleet to ask for handover` (no control, no attach).
   - e2e main flow (This Mac disabled for a local fleet) and pull test (gateway disabled for a remote fleet).
3. **Rest choices read once per Freeze call.**
   - The Resting section's `Interrupt and carry` sends `handover.choose {interruptAfterMs: 0}`.
   - After a blocked answer, `Continue waiting` or `Carry on` sends `handover.choose` with the accumulated choices.
   - Neither is ever a cancel.
   - e2e decision test.
4. **Blocker and warning rows show what the helper sent, naming the entity.** The message is shown verbatim (token-masked). The entity is labelled with the character's name, `folder <id>` or `session <id>`. A hint is added per code:
   - `agent_unsettled` explains terminate, hooks included;
   - `external_writer` on a pull names both sides;
   - `config_difference` says "agent CLI versions differ" and never MCP or skills;
   - `codex_trust` says Codex asks to trust each moved folder;
   - an unknown Claude session file is named by the helper's own message.

   Tests: unit `what each blocker and warning is explained with`; e2e main flow (warnings) and preflight test (pull). The concerns below cover what the page cannot name.
5. **Keep on this machine.** The side-card checkbox sends `char.update {keepHere}`. `character_pinned` names the character, points at the toggle, and offers `Open <name>'s card`, which selects the character and closes the sheet.
   - e2e preflight test: toggles the card and checks the daemon state.
6. **M2 re-show against the old owner.** `not_owner` now goes to the retry map. `setEndpoint` leaves a socket still open to the old daemon, so the status passes through offline to online and the retry fires against the new owner.
   - unit `retries an attach the old owner refused once the connection to the new owner is online`;
   - api `leaves the daemon it is still connected to when the shell names another`.
7. **Builds on 17b's RemoteConnection and the connect helper.** `reconnect(with:)` starts a fresh `archi connect --json`, and its `online` rebuilds the surfaces through the existing path. `owner-changed` is unchanged.
   - Swift `testAMoveAsksAFreshHelperWhereTheFleetIsNowAndAttachesThere`.
8. **Rollback row follows Final probe.** `rollback` moved from Companion into the Final probe group, so the checklist reads Companion, then Final probe (probe, then rollback).
   - unit `puts the rollback of an upgrade whose probe failed under Final probe, after the probe`.

## UI choices made where the contract left them open

- **Destinations** are two buttons at the top of the sheet: This Mac and the gateway. The machine that owns the fleet now is disabled. Pressing one starts the move; there is no second confirmation, because preflight blocks before anything moves.
- **Interrupt and terminate are one choice each.** They map to `interruptAfterMs: 0` and `terminateShells: true`, shown on every row they affect. The start flags cannot name characters (`--terminate-shells` is boolean), so the same shape is used for `choose`. **Archive** is chosen per root.
- **The sheet opens by itself** for a `handover.blocked`, and for a `handover.status` that has safe actions or is open, committed or superseded. It does not open for a live helper found at relaunch or for a finished replay. The corner control shows a live, waiting or stopped state instead.
- **Terminals are held** (placeholder, no attach) from the freeze until one of these:
  - the run ends uncommitted;
  - a freeze decision gives the fleet back;
  - the fleet loads from its new owner after `complete`, or from a status read back at relaunch.
- **Retry has two meanings:**
  - per failed character after `complete`, `char.revive` (and `char.second`) on the new owner;
  - for an interrupted committed run or a `complete` with `pending`, `--resume`.
- **Check again** re-attaches when the outcome is `detached`, when `safe` is `[]`, or when the shell reported an error.

## TDD evidence

- **Web unit, handover.test.ts.** Moving `src/handover.ts` aside gives `FAIL … Failed to load url ../src/handover.js`, no tests. With the module: 17 of 17 GREEN.
- **Web unit, store, selectors, terminals, api and host.** 9 failed:
  - `handoverFollow is not a function` (×4 store);
  - `toggleHandover is not a function`;
  - selectors `expected false to be true`;
  - terminals `expected 'no such character' to be undefined`, and `handoverFollow is not a function`;
  - api `timeout`;
  - host `expected [ …(3) ] to deeply equal [ …(2) ]`.

  GREEN: 31 files, 366 tests.
- **Answered-decision replay.** `expected { phase: 'freeze', … } to be undefined`, then GREEN.
- **Pull race.**
  - Unit api `…from the daemon it already reaches…`: `timeout`.
  - e2e `a pull the page already reconnected for…`: `terminal-held Expected: 0 Received: 1`.
  - GREEN after `setEndpoint(…, again)`.
- **Swift.** `cannot find type 'HandoverSession' in scope` (build failed), then GREEN with 59 tests and 0 failures (46 before).
- **Swift mutations**, each killed and then reverted (`cmp` confirmed the restore):
  - `stop()` writes cancel: `("["{\"cancel\":true}"]") is not equal to ("[]")`;
  - a read-back move reconnects: `("1") is not equal to ("0")`;
  - no attach after detached: 9 failures.
- **e2e.** The spec was written after the page, apart from the pull-race test above. Each mutation was killed (1 failed and 4 passed each time), and all were reverted:
  - a decision can be dismissed: the decision test fails;
  - terminals never held: the main flow fails;
  - Abort shown after the commit begins: `toHaveCount(0)` fails;
  - `setEndpoint` never closes: no `term.show` after the reconnect;
  - the version hint claims MCP servers: fails.

## Commands and results (final tree)

- `pnpm vitest run --project @archipelago/desktop-web`: 31 files, 368 tests, all passed.
- `pnpm --filter @archipelago/desktop-web exec playwright test e2e/handover.spec.ts`: 6 passed.
- Whole Playwright suite: 102 passed, 1 failed. The failure was `e2e/keys.spec.ts:3`, a known load flake, which passed when rerun alone.
- `swift test --package-path apps/desktop/mac`: 59 tests, 0 failures.
- `pnpm typecheck`: clean.

Nothing was run against the real `~/.archipelago`, and no app, installer or `archi` was run for real. The Swift tests use fake `archi` scripts in temp dirs; the e2e uses the test daemon with a stand-in shell.

## Files changed

- New:
  - `apps/desktop/web/src/handover.ts`
  - `apps/desktop/web/src/HandoverSheet.tsx`
  - `apps/desktop/web/test/handover.test.ts`
  - `apps/desktop/web/e2e/handover.spec.ts`
  - `apps/desktop/mac/Sources/Archipelago/Handover.swift`
  - `apps/desktop/mac/Tests/ArchipelagoTests/HandoverTests.swift`
- Modified, web: `App.tsx`, `Corner.tsx`, `SideCard.tsx`, `TerminalArea.tsx`, `api.ts`, `boot.ts`, `bridge.ts`, `host.ts`, `selectors.ts`, `store.ts`, `styles.css`, `terminals.ts`; tests `api`, `host`, `selectors`, `store`, `terminals`.
- Modified, Swift: `AppDelegate.swift`, `ArchiHome.swift`, `Bridge.swift`, `RemoteConnection.swift`; `RemoteConnectionTests.swift`.

## Self-review (fixed before the commits)

- **An answered decision came back on replay.** A reloaded page read an already-answered `handover.blocked` back as pending, because only a result or status cleared it. Any later `changed`, `entity` or `retry` now clears it, since the helper emits nothing while a decision waits. Test added.
- **The pull race.** Suppose the connect helper's 30 s tick already moved the page to the local daemon before the result. The restarted helper then names the same endpoint, nothing reloads the fleet, and the terminals are held for good. `setEndpoint(…, again)` while `awaitingOwner` fixes it. Unit and e2e tests added.
- **Retry trusted the old owner's state.** The resume-row Retry treated the old owner's fleet state as authoritative. It now waits until the fleet has loaded from the new owner.
- **The Interrupt button did not go away.** Its guard used `!interruptAfterMs`, so a chosen `0` still showed the button; it now uses `=== undefined`.

## Concerns and contract gaps

1. **`--archive <path>`.** Blocker events carry a root only as `entity.id`; the path appears only inside the message. The app therefore passes the root id (`r_<hex>`), both as `--archive` on a new start and as `archiveRoots` in `choose`. The destination daemon accepts ids: `replicas.archive` matches `root.id` or the path. If 28a validates `--archive` as an absolute path, a start with an archive choice will be refused. Either 28a accepts root ids, or the blocker gains a path field.
2. **`--interrupt-after <duration>` syntax is not fixed by the contract.** The app sends `0s`, rounding milliseconds up to whole seconds, as the spec's `30s` example suggests. 28a should accept `<n>s`.
3. **The lingering hook child is not named.** Obligation 4 asks the sheet to name the user's hook child that keeps an interrupted Claude unsettled. The `agent_unsettled` message from `archid/src/handover/rest.ts` does not carry the process ("…did not come to rest after it was interrupted"). The sheet names the character, says a hook of your own may be what still runs, and explains Terminate and carry. Naming the process needs a daemon change, outside this task.
4. **Root and session rows show ids.** Rows read `folder r_…` and `session s0`, because entity events carry no path or character. Byte progress is exact.
5. **`detached` and a later `complete`.** The contract does not say whether they arrive on one attach stream. The page treats `detached` as committed and still moving, and offers Check again. A later `complete` triggers the reconnect whichever way it arrives.
6. **EOF on the launcher's pipes.** The session reads a launcher's exit only after EOF on its stdout and stderr. It relies on the contract's "stdin and stdout closed, stderr to handover.log" for the detached child: a child that inherited those pipes would stall the launcher's end.
7. **No token guard in this branch.** The brief mentions `tokens.css` and a vitest guard, but this branch has neither: `styles.css` holds its own `:root`. The new rules use the existing variables for colour and text size, and raw px for spacing, as the neighbouring `.host-*` rules do.
8. **Not seen by eye.** Nothing was run in the built app, and no real helper was run: 28a is in parallel. The M3 real SSH handover in both directions is the controller's.

## Fix round 1

Commit: `5c648a2` A relaunch reads a finished handover back without touching its terminals, and a superseded journal can be forgotten (on ffb8e7d). Only `apps/desktop/web` and `apps/desktop/mac` changed.

### F1: every boot replayed the last run as if it were live

**Reproduced first.** A throwaway test (not committed) replayed a finished run with a decision through `handoverEvent`, line by line, as boot did, while a surface was open. It failed with `expected { closed: true, open: true } to deeply equal { closed: false, open: false }`: the surface was closed and the sheet opened.

**Swift.** The page's `handover.attach` now runs `HandoverSession.observe()`:
1. It runs `archi [-p P] handover status --json` first.
2. If the status carries `helper`, a helper is live: observe spawns `attach` and forwards its lines as live `handover.event`s. The status itself is not forwarded.
3. If no helper is live, no attach is spawned. The shell reads `<fleetHome>/controller/events.ndjson`, skips lines that do not decode, and sends one `handover.replay { events: [...lines, status] }`.
4. A status that prints nothing ends in `handover.exit` with the stderr tail.

Launcher, status and forget share the one short-command slot. The `complete && !status` guard on `onMoved` stays, for the case where a helper finishes between the status and the attach.

**Web.** A new `handoverReplay(events)` folds the whole read-back in one store update, into a run that is not being followed. Two consequences:
- No intermediate state exists, so a replayed `freeze` never produces the hold-and-close transition in `terminals.ts`. Only the final standing decides whether terminals are held.
- A replayed `handover.blocked` never opens the sheet. The sheet opens only when the final status passes `needsUser`: `safe` is non-empty, or the standing is `superseded`.

Tests:
- RED `terminals > leaves every surface open while a finished run is read back, a decision and a freeze included` → `handoverReplay is not a function`.
- RED `store > does not open for a run read back from the events file, whatever it once asked, nor for a standing with nothing to decide` → the same.
- RED `store > opens by itself when a relaunch finds a handover stopped part way, and not for one that finished`, rewritten onto `handoverReplay` → the same.
- Swift RED: the build failed on `HandoverCommand.status`, `forget`, `FromShell.handoverReplay`, the `eventsFile` argument and `.handoverForget`.
- Swift GREEN tests:
  - `testWithNoHelperLiveTheLastRunIsReadBackWithTheStatusAndNothingIsAttached`: the only call is `status`; a malformed line is skipped; `onMoved` is not called.
  - `testAFleetThatNeverMovedIsReadBackAsItsStatusAlone`.
  - `testALiveHelperIsFollowedFromItsOwnStream`: the calls are `status` then `attach`, and `cancel` reaches stdin.
  - `testAStatusThatCouldNotBeReadLeavesThePageItsStderr`.
- e2e `a launch after a finished move that once asked leaves an open terminal alone and the sheet shut`.
  - Against the ffb8e7d page it passes vacuously, because that page ignores `handover.replay`.
  - Mutation check: making `handoverReplay` fold line by line through `handoverEvent`, as the old boot did, kills it (`handover-sheet Expected: 0 Received: 1`).
- Swift mutation: observe attaches whether or not a helper is live → 9 failures, including `("[]") is not equal to ("[["handover.status"]]")`.

The existing e2e relaunch test now sends `handover.replay`, and `nothingOpen` uses it.

**Remaining case.** A live helper found at launch still streams its run from the start. If that run had an earlier decision that was already answered, its `handover.blocked` opens the sheet once. The move is in progress, and the sheet shows it; a later controller `handover.changed` clears the decision, so it is not left pending.

### F2: a superseded standing opened the sheet with nothing to offer

- `actionsOf` gains `forget`, true for a `superseded` status. The sheet shows a `Forget` button, with a title saying what it drops, and sends `handover.forget`.
- Swift runs `archi [-p P] handover --forget --json`. On exit 0 it runs `observe()` again, so the page gets the new standing as a read-back. On failure it forwards what `--forget` printed and exits with its code (with the stderr tail if it printed nothing).
- Auto-open for a status, live or read back, now uses `needsUser`. `open`, `committed` or `unknown` with an empty `safe` no longer opens the sheet. `superseded` does open it, because Forget is now the decision on offer.
- The corner badge shows `stopped` for a superseded standing.

Tests:
- RED `handover.test > offers Forget for a journal the gateway has moved on from, and asks the user only about what can be decided` → `expected { cancel: false, abort: false, …(4) } to match object { forget: true, …(2) }`.
- The store test above (superseded opens; `unknown` does not).
- Swift `testForgetDropsTheJournalAndThenReadsTheStandingAgain`: the calls are `--forget` then `status`, then a read-back.
- Swift `testAForgetThatWasRefusedSaysSo`.
- e2e `a journal the gateway has moved on from offers Forget, and a standing with nothing to decide stays shut`. Against the ffb8e7d page it fails (`handover-sheet … element(s) not found`).

### F3: a relayed `handover.entity` cleared a pending decision

`applyEvent` now clears a decision only on a controller `handover.changed`; `handover.result` and `handover.status` already cleared it. A relayed `handover.entity` or a `handover.retry` no longer does. `handoverCancelled`, the app's own cancel, now clears the decision too, as `handoverChoose` already did.

Tests:
- RED `handover.test > keeps a decision until the controller goes on, whatever a daemon relays after it` → `expected undefined to be 'freeze'`. It replaces the earlier test that asserted the opposite.
- RED `store > takes the app’s own answer to a decision as the end of it` → `expected { phase: 'freeze', …(1) } to be undefined`.

### Commands and results (final tree 5c648a2)

- `pnpm vitest run --project @archipelago/desktop-web`: 31 files, 372 tests, all passed.
- `pnpm typecheck`: exit 0.
- `pnpm --filter @archipelago/desktop-web exec playwright test e2e/handover.spec.ts`: 8 passed.
- `swift test --package-path apps/desktop/mac`: 65 tests, 0 failures.

Every mutated or checked-out file was restored and compared (`cmp` or `git diff --stat`) before the commit. Scratch files are under `scratchpad/task29/`.

### Concerns after this round

- The amended contract settles concerns 1 and 2 above. `--archive` takes the root id, which is what the app sends. `--interrupt-after` accepts `0s`.
- The read-back reads `<ArchiHome.path>/controller/events.ndjson` directly, the path the contract names, instead of spawning `attach` a second time. This keeps a helper that starts between the status and the read from being followed under the replay flag.
- What `--forget --json` prints is not fixed by the contract. On success the app ignores it and reads the standing again; on failure it forwards the lines as events.
- Still open from the first round: the process keeping an interrupted agent unsettled is not named (a daemon message), and root and session rows show ids.
