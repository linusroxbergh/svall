# Task 36b report — controller faults, two controllers, seeded order

Commits `c923c2bc..174824cc` on `experimental-remote-sessions` (not pushed), on top of `029709e4`:

1. `c923c2bc` The Task 27 fault world lives in a test module of its own, so the controller's fault suite can strike it too
2. `52ad0d18` The daemon fault suite's world of real daemons, gateway and controller lives in a test module the controller's fault suite imports too
3. `77127e4d` The controller's fault suite loses, drops, repeats, holds back and cuts off every request it sends, and races a second controller at each one
4. `0a25fb07` A controller that rebuilds its journal from the daemons' goes on from the phase they stand at, so its resume after the destination prepared reaches the destination instead of claiming the roots again (**defect 1**)
5. `d3efb3b1` The controller sets a journal it cannot read aside between the failpoints of its journal writes, so a crash on either side of it is struck (**defect 2**)
6. `23070d66` A start cancelled while its Begin went unanswered keeps its journal and offers the abort when the gateway cannot say whether it opened the handover, instead of reporting it aborted (**defect 3**, ledger line 484)
7. `c30183eb` The controller's fault suite asks a second start, resume and abort on the same machine at every request of a running one, and races two processes for the handover lock
8. `ec90762d` The controller's message faults open no second handover, whatever repeats or holds back a request
9. `fe72be33` The controller's fault suite meets two Begins at the gateway with the same choices and with different ones
10. `174824cc` pnpm test:faults runs both handover fault suites in a seeded random order, which vitest names so a failed order can be run again

## Frameworks: two worlds, no third

- **The Task 27 world** moved from `handover.test.ts` to `packages/cli/test/controller/world.ts`, with `keptCommit`. Its
  `Fault` gained `duplicate` and `stale`. Its matrix (the old "a controller that dies or loses its network after any
  await") moved into the new suite and now runs over three runs instead of one.
- **36a's world** moved from `packages/archid/test/handover/faults.test.ts` to `fault-world.ts` beside it. Both fault
  suites import it. Additions:
  - `request()`: every controller request (daemon call, gateway op, rsync over the link) goes through it, gets a label,
    and can be struck by one message fault (`w.message`);
  - `gate`: awaited before a controller's nth request, so a test can run another controller there;
  - seats: a controller on trift keeps its journal in `ctl-trift`;
  - `recover(prefer, seat)`: forgets a journal status calls superseded (`forgettable`), as `archi handover --forget`
    does. `settledOn` checks every controller folder.
- `packages/cli/test/controller/faults.test.ts` holds the cases.

### What a message fault is here, modelled on the real transports

The controller never sees a duplicated or stale *answer*. The WS client matches answers by id and drops unknown ones.
`reconnecting` drops a client after any unanswered call. The gateway over ssh is one process per op. So a repeated or late
*request* is what reaches the party. The kinds are:

| Kind | Party sees | Controller sees |
| --- | --- | --- |
| lost | the request | no answer, so it asks again |
| dropped | nothing | no answer |
| duplicate | the request twice, back to back | the first answer (the second one's goes nowhere) |
| stale | the request, delivered only after the next request to that party has been answered (its retry), or at recovery | no answer |
| partition | nothing from then on, until recovery | refused connections |

- The link (rsync) gets only lost, dropped and partition. It ends 255, as ssh ends a dropped rsync. The controller waits
  out its own rsync child before running another, so no copy arrives twice or late.
- The Task 27 world does the same at each call. Its store gets only `death`, and its transfer gets no duplicate or stale.

## Scenario matrix and results

### Message faults, Task 27 world (fake daemons, the real gateway `transition`)

Each run is struck at every call with every kind. Recovery then goes resume-first and abort-first.

| Run | Calls struck | World runs per variant | Result |
| --- | --- | --- | --- |
| move | all 36 (18 requests × 6 kinds, 1 transfer × 4, 17 store writes × death) | 129 | pass |
| cancel once prepared | its own 3 (gateway abort, mac abort, trift abort) × 6 | 18 | pass |
| a kept commit | its own 1 (`mac handover.reaches`) × 6 | 6 | pass |

306 struck runs in 6 tests.

### Message faults, real daemons and gateway (564 tests)

Each case strikes one request, recovers by status (resume-first or abort-first), and checks four things:
- the struck request is the one probed;
- no invariant violation at any step;
- at most one handover ever opened;
- the fleet settles, on the destination if the gateway ever committed.

| Script | Requests struck | lost | dropped | duplicate | stale | partition |
| --- | --- | --- | --- | --- | --- | --- |
| move | all 32 (14 over the link) | 64 | 64 | 36 | 36 | 64 |
| cancel once prepared | its own 3 (the abort path) | 6 | 6 | 6 | 6 | 6 |
| cancel during the transfer | its own 3 | 6 | 6 | 6 | 6 | 6 |
| resume once frozen (controller crashed at `controller.manifest:after`) | 7, observe through the re-sent Freeze | 14 | 14 | 14 | 14 | 14 |
| abort once frozen | all 8 | 16 | 16 | 16 | 16 | 16 |
| resume once committed (crashed at `controller.commit:after`) | all 9 | 18 | 18 | 18 | 18 | 18 |

Every label is struck. Counts per label, over both variants:

| Label | Cases |
| --- | --- |
| gateway get | 40 |
| mac / trift ownership.get | 40 each |
| gateway abort, mac / trift handover.abort | 30 each |
| mac / trift handover.status | 30 each |
| trift system.info | 30 |
| mac handover.freeze | 20 |
| trift handover.activate | 20 |
| mac / trift handover.complete | 20 each |
| gateway complete | 20 |
| mac system.info, preflight, inspect, begin, claim, prepare, ready, commit | 10 each |
| link rsync, link rsync --dry-run | 36 each |
| link rsync --version | 12 |

All pass.

### Unknown Commit (6 tests, real world)

| Case | Result |
| --- | --- |
| Answer lost after the gateway committed, gateway answering | `gateway get` right after, no second Commit, complete, destination |
| Commit never reached the gateway, gateway answering | get → still ready → Commit again → complete |
| Answer lost after commit, gateway then unreachable | interrupted `commit`, `safe: []`; neither machine may run terminals |
| Commit never reached the gateway, gateway then unreachable | same as above |

In both unreachable cases:
- a new controller's `abort` and `resume` while the gateway is still away are both `interrupted, safe: []`, and change no
  ownership record;
- no `mac handover.abort` is ever sent;
- once the gateway answers, `resume` and `abort` each settle it: on the destination after a lost answer (both prefs), and
  on the source (abort) or the destination (resume) when the Commit never landed.

### Cancel while Begin goes unanswered (2 tests, real world)

| Case | Result |
| --- | --- |
| Answer lost, gateway still answering | `openedHere` finds the handover, the abort closes it: `aborted`, source |
| Answer lost, gateway then unreachable | `interrupted`, `safe: ['abort']`, journal kept, gateway holds `preparing`, source still runs; `abort` settles it on the source (**defect 3**, RED before `23070d66`) |

### Two controllers on different machines (128 tests, real world)

Each race runs the second controller whole before every non-link request of the first, and once with both at once.
Both machines' controllers then recover by status (forgetting a superseded journal). Every case checks:
- the invariant at every step;
- at most one handover id ever opened;
- no `aborted` outcome once the gateway committed;
- the fleet settles, on the destination if it ever committed.

| Race | Cases | What happened |
| --- | --- | --- |
| start here + start on trift | 19 | second before Begin: it moves the fleet; the first is refused (`generation_mismatch` blocker, or the old source's `handover_committed` / `frozen` refusal). After Begin: the second is blocked `transaction_open` or refused `frozen`. |
| start on trift + start here | 19 | the same, mirrored |
| start here + abort on trift | 19 | before Begin: `none`. Open: the abort closes it; the start is refused at its next step (typed: gateway `transaction_mismatch`, a prepare `blocked`) and recovery finishes the abort. After Commit: the abort is refused (`safe: ['resume']`). |
| start here + resume on trift | 19 | the resume adopts the handover and finishes it, or stops at a blocker it cannot answer and aborts it; the first is refused at its next step |
| resume + abort on trift, once frozen | 16 | as above; the abort wins unless the resume's Commit landed first |
| abort + resume on trift, once frozen | 9 | the abort wins; the resume is refused |
| resume + resume on trift, once frozen | 16 | one finishes, the other is refused or finds it done |
| abort + abort on trift, once frozen | 9 | both `aborted` or one `none` |
| two Begins meeting at the gateway, same choices | 1 | the gateway answers the second with the handover it holds; both drive it, both `complete` |
| two Begins meeting, the second also interrupting agents | 1 | the source's freeze with other choices answers instead; the first is refused (`not_ready`, interrupted), the second completes |

All pass.

### Two controllers on one machine (2 tests)

| Case | Result |
| --- | --- |
| `runHandover` start, with a second start, resume and abort through `runHandover` at every one of its 18 non-link requests (54 attempts) | each second run: exit 1, `handover.result` "already running here", never connected. The first completes, destination. |
| Two `tsx` processes race `takeLock` from a barrier, 3 rounds | exactly one `took`, the other `held` (`Live`); the lock is gone afterwards. This closes ledger line 534's gap: that test ran both opens in one process. |

### A controller with no journal of its own (5 tests)

| Case | Result |
| --- | --- |
| On trift, resume after the mac controller died before Ready, destination prepared | complete (**defect 1**, RED before `0a25fb07`) |
| Same, died before Commit | complete (**defect 1**) |
| On mac, own journal unreadable, resume | complete; the journal is set aside once (**defect 2**, RED before `d3efb3b1`) |
| Same, crashing before the aside | the aside is struck: no aside file; recovery settles it |
| Same, crashing after the aside | the aside is struck: one aside file; recovery settles it |

## Defects found and fixed

**1. A controller that rebuilt its journal could never resume past a prepared destination** (`0a25fb07`).
- `adopt()` builds a journal at the phase the daemons' journals stand at (`prepare`). The journal has no manifest digest,
  so `freeze()` asks the source again, and it called `this.phase('freeze')`. That turned the phase back to `freeze`.
- `landed()` then copied again. `claim` on a prepared destination is refused (`not_ready`), so every resume ended
  interrupted, and status kept offering resume.
- This hits a controller on the other machine, and the same machine after `observe(true)` set an unreadable journal
  aside. The spec says the journals "contain enough information for a new controller process to resume".
- Fix: `freeze()` sets the phase only when the journal is not already past Freeze. The source answers the kept manifest
  as before.
- Tests:
  - handover.test.ts "goes on from the prepared state when its journal is rebuilt from the daemons', without copying
    again": RED `interrupted`, GREEN complete with no second transfer;
  - the two trift cases above: RED, GREEN.

**2. The controller's aside of an unreadable journal ran outside every failpoint** (`d3efb3b1`).
- `fileStore.read(true)` renames `handover.json` to `.broken-<ts>`. 36a's guard flagged it: `rename of
  ctl/handover.json.broken-… by the controller ran outside every failpoint`.
- Fix: the rename runs inside `boundary('controller.journal', …)`, the failpoint of every other write of that file.
- Test: the unreadable-journal cases, with crashes on both edges of the aside. RED: the guard violation, and the
  `before` crash could not strike it.
- The aside never happens in 36a's probes, so `REACH` counts are unchanged.
- `settledOn` now leaves a `handover.json.broken-*` alone: it is kept on purpose, for a person to look at.

**3. A cancel during an unanswered Begin reported `aborted` and dropped the journal while the gateway could still hold
the handover** (`23070d66`). This is the residual of ledger line 484.
- When `openedHere()` could not reach the gateway, the cancel went through `undo`. With no transaction id,
  `letGo` cleared the journal and returned `aborted`, while the gateway held a `preparing` handover.
- Status then offered `resume`, which would carry on a handover the user cancelled. The next start was blocked
  `transaction_open`.
- Fix: in that case `begin()` throws `Stopped('begin', …, ['abort'])`. The journal stays, the outcome is interrupted
  with the abort on offer, and the abort closes the handover once the gateway answers.
- Tests:
  - handover.test.ts "asked while a Begin whose answer was lost waits, and the gateway cannot then say whether it opened
    it, keeps its journal for the abort": RED `aborted`, GREEN;
  - the real-world case above: RED, GREEN.

No case let two machines run terminals, gave the destination a window before the commit, or ran the source after it.

## Seeded order

`pnpm test:faults` runs both fault suites with `--sequence.shuffle`, which shuffles files, suites and tests.
- Vitest prints `Running tests with seed "<n>"` at the top of every shuffled run, a failed one included. With no seed it
  takes `Date.now()`.
- `pnpm test:faults --sequence.seed=<n>` runs that order again.
- The probes that enumerate cases run at collection, before any test. Every case builds its own world. So the order
  does not change what a case runs.

| Seed | Result |
| --- | --- |
| 36 | 1135 passed (before the last added test) |
| 7, 424242, 2026, 36, 1790590932063 (random) | 1136 passed each, on the final tree |
| 2026 (earlier) | 1135 passed |

Seeds 7, 424242 and a random one also ran once on a tree with an uncommitted draft case of mine that hung. That case
never reached Begin, so its gate waited. It was fixed before `fe72be33`, and every other case passed in those orders.

## How new controller boundaries stay covered

- **Requests.** The message matrices are generated from probe runs at collection. A new request the controller sends
  in any scripted run is struck with every kind, with no table to update.
- **Kinds of request.** "the requests the controller sends" scans `handover.ts` for every `daemon.call('<method>'` and
  `gateway.<op>(`. Each must be struck in one world or the other, and rsync over the link in the real one. Mutation:
  a `destination.daemon.call('handover.bogus', …)` in an unreachable branch fails it with `["handover.bogus"]`.
- **Crash failpoints.** These stay as 36a built them: `REACH` is typecheck-enforced, the probes count each step, and
  the guard fails any rename, link or removal under a home made outside a boundary. That guard is what found defect 2.

## Other mutation checks (each reverted)

| Mutation | Caught by |
| --- | --- |
| The gateway opens a new handover for a Begin repeated while one is preparing | Task 27 move matrix; real world lost / duplicate / stale at `gateway begin` (6 cases, via "no second handover"); both-at-once start races; meeting Begins |
| `takeLock` treats no other process as holding (`holds` false for other pids) | the two-process race (`took`, `took`) |
| `takeLock` never throws `Live` for a live holder | the two-process race. In-process the socket still refuses the second run, so the `runHandover` case alone does not catch it. |
| An unknown Commit offers `resume, abort` instead of nothing | the 4 unreachable-gateway unknown-Commit cases |
| Each defect fix reverted | its RED test above |

## Items left open earlier

| Item | Now |
| --- | --- |
| 479: a superseded controller journal has no exit | Holds as fixed by Task 28a's `--forget`, which `recover` now uses. The races never produced a superseded journal. |
| 479: `moved` past g+1 leaves pending gateway | Fixed: `complete()` treats `generation_mismatch` above g+1 as past. |
| 479: `moved` reports an aborted journal complete | Fixed: an aborted journal assesses as superseded. |
| 484: cancel during a Begin whose first answer is lost | Fixed when the gateway answers (Task 27). The unreachable-gateway residual was defect 3, fixed. The backoff wait ends on cancel (existing test). |
| 534: the two-starts test runs both opens in one process | Closed by the two-process race; it passes. |
| 36a: `SourceHandover.supersede` closes its journal before removing the manifest | No longer holds: since `a676269e` it removes the manifest first. It still has no failpoint (36a concern, force-owner path). |

## Verification

- `pnpm typecheck`: clean.
- `pnpm test packages/cli/test/controller/faults.test.ts`: 714 passed, about 40 s.
- Both fault suites shuffled: 1136 passed with each of five seeds (table above).
- `pnpm vitest run --project protocol --project archid --project cli --project @archipelago/desktop-web --project scripts`,
  on the final tree: 194 files passed and 1 skipped; 4146 tests passed and 5 skipped, first run, no flake.

## Concerns

- **Two controllers can drive one handover.** Begin is idempotent for a retry, so two starts whose Begins meet before
  either freezes both get the same transaction.
  - With the same choices both drive it and both report `complete`. With other choices one is refused.
  - A blocker the other cannot answer (a non-interactive run cancels) aborts the handover under the first. It is
    refused at its next step.
  - Safe by the invariant. Telling a second controller from a retry would need a caller nonce in Begin, a protocol
    change.
- **An adopted journal carries no choices.** A resume from a controller without the original journal meets the
  user's blockers again (`shell_busy`, a diverged root). Without someone to answer, it aborts the handover.
- **Outcomes read locally.**
  - An `interrupted` result's `safe` is the controller's own reading. When another controller finished the move
    meanwhile, it can still list `abort`; status refuses that abort.
  - A second start while the source is frozen ends `interrupted` with the source's `frozen` refusal, not
    `blocked: transaction_open`.
- **Prepare does not ask the gateway**, as claim does. A prepare arriving after an abort can write a destination journal
  for a handover no one holds. It is held and not the owner. In these runs the dropped stage refused it
  (`transcript_missing`). Status's finish-abort clears it.
- **The same-machine case composes.** It runs the command's lock and socket over the world's controller in one process.
  The cross-process property is the `takeLock` race, not two full helpers.
- **Runtime.** The cli fault suite takes about 40 s, the archid one about 24 s.
- **Test-only imports.** The cli suite imports `packages/archid/test/handover/fault-world.ts`, as archid's suite
  already imports `packages/cli/src`.
