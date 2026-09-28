# Task 36b — fix round 1 findings

From `ledger/task-36b-review.md` (review of 029709e4..174824cc). Read each item there in full; fix these, test first:

- **I1 (Important).** The rebuilt-journal resume path is outside the message-fault matrix, and the coverage check matches
  method names only, so a new call site of a method already struck elsewhere is invisible (today: `landed()` sending
  `handover.prepare` with an empty landed list, `packages/cli/src/controller/handover.ts:493`). Add message-fault cases
  that resume from the daemons' journals once the destination has prepared, and make the coverage check count call
  sites (or requests by site), so an unstruck site fails the suite.
- **M1.** Assert that an `aborted` outcome means the gateway let go (the review's surviving mutation: `undo` going on after
  an unanswered gateway abort before Freeze).
- **M3.** The meeting-Begins test (`faults.test.ts:410-414`) must fail, not hang to its timeout.
- **M4.** A script whose `until` label goes missing (`faults.test.ts:151`) must fail, not silently lose its cases.
- **M6.** The fault world's fake `ps` (`packages/archid/test/handover/fault-world.ts:123`) must not keep shell quotes.

Deferred (not this round): M2 (a Begin landing after its handover's abort opens an orphaned transaction), M5 (lock race
timing, stale-lock takeover unraced), M7 (prepare does not ask the gateway).
