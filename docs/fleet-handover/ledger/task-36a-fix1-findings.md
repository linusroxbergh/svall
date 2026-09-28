# Task 36a fix round 1 (findings)

From `ledger/task-36a-review.md` (file:line, scratch cases and evidence there). FIX_BASE = HEAD at dispatch. The task:
`task-36-brief.md` (36a half), report `task-36a-report.md`. Rules as that brief; report `ledger/task-36a-fix1-report.md`
(uncommitted).

- **I1** Steps still run outside every failpoint: the destination's window kills during an activation retry
  (`destination.ts` ~742, from `wakeSlot` and `watch`); the rest's SIGKILL escalation (`rest.ts` ~271); archiving a
  diverged root and the claim after it (`destination.ts` ~292-299, outside `destination.claim.root`). Put each under a
  named failpoint, and widen the fault world so the suite reaches them (an agent terminal whose activation retries, a
  job that ignores SIGTERM, a diverged root archived) — the review's scratch cases are the starting point.
- **I2** Leaks with defect 2's shape: the controller's `clear()` removes `handover.json` before `handover/<tx>/`, so a
  crash between leaves the manifest, landed and progress files forever; a freeze retried after a crash past its manifest
  write and then refused leaves `manifest-<tx>.json` (nothing in `refuse()` removes it); `supersede` has the same order.
  Remove what a transaction owns before the record that names it, everywhere; make the suite check every file a
  transaction writes is gone after it settles, not only `handover.json`.
- **M1** The outside-a-failpoint check stops watching a party after any step inside a failpoint throws, and watches only
  files matching a name pattern. Make it watch every durable write under the fleet and data homes for the whole run.
- **M2** Stub `fsyncSync` in the fault world (the review measured 145 s → 9.6 s) and crash at every hit of every step
  instead of only the first and last (the review ran it: 330 cases, all pass).
- **M3** A terminal restored after bug 1's crash window loses its launch flags on the resume path too
  (`rest.ts` ~340-343): keep the carried revive (F3's rule).
- **M4** `recover()` falls back to abort when status offers nothing; fail the test instead.

Test first: each item's case fails before its fix (I1's cases must first show "ran outside every failpoint" or the
missed crash; I2's the leftover files).
