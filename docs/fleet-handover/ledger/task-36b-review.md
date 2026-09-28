# Task 36b review — controller faults, two controllers, seeded order

Commits `029709e4..174824cc`. Verdict: **Needs fixes** — 0 Critical, 1 Important, 7 Minor.

All mutation and probe runs were in scratch copies (`git archive` of 174824cc, 52ad0d18 and 029709e4); the worktree is
untouched apart from this file.

## Spec compliance

| # | Item | |
| --- | --- | --- |
| 1a | Lost, dropped, duplicate, stale and partition at every request of six scripts, invariant checked at every daemon answer, gateway op, window op and boot, recovery by `status`'s `safe` | ✅, except one request site no case strikes (I1) |
| 1b | A new controller request without a case fails | ❌ enforced per method name, not per request site (I1) |
| 2 | Two controllers on one machine (lock + socket, two-process `takeLock` race), on two machines at every request of the first, meeting Begins, unknown Commit lost after / before the gateway committed | ✅ (M2, M5) |
| 3 | Seeded order over both suites, seed printed, rerun reproducible | ✅ |
| 4 | Three product fixes correct, minimal, each with its failing case | ✅ |
| 5 | World moves behaviour-preserving, no third framework | ✅ |
| 6 | Implementer's concerns against the spec | see "Concerns" |

## Important

**I1. The rebuilt-journal resume path is outside the message-fault matrix, and the coverage check cannot see it.**
- `packages/cli/test/controller/faults.test.ts:569-581` checks struck *method names*. A second call site of a method
  struck elsewhere passes unseen.
- One such site exists today: `landed()`'s `handover.prepare` with `landed: []`
  (`packages/cli/src/controller/handover.ts:493`). It runs only for a journal past Verify without a landed digest, which
  is the adopted-journal path where defect 1 lived.
- Evidence: I made that call throw in a scratch copy and ran the whole cli fault file. Only the 5 "no journal of its
  own" cases failed; 709 passed, including all 564 message cases, the 128 races and the Task 27 matrix. So no lost,
  dropped, duplicate, stale or partition fault ever reaches that request.
- By reading, the site uses the same `retrying('prepare', …)` wrapper as the struck prepare, so the risk is low. But
  item 1 asks for "every request", and the check claims more than it enforces.
- Fix:
  - add a `SCRIPTS` entry that resumes from the daemons' journals once the destination has prepared, so every request of
    that path is struck. The `before` can be `diesAt('gateway ready')` plus removing `ctl/handover.json`, or the trift
    seat; the `go` is that seat's `resume`;
  - either make the check count call sites per method (for example, the number of `daemon.call('m'` occurrences against
    the distinct struck sites), or say in the test's name that it is per method.

## Minor

**M1. No case checks that an `aborted` outcome means the gateway let go.**
- Mutation: `undo()` goes on to `letGo` when the gateway's abort goes unanswered, instead of throwing
  (`handover.ts:713`, `if (!(e instanceof Refused)) return this.letGo(done);`). It survives all 784 tests of
  `faults.test.ts` and `handover.test.ts`.
- After Freeze, the source's `mayTakeBack` (`packages/archid/src/handover/source.ts:317`, `:444`) refuses to take the
  fleet back while the gateway holds the handover, so this cannot split the fleet.
- Before Freeze (journal at `begin` with a transaction id), `letGo` skips the daemons, clears the journal and reports
  `aborted` while the gateway still holds `preparing`.
- The real code throws, which is correct. The gap is that the suites would not notice if it stopped doing so.
- Fix: add a case that cancels after Begin is answered and before Freeze, with the gateway abort partitioned; expect
  `interrupted`, `safe: ['abort']` and a kept journal. In the message matrix, also assert
  `first.status !== 'aborted' || w.record().transaction?.id !== first.transactionId`.

**M2. The stale model never delivers a request after its handover has closed.**
- `fault-world.ts:533` releases a held request right after the next request to that party is answered, or at recovery.
- A Begin that lands after the abort of its handover is therefore never exercised.
- Probe (scratch, a `late` kind released only at `reconnect`, first `gateway begin` of the `cancel` and `abort` scripts):
  - the first run ends `aborted`;
  - recovery then delivers the Begin, which opens a second transaction (`w.transactions.size` 2);
  - status says `open:resume+abort`;
  - `abort` settles the fleet on the source, and `resume` moves the fleet the user cancelled;
  - no invariant violation.
- This is the same cause as concern 1: no caller identity in Begin.
- Fix: record it with concern 1 as a known version-1 limitation, and optionally pin it with a case: the orphan is
  abortable, and the source never freezes for it.

**M3. The meeting-Begins test hangs instead of failing** (`faults.test.ts:410-414`).
- If one controller never reaches `gateway begin`, `await met` waits until the 20 s test timeout.
- This happened to the implementer's draft: the scratchpad's `seed-7.log` shows "Test timed out in 20000ms".
- Fix: resolve `met` once either party's run settles, so `expect(arrived).toBe(2)` fails at once with a reason.

**M4. A script can silently lose all its cases** (`faults.test.ts:151`).
- `labels.indexOf(s.until)` returns −1 when the label is renamed or absent, which strikes nothing.
- No count floor guards the real-world scripts. The Task 27 matrix has one (`cases > 120`).
- Fix: at collection, assert that `until` is found and that each script's `at` is non-empty.

**M5. The lock race has a timing assumption and leaves one branch unraced** (`faults.test.ts:490-522`).
- The holder releases after a fixed 500 ms (`:501`). A second process starved that long under full-suite load also
  reports `took`.
- Only a fresh lock is raced. Two processes taking over a dead holder's lock, the rename-aside branch of `takeLock`,
  are not.
- Fix: hold until the test writes a `done` file after both have answered, and add a round that starts with a dead pid's
  lock in place.

**M6. The fault world's fake `ps` keeps shell quotes** (`packages/archid/test/handover/fault-world.ts:123`).
- A revived window's job is the revive command string, so the process table reports
  `claude --effort 'high' --resume <sid>`.
- `startFlags` returns `undefined` for that string, while real `ps` output (`claude --effort high --resume <sid>`) gives
  `["--effort","'high'"]`.
- Probe: a second `start` after `play(w, 'cancel')` completes, but di resumes as `claude --resume <sid>`, so
  `settledOn` fails on di's flags.
- No current case hands over after a revive. The next case that does will fail for a reason in the world, not the
  product.
- Fix: shell-split the command into argv words in `processes`, as `sh -c` would.

**M7. Prepare does not ask the gateway, as claim does** (concern 4).
- `runPrepare` (`packages/archid/src/handover/destination.ts:353`) writes its `verify` journal (`:377`) without the
  check `runClaim` makes through `receiving()` (`:315`).
- So a prepare that arrives after an abort can open a destination journal for a closed handover. It holds the
  destination, which is not the owner, and it blocks the next preflight's `transaction_open` until status's
  finish-abort clears it.
- It is safe and heals through status. The one-line check before the first journal write belongs to a daemon-side
  follow-up, not this task.

## Concerns (implementer's), against the spec

1. **Two controllers whose Begins meet drive one handover. Safe; no protocol change needed for version 1.**
   - "Ownership authority" holds: one record, compare-and-swap, at most one open transaction.
   - "State machine" requires every step to be idempotent under the same transaction id, and that is what makes two
     drivers safe:
     - Commit is a compare-and-swap on that id;
     - the source refuses to take the fleet back while the gateway holds it (`mayTakeBack`);
     - activation runs only on the destination.
   - "Concurrent handovers are rejected by the authority compare-and-swap" holds for handovers with other machines or
     another generation. Identical Begins cannot be told from a retry.
   - Limit: the world shares one disk and its rsync is a no-op, so two drivers' concurrent rsyncs into the same roots are
     not exercised. The likely real outcome is a failed verify, which ends `interrupted` before the commit. Task 37's
     two-machine run could include one concurrent start.
   - A caller nonce in Begin at the next protocol bump would close this and M2 together. Record it as a Ruling or known
     limitation.
2. **A rebuilt journal carries none of the user's choices. Acceptable.**
   - Neither the daemons' journals nor `handover.status` carry choices (`journal.ts`,
     `packages/protocol/src/messages.ts:305`), so restoring them is a protocol or journal change.
   - Past Freeze only `archiveRoots` matters, and the first claim has already archived. A probe resumed on trift from a
     rebuilt journal at `verify` (destination crashed at `destination.verify.record:after`, `prepare.seal:before` and
     `prepare.state:before`), with cy archived, and it completes each time.
   - Before Freeze, a non-interactive resume aborts on the same blockers, which is safe. The detached helper waits for
     the user instead.
   - The spec's "enough information for a new controller process to resume" is met for the transaction itself.
3. **An `interrupted` result can list `abort` that status then refuses. Acceptable.**
   - `Outcome.safe` is this controller's own reading. `--abort` assesses again and refuses, and on relaunch the contract
     makes `status` the authority.
   - This affects only what the user is offered. The invariant holds.
4. **Prepare does not check the gateway.** See M7.

## Verified clean

- **Fix 1 (`0a25fb07`).** Reverted in scratch: 6 cases fail (handover.test "goes on from the prepared state…" and all
  5 no-journal cases). Correct and minimal.
  - The same shape is not left elsewhere. A rebuilt journal can stand at `verify`, since `runPrepare` writes that
    journal first; the resume re-claims (claim refuses only a prepared digest), copies again and completes.
  - The other rebuilt phases come from the source's journal (Freeze or earlier) or are after Verify, which `landed()`
    already handles.
- **Fix 2 (`d3efb3b1`).** Reverted: the 3 unreadable-journal cases fail, one with the guard violation and one with an
  aside file where the `before` crash should have left none. The aside now runs inside `controller.journal`, as every
  other write of that file does. No other controller rename or removal is outside a boundary: the guard ran on every
  36b case.
- **Fix 3 (`23070d66`).** Reverted: both cases fail (`aborted` instead of `interrupted`). With the journal kept:
  - `assess` gives `unknown` while the gateway is away;
  - then `open` (resume or abort) if the Begin landed, or `none`/finish-abort if it did not;
  - no other cancel path reports `aborted` while the gateway may hold the handover (`undo` rethrows an unanswered
    abort; `commit` never aborts).
- **World moves.**
  - `c923c2bc` and `52ad0d18` move code verbatim: the removed and added lines differ only in imports and `export`.
  - Runtime counts are the same at `029709e4` and `52ad0d18`: 492, which is 422 archid fault cases plus 70 cli handover
    cases, with identical test names.
  - The old Task 27 matrix's assertions carry over into the 3-run matrix, with the kinds per op kept.
  - No third framework.
- **Seeded order.**
  - Every run prints `Running tests with seed "<n>"`.
  - Seed 7, run twice, gives the identical order in both files. Seed 8 gives another order over the same 1136 tests.
  - All three runs pass.
  - Probes run at collection and each case builds its own world, so the order changes nothing a case does.
- **Transport claims.** The claims about the real transports behind the fault model check out:
  - the WS client drops answers whose id is unknown (`client.ts:53`);
  - `reconnecting` drops the client after any call without an answer (`reach.ts:121`);
  - the gateway takes one ssh process, or one socket connection, per op (`authority.ts`, `reach.ts:52-60`).
- **Other checks.**
  - The unknown-Commit cases never send `mac handover.abort` and end `interrupted`, `safe: []`, while the gateway is
    away.
  - All 19 `daemon.call(` sites in `handover.ts` match the check's regex.
  - `tsc` is clean.
