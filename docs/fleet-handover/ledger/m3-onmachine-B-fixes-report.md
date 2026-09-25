# M3 Part B fix wave: P1–P5 report

Branch `fleet-handover-impl`, from `0248e2ac`. Five commits, one per item:

| Item | Commit | Subject |
| --- | --- | --- |
| P1 | `7702a205` | A daemon call on a socket that closed between calls fails at once, and the controller sends it on a new connection |
| P4 | `aea251c2` | A daemon call still waiting on its answer keeps no process alive once the run that made it is over |
| P5 | `040e34e0` | A handover whose output reader has gone stops writing and runs on through its journals instead of dying of the broken pipe |
| P3 | `e23c562a` | A freeze whose tmux server died with every window rests the fleet as one with no window left, so its resume goes on |
| P2 | `80325900` | A retried activation starts again each terminal a destination that died opened and never started, and the fleet keeps what a rested terminal carries until the activation answers for it |

Every test command ran with `unset ARCHI_HOME ARCHI_CHAR_ID TMUX` first.

## P1: a daemon socket that closes between calls

**Change.**
- `packages/cli/src/client.ts`: a new `Client.closed` getter is true when the socket is not `OPEN`, which covers closing or closed.
- `Client.call` on such a socket rejects at once with `archid connection closed`, the same error a call cut off in flight gets. ws drops a send after close without an error, so without this the call only had its timer.
- The existing `close` handler already rejects pending calls at once, and that part is unchanged.
- `packages/cli/src/controller/reach.ts` (`reconnecting`): before each call, a held client whose socket has closed is dropped and the call goes on a new connection. This happens at most once per call. If that new client is also closed, `Client.call` rejects at once and the Handover's retry takes it from there.
- `drop` now clears `held` only if it still holds the client the failing call used. Before, a concurrent call could drop a connection that another call had just opened.

**Tests.**
- `packages/cli/test/client.test.ts`, "fails a call at once on a socket archid closed since the last call, as one cut off in flight fails".
- `packages/cli/test/controller/handover.test.ts`, "opens another client for a call when the daemon closed the last one between calls, and answers at once". This is the ruling's test: the server terminates the socket between two calls, and the second call must answer from connection 2 in under 1 s.
- The fake client in the existing `reconnecting` test gained `closed: false`.

**RED.**
```
$ pnpm vitest run --project cli packages/cli/test/client.test.ts
   × Client > fails a call at once on a socket archid closed since the last call, as one cut off in flight fails 5005ms
     → Test timed out in 5000ms.
$ pnpm vitest run --project cli packages/cli/test/controller/handover.test.ts -t "opens another client for a call"
AssertionError: expected 'no answer within 2 s' to deeply equal { connection: 2 }
```
**GREEN.**
```
$ pnpm vitest run --project cli packages/cli/test/client.test.ts packages/cli/test/controller/handover.test.ts
 Test Files  2 passed (2)
      Tests  68 passed (68)
```

## P2: a destination daemon that dies mid-activation

### What the restarted daemon did to `agent` and `revive` (traced)

- **`revive`** was removed by the *first* daemon, before it died. `Fleet.doRevive` and `doOpenSecond` do a store update that sets `tmux` and deletes `revive` as soon as the window opens. Only then do they type the resume and, 100 ms later, press Enter. The store writes synchronously, so `state.json` held the window ids with no `revive` by the time the kill landed between typing and Enter. When the restarted daemon ran `reconcile()` from `fleet.activate()`, it re-attached those windows by name, and that re-attach deletes `revive` too.
- **`agent`** was removed by the *restarted* daemon's poll. `Fleet.tick` → `settleAgent` drops an agent whose pane has sat at a shell prompt for two polls (3 s each). Each of the four panes ran bash with the resume typed and never run, so their agents went roughly 6 s after activation began.
- **Why no row.** The retried Activate's `wake` then started only slots that had no window. It took the four windows as live, `wakeSlot` never ran for them, and `characterResults` had no row for them.

I checked this on real tmux. With the destination fix but the poll guard removed, the integration test below fails: bo's agent is dropped before its window can be replaced, so bo is kept as a plain shell. That is the silent session loss from A8k2.

### How it is stopped

- **Guard in the fleet.** `Fleet.carries(fn)` is new. `DestinationHandover` registers a predicate there. It treats a terminal as *carried* when both hold:
  - its `restedBy` equals the transaction of the open destination journal;
  - that journal has no activation row for it yet.

  For a carried terminal the poll never drops the agent (`settleAgent`), and a re-attach, in `reconcile()` or in the tick, keeps its `revive`. The predicate reads the journal on every call, so it holds across restarts. It clears for each terminal as its row lands, and for all of them once the journal closes. Before activation the fleet cannot write at all, so it cannot erase anything then either.
- **Idempotent activation per slot.** `wake` now picks up every rested slot with no row, plus any slot whose row is an error and which has no window, so a "did not open" is retried. A slot with a row is left alone, so an ok row is never reopened.
- **Window checks.** Before starting a slot that already has a window, `replaceUnstarted` checks the pane:
  - A pane at a shell prompt, for a terminal with a session to resume, is killed. The slot goes back to dormant; `markDormant` recomputes `revive` from `agent`. The slot is then opened afresh and its resume runs in the new window.
  - A pane that runs something is waited on for its SessionStart. So is a plain shell with nothing to resume, which counts as up.
  - Either way the slot gets its row. `agent` now comes from `reviveCommand(slot)` rather than `slot.revive`, so a window that is still open is judged by the session it carries.
- **Deps.** `DestinationDeps` now also asks for `store.update`, `tmux.listWindows`/`killWindow` and `fleet.carries`. The real `Store`, `Tmux` and `Fleet` in `main.ts` already have all of them.

### Tests

- `packages/archid/test/handover/destination.test.ts`, "starts again each terminal a daemon that died mid-activation opened and never started, and reports every character". This uses the fake crew.
  - The crew now records windows and what runs in each pane, has `listWindows`, `killWindow` and `carries`, and a `dying` set. A dying terminal's window opens with its resume typed, and then nothing more happens.
  - The first daemon dies with bo's and dee's windows in that state. A restarted daemon enters `committed-destination`.
  - The test asserts:
    - which terminals are carried before the retry;
    - that the retried Activate reports all four characters as ok;
    - that exactly bo's and dee's windows are killed and reopened;
    - that no store update ever loses their session;
    - that nothing is carried at the end.
- `destination activate on real terminals` (same file, needs tmux). This reproduces A8k2 on real tmux, with a real `Fleet` and a 100 ms poll.
  - The first daemon types the resumes into bo's and dee's panes and dies. Its fleet stops; the tmux server and the windows live on.
  - A restarted daemon on a store reloaded from disk runs with concurrency 1, and bo's stand-in reports its SessionStart only after 400 ms. That lets the poll pass over dee's shell pane several times.
  - The test asserts:
    - that all four characters report ok;
    - that bo's and dee's windows are new and run the stand-in (`sleep`);
    - that ada's, ada-2's and cy's windows are untouched;
    - that no state loses a session.
- `packages/archid/test/fleet.test.ts`, "keeps the agent and resume command of a terminal a handover has yet to start while its pane sits at a shell prompt". This uses real tmux and covers both terminals, and the tick's re-attach.
- `packages/archid/test/reconcile.test.ts`, "keeps the resume command of a terminal a handover has yet to start when it finds the window opened for it".

### RED
```
$ pnpm vitest run --project archid packages/archid/test/handover/destination.test.ts -t "starts again each terminal a daemon that died"
AssertionError: expected [ false, false, false, false ] to deeply equal [ false, true, false, true ]
# the same test with its two carried assertions taken out, showing A8k2's missing characters:
AssertionError: expected [ { id: 'c_ada', ok: true }, …(1) ] to deeply equal [ { id: 'c_ada', ok: true }, …(3) ]
-     "id": "c_bo",  …  -     "id": "c_dee",
# real tmux, source files at HEAD~ (no fix):
$ pnpm vitest run --project archid packages/archid/test/handover/destination.test.ts -t "on real terminals"
AssertionError: expected [ { id: 'c_ada', ok: true }, …(1) ] to deeply equal [ { id: 'c_ada', ok: true }, …(3) ]
# real tmux, destination fix kept but settleAgent unguarded:
AssertionError: expected '@3' not to be '@3'      (bo's agent was dropped, so its unstarted window was kept as a plain shell)
$ pnpm vitest run --project archid packages/archid/test/fleet.test.ts -t "yet to start"
AssertionError: expected { id: 'c_qfxyus', …(12) } to match object { Object (agent, revive) }   (carries stored, guards not yet in)
$ pnpm vitest run --project archid packages/archid/test/reconcile.test.ts -t "yet to start"
AssertionError: expected { id: 'c_a', islandId: 'i_1', …(12) } to match object { tmux: { windowId: '@1' }, …(3) }
```
### GREEN
```
$ pnpm vitest run --project archid packages/archid/test/handover packages/archid/test/fleet.test.ts packages/archid/test/reconcile.test.ts   (files run alone)
 destination.test.ts 49 passed; fleet.test.ts 41 passed; reconcile.test.ts 17 passed
   ✓ destination activate > starts again each terminal a daemon that died mid-activation opened and never started, and reports every character
   ✓ destination activate on real terminals > starts again the terminals a daemon that died mid-activation opened and never started, keeping their sessions throughout
   ✓ Fleet > keeps the agent and resume command of a terminal a handover has yet to start while its pane sits at a shell prompt
```
The new real-tmux tests passed 3 out of 3 when run together with the rest of `fleet`, `destination` and `rest`.

## P3: resume after the tmux server is gone

**Change.**
- `packages/archid/src/tmux/tmux.ts`: new `noServer(e)`. It matches tmux's two no-server errors:
  - `no server running on <sock>`, when the socket file stays behind after the server died;
  - `error connecting to <sock> (No such file or directory)`, when there is no socket file at all.

  I checked both texts by running tmux 3.7c by hand.
- `packages/archid/src/handover/rest.ts`: the rest's `list-panes` read treats a no-server error as no live panes. Any other tmux error still fails the rest.
- With no panes, `layToRest` does three things:
  - it marks every slot that had a window dormant, with its `agent` and `revive` kept;
  - it closes nothing and marks nothing `restedBy`, because the rest closed no window;
  - it adds nothing to `stoppedTerminals`.

  The freeze then builds its manifest and the resume goes on.
- `handover status` keeps offering `[resume, abort]`, and both now succeed. I found no state where resume is unsafe that status would have to exclude. See the concerns section for what the destination starts afterwards.

**Tests.**
- `packages/archid/test/handover/source.test.ts`, "answers a freeze resumed after its tmux server died with every window, carrying each terminal dormant and none as rested". The setup is a journal at freeze, a frozen fleet, and a restarted `frozen-source` daemon whose `list-panes` fails with the B2k error text.
- `packages/archid/test/handover/rest.test.ts`, "rests a fleet whose tmux server died with its windows, or left no socket at all, as one with no window, closing none". This uses real tmux: the server is SIGKILLed, leaving its socket behind, and then the socket is removed.

**RED.**
```
$ pnpm vitest run --project archid packages/archid/test/handover/source.test.ts -t "answers a freeze resumed after its tmux server died"
     → Command failed: /usr/bin/tmux -S /tmp/archi-t-126fd2/tmux.sock … list-panes -s -t fleet
no server running on /tmp/archi-t-126fd2/tmux.sock
$ pnpm vitest run --project archid packages/archid/test/handover/rest.test.ts -t "rests a fleet whose tmux server died"
Error: Command failed: /opt/homebrew/bin/tmux -S /tmp/archi-t-168963/tmux.sock … list-panes -s -t fleet …
no server running on /tmp/archi-t-168963/tmux.sock
```
**GREEN.**
```
$ pnpm vitest run --project archid packages/archid/test/handover/rest.test.ts packages/archid/test/handover/source.test.ts
 Test Files  2 passed (2)
      Tests  69 passed (69)
```

## P4: a finished foreground run held open by a call's timer

**Change.** `Client.call` now unrefs its timer. While a call can still be answered, its socket keeps the process alive; the wait on its own does not. Every client is still closed at the end of a run that is not hard, through `tx.close()`, as before. Since P1, a call on a dead socket fails at once, so no timer is left from the A2d case either.

**Test.** `packages/cli/test/client.test.ts`, "keeps no process alive for a call still waiting on its answer". It counts `process.getActiveResourcesInfo()` Timeout entries before and after a call that is never answered.

**RED.**
```
$ pnpm vitest run --project cli packages/cli/test/client.test.ts -t "keeps no process alive"
AssertionError: expected 1 to be +0 // Object.is equality      (first run with P1 unapplied: expected 3 to be 2)
```
**GREEN.**
```
$ pnpm vitest run --project cli packages/cli/test/client.test.ts
 ✓ |cli| test/client.test.ts (8 tests)
      Tests  8 passed (8)
```

## P5: EPIPE on a foreground `--json` run's stdout

**Change.**
- `packages/cli/src/commands/handover.ts`: `output()` adds an `error` listener on stdout. After an EPIPE, the stream is destroyed and later writes are dropped silently, so output stops.
- The run goes on and ends through its journals and events file.
- `CliDeps.stdout` gains an optional `on`. The injected test doubles need no change, and `process.stdout` fits the type.

**Test.** `packages/cli/test/handover.test.ts`, "runs on through its journals, writing no more, once the reader of its --json lines has gone". stdout is a `Writable` whose first write fails with EPIPE. The run must return `{ code: 0 }` with exactly one write attempt, the events file must hold all four events including the result, and the transaction must be closed.

**RED.** Vitest ended the run on an uncaught exception, exit 1:
```
$ pnpm vitest run --project cli packages/cli/test/handover.test.ts -t "runs on through its journals"
⎯⎯⎯⎯⎯ Uncaught Exception ⎯⎯⎯⎯⎯
Error: write EPIPE
 ❯ Object.line packages/cli/src/commands/handover.ts:96:53
 ❯ record packages/cli/src/commands/handover.ts:173:50
exit 1
```
**GREEN.**
```
$ pnpm vitest run --project cli packages/cli/test/handover.test.ts
 Test Files  1 passed (1)
      Tests  50 passed (50)
```

## Files changed

- Source:
  - `packages/cli/src/client.ts`
  - `packages/cli/src/controller/reach.ts`
  - `packages/cli/src/commands/handover.ts`
  - `packages/archid/src/tmux/tmux.ts`
  - `packages/archid/src/handover/rest.ts`
  - `packages/archid/src/handover/destination.ts`
  - `packages/archid/src/fleet.ts`
  - `packages/archid/src/reconcile.ts`
- Tests:
  - `packages/cli/test/client.test.ts`
  - `packages/cli/test/controller/handover.test.ts`
  - `packages/cli/test/handover.test.ts`
  - `packages/archid/test/handover/source.test.ts`
  - `packages/archid/test/handover/rest.test.ts`
  - `packages/archid/test/handover/destination.test.ts`
  - `packages/archid/test/fleet.test.ts`
  - `packages/archid/test/reconcile.test.ts`

## Final suite results

- `pnpm typecheck`: exit 0.
- **protocol:** 115/115 passed.
- **cli:** 484 passed, 7 failed, 3 skipped. All 7 are 5 s timeouts under full-suite load:
  - in `controller/handover.test.ts`, two "real adapters" tests;
  - in `ssh.test.ts`, "keeps each process on a master of its own";
  - in `cli.test.ts`, three argument-parsing tests and the browser test.

  Run on their own, `controller/handover.test.ts` passes 61/61 and `ssh.test.ts` passes 24 with 1 skipped. `cli.test.ts` fails only the known browser flake, which spawns tsx eight times and passes in 8.6 s with `--testTimeout=30000`.
- **archid:** 1147 passed, 7 failed, 3 skipped. The failures:
  - `fleet.test.ts`: deactivate timeout, second-terminal revive, "marks the agent working", "reports the prompt unsent";
  - `source.test.ts`: two preflight tests timed out at 7 s;
  - `ownership.test.ts`: one test timed out at 5.6 s.

  Run on their own, `fleet.test.ts` passes 41/41, `source.test.ts` 41/41 and `ownership.test.ts` 26/26. The fleet revive and "marks the agent working" failures are on the known-flake list. The others are load timeouts that pass alone.

## Self-review

- **`reconnecting` holds one check per call.** A client whose socket closed is dropped and the call reconnects once. If the fresh connection is also closed, `Client.call` rejects at once with the transient error and the Handover's backoff takes over, so the reconnect cannot loop.
- **Retry does not reopen an ok row.** The retried Activate no longer reopens a terminal whose row is ok. Before, a retried Activate reopened any rested slot without a window, including one the user had closed after it started.
- **Plain shells.** A plain shell a dead daemon opened is kept, since there is nothing to resume, and its "restarted this shell" notice is not typed again.
- **Missing or dead windows.** A window that is missing or dead gets the same treatment as an unstarted resume: the slot goes back to dormant and opens afresh.
- **Why the pane is killed.** An unstarted pane is killed rather than having its typed line cleared. Sending C-c or C-u could interrupt a shell that is still reading its rc files, while kill-and-reopen is the same on bash, zsh and sh.
- **`window-close` races.** The fleet's `window-close` handler races the replacement's own dormant mark harmlessly. Both apply the same `markDormant`/`markSlotDormant`, since a replaced slot always has an agent, and a late event for the old window id finds nothing.
- **P3 closes nothing.** P3 treats only a missing server as no panes; any other tmux error still fails the rest. The rest closes nothing and adds nothing to `stoppedTerminals`, which is consistent with abort semantics: an abort from there revives nothing, as B2k-r showed and the spec says.
- **Backoff timer, not changed.** The Handover's retry backoff sleep keeps its timer after a cancel ends the pause early. It lasts at most 4 s with the default 4 attempts, which is outside P4's ruling.

## Concerns

1. **P3 carries terminals dormant.** After a lost tmux server, the handover carries every terminal dormant, and the destination starts none of them. The rest closed no window, so none is `restedBy`, which follows "Activation marks each terminal the rest closed … and starts only those". A user who resumes after a B2k-style crash therefore finds every character dormant on the destination with its resume command, and revives each by hand, as after B2k-r's abort. If "every terminal is then rested" was meant to have the destination start them, the rest would have to mark every slot that had a window as `restedBy` even though a crash closed it. That is a policy call for the controller.
2. **P3 cannot see agents that outlive their server.** An agent process that outlives its tmux server, for example one that ignored SIGHUP, is invisible to the rest, since there is no pane to read it through. Its transcript could still change after the manifest is built. I did not handle this.
3. **P2 false alarm when an agent already runs.** Take a window the dead daemon opened where the agent had already started, killed between Enter and SessionStart. It is kept and waited on. Its SessionStart may have gone to the dead daemon or to the restarted one while it was held, so the wait can time out. The row then says it "did not report its SessionStart … may still be starting" even though the agent runs. The error is visible, not silent, and a later SessionStart for that session clears it while the journal is still open. A8k2 did not hit this case.

---

# Fix round 1 (findings: m3-onmachine-B-fixes-fix1-findings.md)

Two commits on top of `80325900`:

| Commit | Subject |
| --- | --- |
| `7a3a205b` | A failed daemon call lets go only the client it used, never one a later call has opened since |
| `e96ee59b` | An activation judges each window a dead daemon left on a fresh look at its pane, counts one running its agent as up, and leaves a terminal that does not come up dormant with its session |

## Changes

`packages/archid/src/handover/destination.ts`, with the poll side in `packages/archid/src/fleet.ts`.

- **Finding 1: a running agent reported as failed.**
  - A kept pane whose foreground job is the agent's own kind is **up at once**. The destination reads that kind from a new `processes` dep; its default is `ProcessTable.read` with this home's installed scripts. The row is ok and carries the session id, with no SessionStart wait.
  - `sessionStarted` now keeps a SessionStart it hears for a carried terminal with no waiter, in the new `heard` map. `waitStart` accepts that entry, so a SessionStart that reached the restarted daemon while it was held answers the retry at once.
  - Three things drop a heard start: a replacement or `lay`, a fresh open, and recording the terminal's row.
- **Finding 2: one listing for the whole pool.** The single listing taken in `wake` is gone. Each slot that has a window is judged by `holding()` when its turn comes. `holding()` takes a fresh `list-panes` and a fresh `ps` of that one pane, each bounded to 10 s, and answers gone, shell, agent or other.
  - Gone, or a shell with a session to resume: the window is laid dormant and opened afresh.
  - The agent's own kind: up.
  - Something else: waited on for its SessionStart, and a heard start counts.
  - A plain shell: kept as it is.
  - If tmux or ps fails, the error propagates and the slot is left carried for the next retry. The activation never kills a window it could not look at.
- **Finding 3: an error row stays dormant.** Every error path now goes through `lay()`, which marks the terminal dormant and then closes its window. Marking it dormant first means the fleet's `window-close` handler finds no terminal holding that window. `markDormant`/`markSlotDormant` recompute `revive` from `agent`. The error paths are:
  - the SessionStart timeout;
  - "did not open", including a window that opened before the resume failed.

  With that, a slot whose row is an error is dormant with `agent` and `revive`, and nothing is left for the poll to take. The timeout message now says the terminal is dormant again with its session, and how to go on. For Codex: revive it and answer the "Trust this folder?" prompt there. For other agents: revive it to see.
- **The poll** (`Fleet.tick`) no longer re-attaches a *dormant* carried terminal to a window it finds by name. The handover opens that terminal itself. Otherwise a replacement's kill could race a poll that re-attaches the dead window id, and `doRevive` would then return without opening. The `reconcile()` an activation runs still re-attaches, so the dead daemon's windows are found.
- **Plain shells a dead daemon left:** they get the "restarted this shell" notice unless their screen already shows it, typed or run. The screen is read with `tmux capture-pane` and the text kept in the new `NOTICE` const.
- **Deps:** `DestinationDeps.tmux` also asks for `capture`. `main.ts` is unchanged: the real `Tmux` has `capture`, and `processes` has a default.

## Tests

**Finding 4: covering tests.**
- In `packages/archid/test/handover/destination.test.ts`:
  - **Crew fake.** The crew now keeps a pid, a pane job and a screen per window. It has `processes` (a `ProcessTable`), `capture`, `dies: 'typed' | 'entered'`, `exiting`, and a `dead` flag.
  - **Restart helpers.** `daemon().start({ concurrency })` lets a restart run another concurrency. `diedMidActivation()` wraps a kill mid-activation followed by a restart.
  - New or changed tests:
    - "counts at once as up a window a dead daemon left running its agent, or whose SessionStart the restarted daemon heard" (finding 1). Bo's pane runs claude. Dee's pane runs an unclassified launcher, and dee's SessionStart reaches the held daemon. The retry answers after one `settle()` with no clock advance, kills and opens nothing, and both rows carry their session ids.
    - "gives a plain shell a dead daemon opened the notice it never typed, and one that shows it nothing more" (finding 4, plain shell kept).
    - "opens afresh a terminal whose window a dead daemon opened and that has gone or died since" (finding 4, missing or dead window). This covers behaviour that already worked, so it was never RED.
    - "judges each window a dead daemon left by its pane when that terminal's turn comes, never closing an agent started since" (finding 2). Concurrency is 1. While bo waits on its SessionStart, dee's typed resume is entered and Codex starts. Dee is then counted up, not killed.
    - "leaves a resume that ends back at its shell dormant with its session and a visible error" (finding 3).
    - "names a resume that never reports back …": now also asserts that bo and dee are laid dormant with `agent`/`revive` and their windows closed (finding 3).
  - **Real tmux:** "counts as up at once a window a dead daemon left running its resumed agent, whose SessionStart went with that daemon" (finding 1). The first daemon enters each resume as `exec <bin>/claude|codex 600`, a symlink to `/bin/sleep` that ps reads as the agent, and dies. The retry must finish well inside the 10 s SessionStart wait, keep both windows, and record both session ids. The earlier real-tmux test is refactored onto shared `committed`/`boot`/`restart` helpers.
- `packages/archid/test/fleet.test.ts`, the guard test: a dormant carried terminal is not re-attached by the poll and keeps `agent`/`revive`. `reconcileNow()` then attaches it, keeping `revive`, and it keeps its agent across more polls.
- `packages/cli/test/controller/handover.test.ts`, "lets go only the client a failed call used, never one a later call has opened since" (finding 4, the `drop(was)` race). Two calls are out on client 1. The first fails, and a third call opens client 2. When the second call then fails, client 2 must stay open and answer.

**RED** (before `e96ee59b`; the reach test against `0248e2ac`'s `reach.ts`):
```
$ pnpm vitest run --project archid packages/archid/test/handover/destination.test.ts packages/archid/test/fleet.test.ts
   × Fleet > keeps the agent and resume command of a terminal a handover has yet to start while its pane sits at a shell prompt
     → expected { windowId: '@1', paneId: '%1' } to be undefined
   × destination activate > names a resume that never reports back as its character error, keeps the fleet, and clears it when the session starts after all
     → expected [ 'activate', 'reconcile', …(5) ] to deeply equal ArrayContaining{…}
   × destination activate > leaves a resume that ends back at its shell dormant with its session and a visible error
     → expected [ 'activate', 'reconcile', …(5) ] to include 'kill c_bo'
   × destination activate > counts at once as up a window a dead daemon left running its agent, or whose SessionStart the restarted daemon heard
     → expected false to be true // Object.is equality
   × destination activate > gives a plain shell a dead daemon opened the notice it never typed, and one that shows it nothing more
     → expected [ '%13' ] to include '%10'
   × destination activate > judges each window a dead daemon left by its pane when that terminal's turn comes, never closing an agent started since
     → expected [ 'kill c_dee', 'open c_dee' ] to deeply equal []
   × destination activate on real terminals > counts as up at once a window a dead daemon left running its resumed agent, whose SessionStart went with that daemon
     → expected 20073 to be less than 5000
$ pnpm vitest run --project cli packages/cli/test/controller/handover.test.ts -t "lets go only the client a failed call used"   (reach.ts from 0248e2ac)
   × the real adapters > lets go only the client a failed call used, never one a later call has opened since
     → expected true to be false // Object.is equality
```
**GREEN and covering files at `e96ee59b`**, each file run alone:
```
pnpm typecheck exit 0
== pnpm vitest run --project archid packages/archid/test/handover/destination.test.ts   Tests  55 passed (55)
== pnpm vitest run --project archid packages/archid/test/fleet.test.ts                  Tests  41 passed (41)
== pnpm vitest run --project archid packages/archid/test/reconcile.test.ts              Tests  17 passed (17)
== pnpm vitest run --project archid packages/archid/test/handover/service.test.ts       Tests  43 passed (43)
== pnpm vitest run --project archid packages/archid/test/handover/rest.test.ts          Tests  28 passed (28)
== pnpm vitest run --project archid packages/archid/test/handover/source.test.ts        Tests  41 passed (41)
== pnpm vitest run --project cli packages/cli/test/controller/handover.test.ts          Tests  62 passed (62)
== pnpm vitest run --project cli packages/cli/test/client.test.ts                       Tests  8 passed (8)
```

## Finding 5: the six named failures, each file run alone

At `e96ee59b` (run twice each; the verbose run shows the named tests):
```
== run 1: pnpm vitest run --project cli packages/cli/test/controller/handover.test.ts      Tests  62 passed (62)
== run 1: pnpm vitest run --project archid packages/archid/test/fleet.test.ts              Tests  41 passed (41)
== run 1: pnpm vitest run --project archid packages/archid/test/handover/source.test.ts    Tests  41 passed (41)
== run 2: (same three)                                                                      62/62, 41/41, 41/41 passed
$ pnpm vitest run --project cli packages/cli/test/controller/handover.test.ts --reporter=verbose
 ✓ … the real adapters > finishes a committed handover and caches the route to its new owner, which owner resolution then reads 1125ms
 ✓ … the real adapters > hands the source the far fleet home its companion reports, not one worked out from its home 568ms
$ pnpm vitest run --project archid packages/archid/test/handover/source.test.ts --reporter=verbose
 ✓ … source preflight > blocks a repository that names the platforms it runs on without the destination, and warns of an Xcode project 485ms
 ✓ … source preflight > reads a handover file only as a regular file of at most 64 KiB, and a file named .archipelago as none 1711ms
 ✓ … source preflight > blocks a repository using a Git extension the destination's git cannot open, before anything is moved 546ms
$ pnpm vitest run --project archid packages/archid/test/fleet.test.ts --reporter=verbose
 ✓ … Fleet > reports the prompt unsent when the send fails after the agent attached
 × … Fleet > ends every window and its tmux server once deactivated, keeps it down, and brings it back when activated again 5254ms   (5 s test timeout)
```
The fleet deactivate test failed once while its file ran alone, so I compared it with base.
- **At `e96ee59b`:** 8 of 9 whole-file runs alone pass. The six further verbose runs each timed it at 3223–3320 ms. On its own with `-t` it passed 6 of 6.
- **On `0248e2ac`:** I checked `packages/` out at that commit, then restored HEAD with `git checkout HEAD -- packages`, leaving the tree clean. 9 of 9 whole-file runs alone pass, at 3221–3291 ms.

The test sleeps 3 s within a 5 s budget. Nothing it runs touches the changed paths: the `carried` predicate stays at its `() => false` default, and it never activates a handover. I read the one miss as that timing margin. It is not on the known-flake list, so I note it here rather than dismiss it.

The other five named tests passed in every run alone.

## Concerns

1. **An error now closes the window.** Because an error row always ends dormant, a SessionStart timeout closes the window even when Codex is waiting at its "Trust this folder?" prompt. The user revives the character and answers the prompt there. The row's error says so, and the SessionStart after that revive still clears the error while the journal is open.
2. **A kept pane counts as up by its job alone.** A kept pane running the agent's own kind counts as up even if that agent is sitting at a prompt. The fleet's existing `codex-silent` hint is then the only signal of a Codex that never reported.
3. **`recover()` can still re-attach.** When the fleet's control client is lost, `recover()` runs `reconcile()`, which can still re-attach a carried window in the moment a replacement is killing it. If that happens, the SessionStart wait for the new window times out, and the terminal ends dormant with its session and an error. The poll no longer does this.
